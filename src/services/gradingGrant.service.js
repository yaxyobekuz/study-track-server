/**
 * FANGA BAHO QO'YISH RUXSATI (`GradingGrant`).
 *
 * Boshliq (`gradeGrants.manage`) o'qituvchiga O'ZINIKI BO'LMAGAN sinf + fan
 * darslariga baho qo'yishni ochadi. Tipik holat: ingliz tili sertifikati
 * bor o'quvchini ona tili o'qituvchisi tayyorlaydi — boshliq unga
 * "11-A · Ingliz tili" ga ruxsat beradi va u ingliz tili darsida shu
 * o'quvchiga baho qo'yadi. Baho ingliz tili bahosi bo'lib hisoblanadi.
 *
 * Ikki shakl:
 *   · MUDDAT (`period`) — davr ichidagi shu sinf+fanning HAMMA darslari:
 *     1 hafta / 1 oy / 1 yil yoki qo'lda sana (ko'pi bilan 1 yil);
 *   · BITTA DARS (`lesson`) — aynan bir kundagi bitta dars (sana + tartib).
 *
 * ⚠️ QO'SHIMCHA HUQUQ, KO'CHIRISH EMAS: dars egasi o'z darsiga baho
 * qo'yishda davom etadi. "Kim kimning o'rniga dars o'tadi" — boshqa
 * mexanizm (`LessonSubstitution`), u pulni ham ko'chiradi.
 *
 * ⚠️ PULGA TA'SIR QILMAYDI: ruxsat bilan qo'yilgan baho
 * (`Grade.gradingGrantId`) dars egasining darsini oylikda "o'tilgan"
 * qilmaydi va "Men ketdim" darvozasida uning ishi hisoblanmaydi
 * (`lessonHours.service.js` → `loadLessonFacts`, `checkoutGate.service.js`).
 * Aks holda boshqa odamning bahosi bilan dars egasiga soat yozilardi.
 *
 * ⚠️ KUN QOIDALARI O'ZGARMAYDI: ruxsat faqat QAYSI darsga baho qo'yish
 * mumkinligini hal qiladi. Bugungi darsga — maktabda turib, o'tgan kunga —
 * faqat `GradingUnlock` ochgan bo'lsa (`grade.controller.js`). Shu sabab
 * ruxsat o'tgan kundan boshlanmaydi.
 *
 * ⚠️ O'CHIRILMAYDI — YOPILADI (`revokedAt` + aktyor + sabab): shu ruxsat
 * bilan qo'yilgan baholar unga ishora qiladi. Yopilgach yangi baho ham,
 * mavjudini o'zgartirish ham yopiladi, qo'yilgan baholar o'z kuchida qoladi.
 */

const prisma = require("../config/prisma");
const { ROLES, DAYS_UZ } = require("../utils/constants");
const { hasRole } = require("../utils/permissions");
const { BadRequestError, NotFoundError, ConflictError } = require("../utils/errors");
const { currentDayDate, parseDayDate } = require("../helpers/month.helpers");
const { formatDateUz, formatDateTimeUz, formatDateRangeUz } = require("../helpers/date.helpers");
const { dayKey } = require("../helpers/lessonHours");
const { scheduleDayOf } = require("../helpers/teacherAccess");
const { buildHolidaySet } = require("./holiday.service");
const { getScheduleSettings } = require("./settings.service");

const DAY_MS = 24 * 3600 * 1000;
const REASON_MAX = 200;
/** Bitta ruxsat eng ko'pi bilan 1 yil (kabisa yili — 366 kun). */
const MAX_RANGE_DAYS = 366;
/** Darsning eng katta tartib raqami — xato kiritilgan son jadvalga tushmasin. */
const MAX_LESSON_ORDER = 20;
const MODES = ["period", "lesson"];
const PRESETS = ["1w", "1m", "1y", "custom"];
const STATUSES = ["active", "upcoming", "expired", "revoked"];
const OBJECT_ID = /^[a-f\d]{24}$/i;

