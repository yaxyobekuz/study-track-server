/**
 * SERTIFIKAT REJALARI (`CertificatePlan`).
 *
 * "Kim qaysi sertifikatni qachon topshirmoqchi" — o'quvchining O'Z
 * deklaratsiyasi. Baho ham, imtihon natijasi ham EMAS.
 *
 * Qoida bitta jumlada:
 *
 * > Har (o'quvchi + yo'nalish) uchun BITTA faol reja. Formani ikki marta
 * > to'ldirsa OXIRGISI yutadi, eskisi esa `superseded` bo'lib registrda
 * > QOLADI — "nega muddat o'zgardi" degan savolga javob tarixda turadi.
 *
 * ⚠️ O'CHIRILMAYDI — BEKOR QILINADI, sabab + aktyor bilan (loyihaning
 * umumiy doktrinasi). Topshirgani esa `passed` bo'ladi va slotni BO'SHATADI:
 * IELTS ni topshirgan o'quvchi keyingi darajani rejalashtirishi kerak.
 *
 * ⚠️ RO'YXAT FAQAT JORIY O'QUVCHILARNI ko'rsatadi (`education.md` §4):
 * arxivlangani hech bir joriy ro'yxatda chiqmaydi. Rejasi esa o'chirilmaydi
 * — arxivdan qaytsa o'z holati bilan qaytadi.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError, ConflictError } = require("../utils/errors");
const { isValidId } = require("../utils/objectId");
const { buildNameSearchWhere } = require("../helpers/nameSearch.helpers");
const { getTashkentDateUtc, formatDateUz } = require("../helpers/date.helpers");
const { loadArchivedStudentScope } = require("./archivedStudentScope.service");
const {
  PLAN_STATUS,
  ACTIVE_STATUS,
  PLAN_SOURCE,
  planActiveKey,
  parseSheetDay,
  monthKeyOf,
  daysLeft,
  daysLeftLabel,
} = require("../helpers/certificate.helpers");
const progressService = require("./certificateProgress.service");

const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 200;

const NOTE_MAX = 500;
const REASON_MAX = 300;

/** Muddat chegarasi — bugundan necha yil oldin/keyin yozilishi mumkin. */
const DUE_YEARS_BACK = 5;
const DUE_YEARS_AHEAD = 10;

/** Sinf filtri: biriktirilmagan o'quvchilar. */
const NO_CLASS = "none";

/** Muddat filtri qiymatlari. */
const DUE_FILTERS = Object.freeze({
  OVERDUE: "overdue",
  UPCOMING: "upcoming",
  NONE: "none",
});

// Joriy (arxivlanmagan) o'quvchilar — har so'rovning asosi
const CURRENT_STUDENTS = Object.freeze({ role: "student", isArchived: false });

const classCollator = new Intl.Collator("uz", { numeric: true, sensitivity: "base" });

const PLAN_SELECT = {
  id: true,
  studentId: true,
  trackId: true,
  dueDate: true,
  status: true,
  submittedAt: true,
  note: true,
  source: true,
  sourceName: true,
  sourceGroup: true,
  passedAt: true,
  cancelledAt: true,
  cancelReason: true,
  supersededAt: true,
  createdAt: true,
  track: {
    select: {
      id: true,
      name: true,
      subjectId: true,
      isActive: true,
      subject: { select: { id: true, name: true } },
    },
  },
};

/* ─────────────────────────── kirish ─────────────────────────── */

const isBlank = (value) => value === undefined || value === null || value === "";

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseText(value, { max, field }) {
  if (isBlank(value)) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > max) throw new BadRequestError(`${field} ${max} belgidan oshmasligi kerak`);
  return text;
}

/**
 * Muddat — KUN aniqligida (`@db.Date`).
 *
 * ⚠️ O'TGAN SANA QABUL QILINADI va bu ataylab: ma'lumot shunday keldi
 * (o'quvchi formani kech to'ldirib, muddatni o'tib ketgan sana bilan
 * yozgan). Rad etilsa 153 qatorli faylning bir qismi import bo'lmay
 * qolardi; ekranda esa u "muddati o'tgan" bo'lib ko'rinadi va aynan shu
 * admin tuzatishi kerak bo'lgan holat.
 *
 * Chegara faqat AQLGA SIG'ARLILIK uchun: 2019 yoki 2099 — ochiq xato.
 */
function parseDueDate(value) {
  if (isBlank(value) || value === "none") return null;

  // `parseSheetDay` Date ni ham, matnni ham o'zi oladi (import bilan AYNI
  // o'qish: qo'lda kiritilgan "01.12.2026" fayldan kelgani kabi o'qiladi)
  const date = parseSheetDay(value);
  if (!date) throw new BadRequestError("Muddat sanasi noto'g'ri");

  const today = getTashkentDateUtc();
  const year = date.getUTCFullYear();
  const nowYear = today.getUTCFullYear();
  if (year < nowYear - DUE_YEARS_BACK || year > nowYear + DUE_YEARS_AHEAD) {
    throw new BadRequestError(
      `Muddat ${nowYear - DUE_YEARS_BACK}–${nowYear + DUE_YEARS_AHEAD} yillar orasida bo'lishi kerak`,
    );
  }

  return date;
}

async function assertStudent(studentId) {
  if (!isValidId(studentId)) throw new BadRequestError("O'quvchi tanlovi noto'g'ri");

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, role: true, isArchived: true, firstName: true, lastName: true },
  });
  if (!student || student.role !== "student") throw new NotFoundError("O'quvchi topilmadi");
  if (student.isArchived) {
    throw new BadRequestError("Arxivlangan o'quvchiga reja yozilmaydi");
  }
  return student;
}

async function assertTrack(trackId) {
  if (!isValidId(trackId)) throw new BadRequestError("Yo'nalish tanlovi noto'g'ri");

  const track = await prisma.certificateTrack.findUnique({
    where: { id: trackId },
    select: { id: true, name: true, isActive: true },
  });
  if (!track) throw new NotFoundError("Yo'nalish topilmadi");
  if (!track.isActive) throw new BadRequestError("Arxivlangan yo'nalishga reja yozilmaydi");
  return track;
}

/* ─────────────────────────── YOZUV YADROSI ─────────────────────────── */

/**
 * REJANI YOZADI — import ham, qo'lda kiritish ham SHU YERDAN o'tadi.
 *
 * ⚠️ IKKI DARAJALI IDEMPOTENTLIK:
 *   1. `(studentId, trackId, submittedAt)` — AYNI faylni ikki marta
 *      yuklash ikkinchi qator yozmaydi (forma timestamp'i tashqi kalit).
 *      Tekshiruv HOLATGA qaramaydi: keyin bekor qilingan qator ham qayta
 *      yozilmaydi, aks holda import admin qarorini orqaga qaytarardi.
 *   2. `activeKey` — har (o'quvchi + yo'nalish) uchun bitta faol reja.
 *
 * ⚠️ OXIRGI TOPSHIRISH YUTADI, lekin faqat U HAQIQATAN YANGIROQ bo'lsa:
 * eski timestamp bilan kelgan qator faol rejani ALMASHTIRMAYDI. Fayllar
 * aralash tartibda yuklanishi mumkin va "oxirgi yuklangan" bilan "oxirgi
 * to'ldirilgan" bir narsa emas.
 *
 * @param {object} tx - Prisma tranzaksiyasi
 * @param {object} input
 * @param {{actorId: string, supersede?: boolean}} options
 * @returns {Promise<{action: string, plan?: object, previous?: object}>}
 */