const STATUS_LABELS = {
  active: "Amalda",
  upcoming: "Kutilmoqda",
  expired: "Muddati tugagan",
  revoked: "Yopilgan",
};

const fullName = (person) =>
  person ? `${person.firstName ?? ""} ${person.lastName ?? ""}`.trim() || "Noma'lum" : "Noma'lum";

/** Sinf nomlari "5-A" < "10-A" tartibida (matn tartibi "10" ni oldinga qo'yardi). */
const byClassName = (a, b) => a.name.localeCompare(b.name, "uz", { numeric: true });

const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);

/**
 * VAQT HOLATI — `revokedAt` QAROR, qolgani sana.
 *
 * @param {{revokedAt: Date|null, dateFrom: Date, dateTo: Date}} row
 * @param {Date} today - Toshkent kuni (UTC yarim tun)
 */
const statusOf = (row, today) => {
  if (row.revokedAt) return "revoked";
  if (row.dateTo.getTime() < today.getTime()) return "expired";
  if (row.dateFrom.getTime() > today.getTime()) return "upcoming";
  return "active";
};

/** Holat filtri → Prisma sharti (`statusOf` bilan AYNI qoida). */
const statusWhere = (status, today) => {
  if (status === "active") return { revokedAt: null, dateFrom: { lte: today }, dateTo: { gte: today } };
  if (status === "upcoming") return { revokedAt: null, dateFrom: { gt: today } };
  if (status === "expired") return { revokedAt: null, dateTo: { lt: today } };
  if (status === "revoked") return { revokedAt: { not: null } };
  return {};
};

/** "30-sentabr, 2026 — 29-oktabr, 2026" yoki bitta kun bo'lsa "30-sentabr, 2026". */
const rangeLabelOf = (from, to) =>
  from.getTime() === to.getTime()
    ? formatDateUz(from, { utc: true })
    : formatDateRangeUz(from, to, { utc: true });

/**
 * Qator → API shakli.
 *
 * ⚠️ Ismlar JONLI (xodim/sinf qayta nomlansa yangi nom), topilmasa —
 * yozilgan paytdagi `snapshot` dan.
 *
 * @param {object} row
 * @param {object} refs - { users: Map, classes: Map, subjects: Map }
 * @param {Date} today
 */
const serialize = (row, refs, today) => {
  const status = statusOf(row, today);
  const isLesson = row.lessonOrder != null;

  return {
    id: row.id,
    teacherId: row.teacherId,
    teacherName: refs.users.get(row.teacherId) ?? row.snapshot?.teacherName ?? "Noma'lum",
    classId: row.classId,
    className: refs.classes.get(row.classId) ?? row.snapshot?.className ?? "Noma'lum",
    subjectId: row.subjectId,
    subjectName: refs.subjects.get(row.subjectId) ?? row.snapshot?.subjectName ?? "Noma'lum",
    mode: isLesson ? "lesson" : "period",
    lessonOrder: row.lessonOrder,
    scopeLabel: isLesson ? `${row.lessonOrder}-dars` : "Barcha darslar",
    // ⚠️ `@db.Date` — kalit ham, matn ham `getUTC*` bilan (`dates.md` §4)
    dateFrom: dayKey(row.dateFrom),
    dateTo: dayKey(row.dateTo),
    rangeLabel: rangeLabelOf(row.dateFrom, row.dateTo),
    dayName: isLesson ? capitalize(DAYS_UZ[row.dateFrom.getUTCDay()]) : null,
    dayCount: Math.round((row.dateTo.getTime() - row.dateFrom.getTime()) / DAY_MS) + 1,
    reason: row.reason,
    status,
    statusLabel: STATUS_LABELS[status],
    grantedByName: refs.users.get(row.grantedBy) ?? "Noma'lum",
    createdAtLabel: formatDateTimeUz(row.createdAt),
    revokedAtLabel: row.revokedAt ? formatDateTimeUz(row.revokedAt) : null,
    revokedByName: row.revokedBy ? refs.users.get(row.revokedBy) ?? "Noma'lum" : null,
    revokeReason: row.revokeReason || null,
  };
};

/** Qatorlar uchun ismlar (soft ref'lar qo'lda yuklanadi). */
const loadRefs = async (rows) => {
  const userIds = [...new Set(rows.flatMap((r) => [r.teacherId, r.grantedBy, r.revokedBy]).filter(Boolean))];
  const classIds = [...new Set(rows.map((r) => r.classId))];
  const subjectIds = [...new Set(rows.map((r) => r.subjectId))];

  const [users, classes, subjects] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [],
    classIds.length
      ? prisma.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } })
      : [],
    subjectIds.length
      ? prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } })
      : [],
  ]);

  return {
    users: new Map(users.map((u) => [u.id, fullName(u)])),
    classes: new Map(classes.map((c) => [c.id, c.name])),
    subjects: new Map(subjects.map((s) => [s.id, s.name])),
  };
};

/* ─────────────────────── TEKSHIRUVLAR ─────────────────────── */

/**
 * Muddat preseti → oxirgi kun (INKLYUZIV).
 *
 *   · "1w" — 7 kun (bugun + 6);
 *   · "1m" — keyingi oyning shu kunidan bir kun oldin (30-sentabr → 29-oktabr);
 *   · "1y" — keyingi yilning shu kunidan bir kun oldin.
 *
 * `Date.UTC` oy/kun toshishini o'zi to'g'rilaydi (31-yanvar + 1 oy → mart boshi).
 */
const presetEnd = (from, preset) => {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();
  if (preset === "1w") return new Date(from.getTime() + 6 * DAY_MS);
  if (preset === "1m") return new Date(Date.UTC(y, m + 1, d - 1));
  return new Date(Date.UTC(y + 1, m, d - 1)); // "1y"
};

/**
 * Ruxsat davrini o'qiydi va tekshiradi.
 *
 * ⚠️ O'TGAN KUNDAN BOSHLANMAYDI: o'tgan kunga baho qo'yish o'z mexanizmi
 * bilan ochiladi (`GradingUnlock`). Bu yerda ruxsat berilsa ham, o'sha kun
 * ochilmaguncha baho baribir qo'yilmasdi — ruxsat ishlamayotgandek
 * ko'rinardi.
 *
 * @param {object} data - { mode, dateFrom, preset, dateTo } | { mode: "lesson", date, lessonOrder }
 * @param {Date} [today]
 * @returns {{mode: string, from: Date, to: Date, lessonOrder: number|null}}
 */
function parseWindow(data = {}, today = currentDayDate()) {
  const mode = data.mode ?? "period";
  if (!MODES.includes(mode)) throw new BadRequestError("Ruxsat turini tanlang: muddat bilan yoki bitta dars");

  const assertNotPast = (date) => {
    if (date.getTime() < today.getTime()) {
      throw new BadRequestError(
        "O'tgan kunga ruxsat berib bo'lmaydi — o'tgan kunlar \"Baho qo'yishni ochish\" orqali ochiladi",
      );
    }
  };

  if (mode === "lesson") {
    const date = parseDayDate(data.date, "Dars sanasi");
    assertNotPast(date);

    const lessonOrder = Number(data.lessonOrder);
    if (!Number.isInteger(lessonOrder) || lessonOrder < 1 || lessonOrder > MAX_LESSON_ORDER) {
      throw new BadRequestError("Darsni tanlang");
    }

    return { mode, from: date, to: date, lessonOrder };
  }

  const from = data.dateFrom ? parseDayDate(data.dateFrom, "Qaysi kundan") : today;
  assertNotPast(from);

  if (!PRESETS.includes(data.preset)) throw new BadRequestError("Muddatni tanlang");

  const to = data.preset === "custom" ? parseDayDate(data.dateTo, "Qaysi kungacha") : presetEnd(from, data.preset);
  if (to.getTime() < from.getTime()) {
    throw new BadRequestError("Oraliq noto'g'ri: oxirgi kun boshlanishidan oldin");
  }

  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new BadRequestError(`Ruxsat 1 yildan oshmasin (tanlangani ${days} kun)`);
  }

  return { mode, from, to, lessonOrder: null };
}