async function writePlanInTx(tx, input, { actorId, supersede = false }) {
  const {
    studentId,
    trackId,
    dueDate = null,
    submittedAt = null,
    note = null,
    source = PLAN_SOURCE.MANUAL,
    sourceName = null,
    sourceGroup = null,
  } = input;

  if (submittedAt) {
    const already = await tx.certificatePlan.findFirst({
      where: { studentId, trackId, submittedAt },
      select: { id: true, status: true },
    });
    if (already) return { action: "duplicate", plan: already };
  }

  const activeKey = planActiveKey(studentId, trackId);
  const current = await tx.certificatePlan.findUnique({
    where: { activeKey },
    select: { id: true, submittedAt: true, dueDate: true },
  });

  if (current) {
    if (!supersede) {
      throw new ConflictError(
        "Bu o'quvchida shu yo'nalishda faol reja bor — uni tahrirlang yoki bekor qiling",
      );
    }
    // Eski topshirish yangisini almashtirmaydi
    if (submittedAt && current.submittedAt && submittedAt <= current.submittedAt) {
      return { action: "older", plan: current };
    }

    const released = await tx.certificatePlan.updateMany({
      where: { id: current.id, status: ACTIVE_STATUS },
      data: {
        status: PLAN_STATUS.SUPERSEDED,
        activeKey: null,
        supersededAt: new Date(),
      },
    });
    // Compare-and-swap: oraliqda boshqa so'rov qatorni o'zgartirgan bo'lsa
    // yangi qator YOZILMAYDI — `activeKey` unikali baribir to'sardi, lekin
    // sabab aniq bo'lishi kerak.
    if (released.count !== 1) {
      throw new ConflictError("Reja hozir boshqa joyda o'zgartirildi — qayta urinib ko'ring");
    }
  }

  const plan = await tx.certificatePlan.create({
    data: {
      studentId,
      trackId,
      dueDate,
      submittedAt,
      note,
      source,
      sourceName,
      sourceGroup,
      status: ACTIVE_STATUS,
      activeKey,
      createdBy: actorId,
    },
    select: PLAN_SELECT,
  });

  return { action: current ? "replaced" : "created", plan, previous: current ?? null };
}

/* ─────────────────────────── qo'lda kiritish ─────────────────────────── */

async function createPlan({ studentId, trackId, dueDate, note }, { actorId }) {
  const student = await assertStudent(studentId);
  const track = await assertTrack(trackId);
  const due = parseDueDate(dueDate);
  const cleanNote = parseText(note, { max: NOTE_MAX, field: "Izoh" });

  const result = await prisma.$transaction((tx) =>
    writePlanInTx(
      tx,
      {
        studentId: student.id,
        trackId: track.id,
        dueDate: due,
        note: cleanNote,
        source: PLAN_SOURCE.MANUAL,
      },
      { actorId, supersede: false },
    ),
  );

  return readPlan(result.plan.id, { actorId });
}

/**
 * Muddat va izohni tahrirlash.
 *
 * ⚠️ YO'NALISH O'ZGARMAYDI: boshqa yo'nalish — BOSHQA reja. Uni
 * o'zgartirish `activeKey` ni ko'chirib, "o'quvchi IELTS ni rejalashtirgan
 * edi" degan faktni izsiz yo'q qilardi. Xato kiritilgan reja bekor
 * qilinadi va yangisi yoziladi (sabab bilan).
 */
async function updatePlan(id, { dueDate, note }, { actorId }) {
  const plan = await prisma.certificatePlan.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!plan) throw new NotFoundError("Reja topilmadi");
  if (plan.status !== ACTIVE_STATUS) {
    throw new BadRequestError("Faqat faol rejani tahrirlash mumkin");
  }

  const data = {};
  if (dueDate !== undefined) data.dueDate = parseDueDate(dueDate);
  if (note !== undefined) data.note = parseText(note, { max: NOTE_MAX, field: "Izoh" });

  if (Object.keys(data).length > 0) {
    await prisma.certificatePlan.update({ where: { id }, data });
  }

  return readPlan(id, { actorId });
}