/**
 * Ruxsat oluvchi — faqat O'QITUVCHI (asosiy yoki qo'shimcha rol).
 *
 * ⚠️ Rolsiz xodimga ruxsat BERILMAYDI: baho qo'yish darvozasi
 * (`createGrade`) o'qituvchi rolini talab qiladi — ruxsat yozilib, baho
 * baribir qo'yilmasa, u "ishlamayapti" bo'lib ko'rinardi.
 */
async function assertGrantee(teacherId) {
  if (!teacherId || !OBJECT_ID.test(String(teacherId))) {
    throw new BadRequestError("O'qituvchini tanlang");
  }

  const user = await prisma.user.findUnique({
    where: { id: String(teacherId) },
    select: { id: true, firstName: true, lastName: true, role: true, extraRoles: true, isArchived: true },
  });

  if (!user || user.role === ROLES.STUDENT) throw new NotFoundError("O'qituvchi topilmadi");
  if (user.isArchived) throw new BadRequestError(`${fullName(user)} arxivlangan`);
  if (!hasRole(user, ROLES.TEACHER)) {
    throw new BadRequestError(`${fullName(user)} o'qituvchi rolida emas — baho faqat o'qituvchi qo'ya oladi`);
  }

  return user;
}

/** Sinf va fan — mavjud, sinf faol. */
async function loadClassAndSubject(classId, subjectId) {
  if (!classId || !OBJECT_ID.test(String(classId))) throw new BadRequestError("Sinfni tanlang");
  if (!subjectId || !OBJECT_ID.test(String(subjectId))) throw new BadRequestError("Fanni tanlang");

  const [klass, subject] = await Promise.all([
    prisma.class.findUnique({ where: { id: String(classId) }, select: { id: true, name: true, isActive: true } }),
    prisma.subject.findUnique({ where: { id: String(subjectId) }, select: { id: true, name: true } }),
  ]);

  if (!klass) throw new NotFoundError("Sinf topilmadi");
  if (!klass.isActive) throw new BadRequestError(`${klass.name} sinfi faol emas`);
  if (!subject) throw new NotFoundError("Fan topilmadi");

  return { klass, subject };
}

/**
 * Davr ichida ruxsat ochadigan darslar soni — "necha dars ochildi" degan
 * savolga javob. Yakshanba va bayram kunlari chiqariladi; ruxsat oluvchining
 * O'Z darslari sanalmaydi (ular ruxsatsiz ham ochiq).
 */
function countOpenedLessons(cells, window, teacherId, holidaySet) {
  const perDay = new Map();
  for (const cell of cells) {
    if (cell.teacherId === teacherId) continue;
    if (window.lessonOrder != null && cell.order !== window.lessonOrder) continue;
    perDay.set(cell.day, (perDay.get(cell.day) ?? 0) + 1);
  }

  let total = 0;
  for (let t = window.from.getTime(); t <= window.to.getTime(); t += DAY_MS) {
    const date = new Date(t);
    if (holidaySet.has(dayKey(date))) continue;
    total += perDay.get(scheduleDayOf(date)) ?? 0;
  }
  return total;
}

/* ─────────────────────── AMALLAR ─────────────────────── */

/**
 * RUXSAT BERISH.
 *
 * @param {object} data - { teacherId, classId, subjectId, mode, dateFrom,
 *   preset, dateTo, date, lessonOrder, reason }
 * @param {string} actorId
 */
async function createGrant(data = {}, actorId) {
  const today = currentDayDate();
  const window = parseWindow(data, today);
  const [teacher, { klass, subject }] = await Promise.all([
    assertGrantee(data.teacherId),
    loadClassAndSubject(data.classId, data.subjectId),
  ]);
  const reason = typeof data.reason === "string" ? data.reason.trim().slice(0, REASON_MAX) : "";
  const teacherName = fullName(teacher);

  // Sinf jadvalidagi shu fan darslari — ruxsat AYNAN shularni ochadi
  const lessons = await prisma.scheduleLesson.findMany({
    where: { subjectId: subject.id, schedule: { classId: klass.id } },
    select: { order: true, teacherId: true, schedule: { select: { day: true } } },
  });
  const cells = lessons.map((l) => ({ day: l.schedule.day, order: l.order, teacherId: l.teacherId }));

  if (cells.length === 0) {
    throw new BadRequestError(
      `${klass.name} sinf jadvalida ${subject.name} darsi yo'q — ruxsat hech qaysi darsni ochmaydi`,
    );
  }

  if (window.mode === "lesson") {
    const dateLabel = formatDateUz(window.from, { utc: true });
    const day = scheduleDayOf(window.from);
    if (!day) throw new BadRequestError(`${dateLabel} — yakshanba, dars yo'q`);

    const cell = cells.find((c) => c.day === day && c.order === window.lessonOrder);
    if (!cell) {
      throw new BadRequestError(
        `${dateLabel} (${day}) ${klass.name} jadvalida ${window.lessonOrder}-dars ${subject.name} emas`,
      );
    }
    if (cell.teacherId === teacher.id) {
      throw new BadRequestError(`Bu dars ${teacherName}ning o'z darsi — ruxsat kerak emas`);
    }
  } else if (cells.every((c) => c.teacherId === teacher.id)) {
    throw new BadRequestError(
      `${klass.name} · ${subject.name} darslarining hammasi ${teacherName}ning o'zida — ruxsat kerak emas`,
    );
  }

  const holidaySet = await buildHolidaySet(window.from, window.to);
  const openedLessons = countOpenedLessons(cells, window, teacher.id, holidaySet);

  if (window.mode === "lesson" && openedLessons === 0) {
    throw new BadRequestError(`${formatDateUz(window.from, { utc: true })} — dam olish kuni, dars yo'q`);
  }

  const row = await prisma.$transaction(async (tx) => {
    // ⚠️ Bir xil (o'qituvchi, sinf, fan) uchun parallel ikki so'rov bir-birining
    // takrorini ko'rmay qolmasligi uchun — tekshiruv va yozuv qulf ICHIDA.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`grading_grant:${teacher.id}:${klass.id}:${subject.id}`}))`;

    // TAKROR — yangi ruxsatni TO'LIQ qamrab olgan amaldagi ruxsat. Qisman
    // kesishganiga ruxsat bor: ular birlashadi (huquq qo'shiladi, ikki
    // marta hisoblanadigan narsa yo'q).
    const covering = await tx.gradingGrant.findFirst({
      where: {
        teacherId: teacher.id,
        classId: klass.id,
        subjectId: subject.id,
        revokedAt: null,
        dateFrom: { lte: window.from },
        dateTo: { gte: window.to },
        OR: [{ lessonOrder: null }, ...(window.lessonOrder != null ? [{ lessonOrder: window.lessonOrder }] : [])],
      },
    });
    if (covering) {
      throw new ConflictError(
        `${teacherName} uchun ${klass.name} · ${subject.name} bo'yicha ` +
          `${rangeLabelOf(covering.dateFrom, covering.dateTo)} ruxsati allaqachon bor`,
      );
    }

    return tx.gradingGrant.create({
      data: {
        teacherId: teacher.id,
        classId: klass.id,
        subjectId: subject.id,
        dateFrom: window.from,
        dateTo: window.to,
        lessonOrder: window.lessonOrder,
        reason,
        snapshot: { teacherName, className: klass.name, subjectName: subject.name },
        grantedBy: actorId,
      },
    });
  });

  const refs = await loadRefs([row]);
  return { ...serialize(row, refs, today), openedLessons };
}

/**
 * RUXSATNI YOPISH — muddatidan oldin (yoki boshlanmasidan oldin).
 * Qo'yilgan baholar o'z kuchida qoladi.
 *
 * @param {string} id
 * @param {object} data - { reason }
 * @param {string} actorId
 */