/** BEKOR QILISH — sabab MAJBURIY, qator registrda qoladi. */
async function cancelPlan(id, { reason }, { actorId }) {
  const cleanReason = parseText(reason, { max: REASON_MAX, field: "Sabab" });
  if (!cleanReason) throw new BadRequestError("Bekor qilish sababi kiritilishi shart");

  const updated = await prisma.certificatePlan.updateMany({
    where: { id, status: ACTIVE_STATUS },
    data: {
      status: PLAN_STATUS.CANCELLED,
      activeKey: null,
      cancelledAt: new Date(),
      cancelledBy: actorId,
      cancelReason: cleanReason,
    },
  });

  if (updated.count !== 1) {
    const exists = await prisma.certificatePlan.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!exists) throw new NotFoundError("Reja topilmadi");
    throw new ConflictError("Faqat faol rejani bekor qilish mumkin");
  }

  return readPlan(id, { actorId });
}

/**
 * TOPSHIRDI deb belgilash.
 *
 * ⚠️ `activeKey` BO'SHAYDI: topshirgan o'quvchi keyingi darajani
 * rejalashtirishi mumkin bo'lishi kerak (IELTS har yili qayta
 * topshiriladi). Fakt esa registrda `passed` bo'lib qoladi.
 */
async function markPassed(id, { actorId }) {
  const updated = await prisma.certificatePlan.updateMany({
    where: { id, status: ACTIVE_STATUS },
    data: {
      status: PLAN_STATUS.PASSED,
      activeKey: null,
      passedAt: new Date(),
      passedBy: actorId,
    },
  });

  if (updated.count !== 1) {
    const exists = await prisma.certificatePlan.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!exists) throw new NotFoundError("Reja topilmadi");
    throw new ConflictError("Faqat faol rejani 'topshirdi' deb belgilash mumkin");
  }

  return readPlan(id, { actorId });
}

/* ─────────────────────────── ro'yxat ─────────────────────────── */

/** Muddat filtri → Prisma sharti. Bugun — "o'tgan" EMAS. */
function dueWhere(filter, today) {
  if (filter === DUE_FILTERS.OVERDUE) return { dueDate: { lt: today } };
  if (filter === DUE_FILTERS.UPCOMING) return { dueDate: { gte: today } };
  if (filter === DUE_FILTERS.NONE) return { dueDate: null };
  return null;
}

/** "YYYY-MM" → o'sha oyning chegaralari. */
function monthWhere(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;

  return {
    dueDate: {
      gte: new Date(Date.UTC(year, month - 1, 1)),
      lt: new Date(Date.UTC(year, month, 1)),
    },
  };
}

const sortClasses = (classes) =>
  [...classes].sort((a, b) => classCollator.compare(a.name || "", b.name || ""));

/**
 * ADMIN RO'YXATI — reja kesimida (bitta qator = bitta sertifikat rejasi).
 *
 * ⚠️ SAHIFALASH REJA bo'yicha, o'quvchi bo'yicha EMAS: bir o'quvchida
 * bir nechta reja bo'ladi va "50 o'quvchi" deb sahifalansa, sahifada
 * necha qator chiqishi oldindan bilinmasdi.
 *
 * ⚠️ Qidiruv va filtrlar SQL darajasida — xotirada filtrlangan ro'yxat
 * sahifalashdan keyin "topilmadi" deb yolg'on gapirardi (`devices.md` §10).
 *
 * @param {object} query
 * @param {{actorId: string, withProgress?: boolean}} options
 */