async function revokeGrant(id, data = {}, actorId) {
  const today = currentDayDate();
  const row = await prisma.gradingGrant.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Ruxsat topilmadi");

  const status = statusOf(row, today);
  if (status === "revoked") throw new BadRequestError("Ruxsat allaqachon yopilgan");
  if (status === "expired") throw new BadRequestError("Ruxsat muddati tugagan — yopish shart emas");

  const revokeReason = typeof data.reason === "string" ? data.reason.trim().slice(0, REASON_MAX) : "";

  // Compare-and-swap: parallel ikki yopish ikkinchi aktyorni yozib yubormasin
  const result = await prisma.gradingGrant.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date(), revokedBy: actorId, revokeReason },
  });
  if (result.count !== 1) throw new ConflictError("Ruxsat allaqachon yopilgan");

  const updated = await prisma.gradingGrant.findUnique({ where: { id } });
  const refs = await loadRefs([updated]);
  return serialize(updated, refs, today);
}

/**
 * RUXSATLAR RO'YXATI — boshliq ekrani. Yangi berilgani tepada.
 *
 * @param {object} query - { status, teacherId, classId, page, limit }
 */
async function listGrants({ status, teacherId, classId, page = 1, limit = 20 } = {}) {
  const today = currentDayDate();
  const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);

  const where = {
    ...(STATUSES.includes(status) ? statusWhere(status, today) : {}),
    ...(teacherId && OBJECT_ID.test(String(teacherId)) ? { teacherId: String(teacherId) } : {}),
    ...(classId && OBJECT_ID.test(String(classId)) ? { classId: String(classId) } : {}),
  };

  const [rows, total, activeCount, upcomingCount] = await Promise.all([
    prisma.gradingGrant.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (current - 1) * take,
      take,
    }),
    prisma.gradingGrant.count({ where }),
    prisma.gradingGrant.count({ where: statusWhere("active", today) }),
    prisma.gradingGrant.count({ where: statusWhere("upcoming", today) }),
  ]);

  const refs = await loadRefs(rows);

  return {
    data: rows.map((row) => serialize(row, refs, today)),
    pagination: {
      page: current,
      limit: take,
      total,
      totalPages: Math.ceil(total / take),
      hasNextPage: current * take < total,
      hasPrevPage: current > 1,
    },
    totals: { active: activeCount, upcoming: upcomingCount },
  };
}

/**
 * TANLOV UCHUN: o'qituvchilar (haftalik dars soni bilan) va faol sinflar.
 *
 * ⚠️ `/classes`, `/schedules/teachers` DAN FOYDALANILMAYDI: ular boshqa
 * bo'lim ruxsatini talab qiladi. Ruxsat beradigan odamga shu bitta ekran
 * uchun sinflar yoki jadval bo'limini ochib berish shart emas
 * (`lessonSubstitution.getTeacherOptions` bilan bir xil mulohaza).
 */
async function getOptions() {
  const [teachers, weekly, classes] = await Promise.all([
    prisma.user.findMany({
      where: {
        isArchived: false,
        OR: [{ role: ROLES.TEACHER }, { extraRoles: { has: ROLES.TEACHER } }],
      },
      select: { id: true, firstName: true, lastName: true, username: true },
    }),
    prisma.scheduleLesson.groupBy({ by: ["teacherId"], _count: { _all: true } }),
    prisma.class.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
  ]);

  const weeklyMap = new Map(weekly.map((w) => [w.teacherId, w._count._all]));

  return {
    teachers: teachers
      .map((t) => ({
        id: t.id,
        name: fullName(t),
        username: t.username,
        weeklyHours: weeklyMap.get(t.id) ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "uz")),
    classes: classes.sort(byClassName),
  };
}

/**
 * SINFNING HAFTALIK DARSLARI — fanlar kesimida.
 *
 * Ruxsat oynasi shundan chiziladi: fan tanlovi (faqat jadvalda bor fanlar —
 * boshqasiga ruxsat hech narsani ochmasdi), tanlangan fanning haftalik
 * darslari (kim o'tadi, qachon) va "bitta dars" rejimida kun darslari.
 *
 * @param {string} classId
 */
async function getClassLessons(classId) {
  if (!classId || !OBJECT_ID.test(String(classId))) throw new BadRequestError("Sinfni tanlang");

  const klass = await prisma.class.findUnique({
    where: { id: String(classId) },
    select: { id: true, name: true },
  });
  if (!klass) throw new NotFoundError("Sinf topilmadi");

  const [lessons, settings] = await Promise.all([
    prisma.scheduleLesson.findMany({
      where: { schedule: { classId: klass.id } },
      select: {
        subjectId: true,
        teacherId: true,
        order: true,
        startTime: true,
        endTime: true,
        schedule: { select: { day: true } },
      },
    }),
    getScheduleSettings(),
  ]);

  const subjectIds = [...new Set(lessons.map((l) => l.subjectId))];
  const teacherIds = [...new Set(lessons.map((l) => l.teacherId))];

  const [subjects, teachers] = await Promise.all([
    subjectIds.length
      ? prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } })
      : [],
    teacherIds.length
      ? prisma.user.findMany({
          where: { id: { in: teacherIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [],
  ]);

  const subjectMap = new Map(subjects.map((s) => [s.id, s.name]));
  const teacherMap = new Map(teachers.map((t) => [t.id, fullName(t)]));
  const periodMap = new Map((settings.periods || []).map((p) => [p.order, p]));

  const bySubject = new Map();
  for (const lesson of lessons) {
    const day = lesson.schedule.day;
    let entry = bySubject.get(lesson.subjectId);
    if (!entry) {
      entry = {
        subjectId: lesson.subjectId,
        subjectName: subjectMap.get(lesson.subjectId) ?? "Noma'lum",
        lessons: [],
      };
      bySubject.set(lesson.subjectId, entry);
    }

    const period = periodMap.get(lesson.order);
    entry.lessons.push({
      day,
      dayLabel: capitalize(day),
      // JS `getUTCDay()` raqami (1 — dushanba): panel sanadan hafta kunini shunday oladi
      weekday: DAYS_UZ.indexOf(day),
      lessonOrder: lesson.order,
      startTime: lesson.startTime || period?.startTime || null,
      endTime: lesson.endTime || period?.endTime || null,
      teacherId: lesson.teacherId,
      teacherName: teacherMap.get(lesson.teacherId) ?? "Noma'lum",
    });
  }

  const result = [...bySubject.values()]
    .map((entry) => {
      entry.lessons.sort((a, b) => a.weekday - b.weekday || a.lessonOrder - b.lessonOrder);
      return {
        ...entry,
        weeklyCount: entry.lessons.length,
        teacherNames: [...new Set(entry.lessons.map((l) => l.teacherName))],
      };
    })
    .sort((a, b) => a.subjectName.localeCompare(b.subjectName, "uz"));

  return { class: klass, subjects: result };
}

/**
 * O'QITUVCHINING O'Z RUXSATLARI — amaldagi va kutilayotgan (baho qo'yish
 * sahifasidagi "Sizga ruxsat berilgan" kartasi). Identifikator tokendan.
 *
 * @param {string} teacherId
 */
async function listMyGrants(teacherId) {
  const today = currentDayDate();
  const rows = await prisma.gradingGrant.findMany({
    where: { teacherId, revokedAt: null, dateTo: { gte: today } },
    orderBy: [{ dateFrom: "asc" }, { createdAt: "asc" }],
  });
  if (rows.length === 0) return [];

  const refs = await loadRefs(rows);
  return rows.map((row) => serialize(row, refs, today));
}

module.exports = {
  MAX_RANGE_DAYS,
  STATUS_LABELS,
  statusOf,
  presetEnd,
  parseWindow,
  countOpenedLessons,
  createGrant,
  revokeGrant,
  listGrants,
  getOptions,
  getClassLessons,
  listMyGrants,
};