async function listPlans(query = {}, { actorId, withProgress = true } = {}) {
  const page = parsePositiveInt(query.page, 1);
  const limit = Math.min(parsePositiveInt(query.limit, PAGE_LIMIT_DEFAULT), PAGE_LIMIT_MAX);

  const today = getTashkentDateUtc();

  // ⚠️ O'QUVCHI DOIRASI IKKI YO'L BILAN — `CertificatePlan.studentId` soft
  // ref (FK yo'q), ya'ni `User` bo'yicha nested filtr yozib bo'lmaydi
  // (`devices.md` §10 dagi AYNI ikki qadam).
  //
  //   filtr BOR  → mos o'quvchilar topiladi va `studentId IN (...)`
  //   filtr YO'Q → faqat ARXIVLANGANLAR chiqariladi (`notIn`)
  //
  // Ikkinchi yo'l ataylab: butun maktab o'quvchisining id si `IN` ro'yxati
  // bo'lib so'rovga tushsa, ming o'quvchili filialda so'rov o'zi
  // ma'lumotdan kattaroq bo'lib ketardi. Arxivlanganlar esa doim kam.
  const studentWhere = { ...CURRENT_STUDENTS };
  const search = buildNameSearchWhere(query.search);
  if (search) Object.assign(studentWhere, search);

  const hasClassFilter = !isBlank(query.classId) && query.classId !== "all";
  if (hasClassFilter) {
    if (query.classId === NO_CLASS) studentWhere.classes = { none: {} };
    else if (isValidId(query.classId)) {
      studentWhere.classes = { some: { classId: query.classId } };
    } else throw new BadRequestError("Sinf tanlovi noto'g'ri");
  }

  const narrowed = Boolean(search) || hasClassFilter;

  const where = narrowed
    ? {
        studentId: {
          in: (
            await prisma.user.findMany({ where: studentWhere, select: { id: true } })
          ).map((s) => s.id),
        },
      }
    : await loadArchivedStudentScope();

  const status = String(query.status ?? "").trim();
  if (status && status !== "all") {
    if (!Object.values(PLAN_STATUS).includes(status)) {
      throw new BadRequestError("Holat filtri noto'g'ri");
    }
    where.status = status;
  } else {
    where.status = ACTIVE_STATUS;
  }

  if (!isBlank(query.trackId) && query.trackId !== "all") {
    if (!isValidId(query.trackId)) throw new BadRequestError("Yo'nalish tanlovi noto'g'ri");
    where.trackId = query.trackId;
  }

  // ⚠️ Muddat filtri va oy filtri KESISHTIRILADI, biri ikkinchisini
  // ustidan yozmaydi: "dekabr" + "muddati o'tgan" tanlansa natija ikkala
  // shartga ham mos kelishi kerak.
  const due = dueWhere(query.due, today);
  const month = monthWhere(query.month);
  const dueConditions = [due, month].filter(Boolean);
  if (dueConditions.length === 1) Object.assign(where, dueConditions[0]);
  else if (dueConditions.length > 1) where.AND = dueConditions;

  const [total, rows] = await Promise.all([
    prisma.certificatePlan.count({ where }),
    prisma.certificatePlan.findMany({
      where,
      select: PLAN_SELECT,
      // Muddati yo'qlar OXIRIDA: ekranning boshida harakat talab qiladigan
      // (muddati yaqin) qatorlar turishi kerak.
      orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  // Sahifadagi qatorlarning o'quvchilari — faqat SHU id lar bo'yicha
  const pageStudents = await prisma.user.findMany({
    where: { id: { in: [...new Set(rows.map((plan) => plan.studentId))] } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      username: true,
      classes: { select: { class: { select: { id: true, name: true } } } },
    },
  });
  const studentById = new Map(pageStudents.map((s) => [s.id, s]));

  const progress = withProgress
    ? await progressService.loadProgressForPlans(rows, { actorId, ensure: true })
    : new Map();

  const data = rows.map((plan) =>
    shapePlan(plan, {
      student: studentById.get(plan.studentId),
      progress: progress.get(progressService.progressKey(plan.studentId, plan.track?.subjectId)),
      today,
      includeSubmitted: true,
    }),
  );

  return { data, total, page, limit };
}

/**
 * Javob shakli.
 *
 * ⚠️ `includeSubmitted: false` — O'QUVCHI yo'li. Forma to'ldirilgan vaqt
 * unga KO'RINMAYDI (biznes talabi): kerakli narsa — muddat, topshirish
 * vaqti emas. Maydon shu sababdan javobdan BUTUNLAY olib tashlanadi,
 * frontendda yashirilmaydi — yashirilgan maydon API javobida baribir
 * ko'rinib turardi.
 */
function shapePlan(plan, { student, progress, today, includeSubmitted }) {
  const classes = student ? sortClasses(student.classes.map((uc) => uc.class)) : [];

  return {
    id: plan.id,
    status: plan.status,
    track: {
      id: plan.track?.id ?? plan.trackId,
      name: plan.track?.name ?? null,
      subject: plan.track?.subject ?? null,
    },
    student: student
      ? {
          id: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
          fullName: `${student.lastName ?? ""} ${student.firstName ?? ""}`.trim(),
          username: student.username,
          classes,
        }
      : null,
    dueDate: plan.dueDate,
    dueDateLabel: formatDateUz(plan.dueDate, { utc: true }),
    dueMonth: monthKeyOf(plan.dueDate),
    daysLeft: daysLeft(plan.dueDate, today),
    // Matn SERVERDA: admin va o'quvchi ekranida bir xil bo'lishi kerak
    daysLeftLabel: daysLeftLabel(daysLeft(plan.dueDate, today)),
    note: plan.note,
    progress: progress ?? null,
    ...(includeSubmitted && {
      submittedAt: plan.submittedAt,
      source: plan.source,
      sourceName: plan.sourceName,
      sourceGroup: plan.sourceGroup,
    }),
    ...(plan.status === PLAN_STATUS.CANCELLED && {
      cancelledAt: plan.cancelledAt,
      cancelReason: plan.cancelReason,
    }),
    ...(plan.status === PLAN_STATUS.PASSED && { passedAt: plan.passedAt }),
    ...(plan.status === PLAN_STATUS.SUPERSEDED && { supersededAt: plan.supersededAt }),
  };
}

/**
 * BITTA REJANI RO'YXAT BILAN AYNI SHAKLDA O'QIYDI.
 *
 * ⚠️ HAR YOZISH AMALI shu yerdan qaytadi (yaratish, tahrirlash, bekor
 * qilish, "topshirdi"). Ilgari ular Prisma qatorining O'ZINI qaytarardi va
 * javobda `student`, `dueDateLabel`, `daysLeft`, `progress` YO'Q edi: panel
 * ro'yxatdan bir shaklni, yozuvdan boshqasini olardi. Ekran buni
 * sezmaydi (u ro'yxatni qayta so'raydi), lekin kontrakt ikkiga bo'linib
 * turardi va javobga ishongan keyingi kod jim buzilardi.
 *
 * ⚠️ `ensure: false` — mavzu ankorini YOZISH yo'lida yaratmaydi: reja
 * saqlash amali ta'lim domeniga qator qo'shmasligi kerak.
 *
 * @param {string} id
 * @param {{actorId: string}} options
 * @returns {Promise<object|null>}
 */
async function readPlan(id, { actorId }) {
  const plan = await prisma.certificatePlan.findUnique({
    where: { id },
    select: PLAN_SELECT,
  });
  if (!plan) return null;

  const [student, progress] = await Promise.all([
    prisma.user.findUnique({
      where: { id: plan.studentId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        username: true,
        classes: { select: { class: { select: { id: true, name: true } } } },
      },
    }),
    progressService.loadProgressForPlans([plan], { actorId, ensure: false }),
  ]);

  return shapePlan(plan, {
    student,
    progress: progress.get(progressService.progressKey(plan.studentId, plan.track?.subjectId)),
    today: getTashkentDateUtc(),
    includeSubmitted: true,
  });
}

/**
 * O'QUVCHINI QIDIRIB TANLASH (import ko'rib chiqishi va "Reja qo'shish").
 *
 * ⚠️ MODULNING O'Z YO'LI, `GET /users/students` EMAS: u `users.view` talab
 * qiladi, ya'ni sertifikat rejasini kiritadigan xodimga butun
 * foydalanuvchilar bo'limini ochib berish kerak bo'lardi. Bu yerda ruxsat
 * `certificates.manage` va javobda faqat tanlash uchun kerak bo'lgan
 * maydonlar bor.
 *
 * ⚠️ Faqat JORIY o'quvchilar (`education.md` §4) va `isActive`
 * FILTRLANMAYDI: logini o'chirilgan o'quvchi ham o'qishda davom etadi.
 *
 * @param {{search?: string, classId?: string, limit?: number}} query
 */
async function searchStudents(query = {}) {
  const limit = Math.min(parsePositiveInt(query.limit, 50), 100);

  const where = { ...CURRENT_STUDENTS };
  const search = buildNameSearchWhere(query.search);
  if (search) Object.assign(where, search);

  if (!isBlank(query.classId) && query.classId !== "all") {
    if (query.classId === NO_CLASS) where.classes = { none: {} };
    else if (isValidId(query.classId)) where.classes = { some: { classId: query.classId } };
    else throw new BadRequestError("Sinf tanlovi noto'g'ri");
  }

  const students = await prisma.user.findMany({
    where,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      username: true,
      classes: { select: { class: { select: { id: true, name: true } } } },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: limit,
  });

  return students.map((student) => ({
    id: student.id,
    fullName: `${student.lastName ?? ""} ${student.firstName ?? ""}`.trim(),
    username: student.username,
    classNames: sortClasses(student.classes.map((uc) => uc.class)).map((cls) => cls.name),
  }));
}

/**
 * BITTA O'QUVCHINING REJALARI.
 *
 * Ikki chaqiruvchi bor va ular BITTA funksiyadan o'qiydi: admin (o'quvchi
 * kartasi) va o'quvchining O'ZI (`/certificates/my`). Farq faqat
 * `includeSubmitted` da — ikkita alohida funksiya bo'lsa, biriga qo'shilgan
 * maydon ikkinchisida tushib qolardi.
 *
 * @param {string} studentId
 * @param {{actorId: string, forStudent?: boolean, includeHistory?: boolean}} options
 */
async function getStudentPlans(studentId, { actorId, forStudent = false, includeHistory = false }) {
  if (!isValidId(studentId)) throw new BadRequestError("O'quvchi tanlovi noto'g'ri");

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      username: true,
      role: true,
      classes: { select: { class: { select: { id: true, name: true } } } },
    },
  });
  if (!student || student.role !== "student") throw new NotFoundError("O'quvchi topilmadi");

  const where = { studentId };
  if (!includeHistory) {
    where.status = { in: [ACTIVE_STATUS, PLAN_STATUS.PASSED] };
  }

  const rows = await prisma.certificatePlan.findMany({
    where,
    select: PLAN_SELECT,
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
  });

  // ⚠️ `ensure: false` o'quvchi yo'lida: progress o'qish amali va u ta'lim
  // domeniga qator yozmasligi kerak (`lessonTopic.service.js` izohi).
  const progress = await progressService.loadProgressForPlans(rows, {
    actorId,
    ensure: !forStudent,
  });

  const today = getTashkentDateUtc();

  return {
    student: {
      id: student.id,
      fullName: `${student.lastName ?? ""} ${student.firstName ?? ""}`.trim(),
      classes: sortClasses(student.classes.map((uc) => uc.class)),
    },
    plans: rows.map((plan) =>
      shapePlan(plan, {
        student,
        progress: progress.get(progressService.progressKey(plan.studentId, plan.track?.subjectId)),
        today,
        includeSubmitted: !forStudent,
      }),
    ),
  };
}

module.exports = {
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  NOTE_MAX,
  REASON_MAX,
  DUE_FILTERS,
  PLAN_SELECT,
  parseDueDate,
  writePlanInTx,
  readPlan,
  createPlan,
  updatePlan,
  cancelPlan,
  markPassed,
  listPlans,
  searchStudents,
  getStudentPlans,
  shapePlan,
};
