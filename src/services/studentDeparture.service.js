/**
 * CHIQIB KETGAN O'QUVCHILAR — "kim, QACHON va NEGA ketdi".
 *
 * ⚠️ YANGI JADVAL YO'Q va qo'shilmaydi. Ketish fakti allaqachon bitta
 * joyda yozilgan: o'qish davrining YOPILGANI
 * (`StudentEnrollment.endDate` + `endReason` + erkin izoh). Ikkinchi
 * registr ochilsa, arxivlash (`user.service.js` → davrni yopadi),
 * filiallararo ko'chirish va qo'lda yopish uchun uchta alohida yo'l paydo
 * bo'lardi va ulardan biri jimgina yozilmay qolardi — "nega ketgani"
 * degan savol esa aynan shunday javobsiz qoladi.
 *
 * Bu servis faqat O'QIYDI: davrni yopish, tahrirlash va qayta ochish
 * avvalgidek `studentEnrollment.service.js` da (u pulga tegadi — §3,
 * qamramay qolgan oylarning hisob-fakturasi bekor qilinadi).
 *
 * ⚠️ ARXIVLANGAN O'QUVCHI HAM KO'RINADI. "Arxivlangan o'quvchi faqat
 * arxiv ro'yxatida" qoidasi (`education.md` §4) JORIY o'quvchilar
 * ro'yxatlariga tegishli; bu esa ularning aksi — KETGANLAR jurnali.
 * Arxivlanganni yashirish uni butunlay ko'rinmas qilardi, chunki ketish
 * va arxivlash odatda bir vaqtda bo'ladi (`listClassChanges` bilan AYNI
 * mulohaza). Panel ularni belgi bilan ko'rsatadi.
 *
 * ⚠️ YUQORI CHEGARA BUGUNDAN OSHMAYDI. Kelgusi sana bilan yopilgan davr —
 * REJA, ketish fakti emas: o'quvchi o'sha kungacha o'qiyapti va shu
 * oygacha hisob-faktura oladi. Uni "ketgan" deb sanash registrni
 * kelajakdagi qarorlar bilan to'ldirardi.
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const { buildNameSearchWhere } = require("../helpers/nameSearch.helpers");
const {
  parseDayDate,
  monthKeyOfDate,
  monthStartDate,
  currentMonthKey,
  todayIsoTashkent,
  shiftIsoDays,
  nextMonth,
} = require("../helpers/month.helpers");
const {
  END_REASONS,
  END_REASON_LABELS,
} = require("./studentEnrollment.service");

/** Bosh sahifadagi karta oynasi (kun) — "oxirgi 30 kun". */
const SUMMARY_WINDOW_DAYS = 30;

/** Kartadagi so'nggi ketishlar soni. */
const SUMMARY_ITEMS = 5;

/** Registr sahifasi. */
const PAGE_LIMIT_DEFAULT = 20;
const PAGE_LIMIT_MAX = 100;

/**
 * Oylar kesimidagi ustunlar chegarasi. Uzun oraliqda (masalan "Hammasi")
 * grafik o'qi o'qilmas bo'lib qolardi — eng YANGI 24 oy qoldiriladi.
 */
const TREND_MONTHS_MAX = 24;

/** Davr presetlari (kun). `all` — chegarasiz. */
const PERIOD_DAYS = { 30: 30, 90: 90, 365: 365 };

/** Sukut: oxirgi 12 oy. Chegarasiz ro'yxat birinchi ochilishda ham
 *  ma'noli bo'lishi kerak, lekin butun tarix odatda keraksiz. */
const PERIOD_DEFAULT = "365";

const DAY_MS = 86400000;

/** `@db.Date` → "YYYY-MM-DD" (faqat `getUTC*`, `finance.md` §0). */
const iso = (date) => (date == null ? null : date.toISOString().slice(0, 10));

const STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  isArchived: true,
  classes: {
    select: { class: { select: { id: true, name: true } } },
    orderBy: { class: { name: "asc" } },
  },
};

// ─────────────────────────────────────────────
// So'rov parametrlari
// ─────────────────────────────────────────────

/**
 * Davr → UTC yarim tunidagi chegaralar.
 *
 * `from`/`to` berilsa ular yutadi (ixtiyoriy oraliq), aks holda `period`
 * presetidan hisoblanadi. Yuqori chegara har doim bugundan oshmaydi
 * (fayl boshidagi izoh).
 *
 * @param {object} query
 * @returns {{from: Date|null, to: Date, fromIso: string|null, toIso: string, period: string}}
 */
const resolveRange = (query = {}) => {
  const today = parseDayDate(todayIsoTashkent());

  const rawTo = String(query.to ?? "").trim();
  const rawFrom = String(query.from ?? "").trim();

  // ⚠️ Yaroqsiz sana JIM o'tmaydi: `parseDayDate` xato beradi. Ilgari
  // noto'g'ri `to` jimgina "bugun" bilan almashardi va foydalanuvchi
  // butunlay boshqa oraliqning raqamini ko'rib turardi.
  const asked = rawTo ? parseDayDate(rawTo, "Tugash sanasi") : null;
  const to = asked && asked < today ? asked : today;

  const period = rawFrom || rawTo ? "custom" : String(query.period ?? PERIOD_DEFAULT);

  let from = rawFrom ? parseDayDate(rawFrom, "Boshlanish sanasi") : null;
  if (!from && period !== "custom") {
    const days = PERIOD_DAYS[period];
    if (!days && period !== "all") {
      throw new BadRequestError("Davr noto'g'ri tanlangan");
    }
    from = days ? parseDayDate(shiftIsoDays(iso(to), -(days - 1))) : null;
  }

  if (from && from > to) {
    throw new BadRequestError(
      "Boshlanish sanasi tugash sanasidan keyin bo'lishi mumkin emas",
    );
  }

  return { from, to, fromIso: iso(from), toIso: iso(to), period };
};

const parseReason = (value) => {
  const reason = String(value ?? "").trim();
  if (!reason || reason === "all") return null;
  if (!END_REASONS.includes(reason)) {
    throw new BadRequestError("Ketish sababi noto'g'ri tanlangan");
  }
  return reason;
};

/**
 * Ketgan davrlar sharti.
 *
 * ⚠️ `endReason: { not: null }` SHART: davr tugash sanasi bilan ochilishi
 * mumkin (kelgusi reja), lekin sabab tanlanmagan qator "nega ketdi" degan
 * savolga javob bermaydi — yozuvda ikkalasi ham majburiy
 * (`createEnrollment`), bu esa eski ma'lumot uchun zaxira qavat.
 */
const buildWhere = ({ from, to, reason, studentIds }) => ({
  endDate: { ...(from ? { gte: from } : {}), lte: to },
  ...(reason ? { endReason: reason } : { endReason: { not: null } }),
  ...(studentIds ? { studentId: { in: studentIds } } : {}),
});

/**
 * Qidiruv — IKKI QADAMDA: `StudentEnrollment` da `studentId` soft ref
 * (FK yo'q, `User` ga relation ham yo'q), ya'ni `student: {...}` sharti
 * yozib bo'lmaydi. Avval mos o'quvchilar topiladi, keyin davrlar ular
 * bo'yicha filtrlanadi — natija baribir SQL da chiqadi, xotirada emas
 * (`devices.md` §10 bilan AYNI naqsh).
 *
 * @returns {Promise<string[]|null>} null — qidiruv berilmagan
 */
const resolveSearchStudentIds = async (search) => {
  const nameWhere = buildNameSearchWhere(search);
  if (!nameWhere) return null;

  const students = await prisma.user.findMany({
    where: { role: ROLES.STUDENT, ...nameWhere },
    select: { id: true },
  });

  return students.map((s) => s.id);
};

// ─────────────────────────────────────────────
// Qo'shimcha kontekst (sinf, qaytib kelgani)
// ─────────────────────────────────────────────

/**
 * KETGAN PAYTDAGI SINF.
 *
 * Arxivlash o'quvchini BARCHA sinflardan chiqaradi (`education.md` §5),
 * shuning uchun ketgan o'quvchining joriy sinfi deyarli har doim bo'sh
 * bo'ladi. Shu sababli sinf ketish OYINING hisob-fakturasidagi
 * `studentSnapshot.className` dan olinadi — hisobotlardagi sinf kesimi
 * ham aynan shu manbadan ("joriy sinf bo'yicha olinsa, o'quvchini boshqa
 * sinfga o'tkazish o'tgan hisobotni jimgina qayta yozardi").
 *
 * Hisob-faktura bo'lmasa (ta'til oyi, tarifsiz o'quvchi) joriy sinflar
 * zaxira sifatida ishlatiladi — "—" dan ko'ra aniqroq javob.
 *
 * @param {Array<{studentId: string, endDate: Date}>} rows
 * @returns {Promise<Map<string, string>>} `studentId|month` → sinf nomi
 */
const loadDepartureClasses = async (rows) => {
  const byKey = new Map();
  if (rows.length === 0) return byKey;

  const studentIds = [...new Set(rows.map((r) => r.studentId))];
  const months = [...new Set(rows.map((r) => monthKeyOfDate(r.endDate)))];

  const invoices = await prisma.monthlyInvoice.findMany({
    where: { studentId: { in: studentIds }, month: { in: months } },
    select: { studentId: true, month: true, studentSnapshot: true },
  });

  for (const invoice of invoices) {
    const name = invoice.studentSnapshot?.className;
    if (name) byKey.set(`${invoice.studentId}|${invoice.month}`, name);
  }

  return byKey;
};

/**
 * O'quvchining BARCHA davrlari — "keyin qaytib kelganmi" degan savol uchun.
 *
 * ⚠️ Yopilgan davr "o'quvchi hozir yo'q" degani EMAS: u ketib, qaytib
 * kelgan bo'lishi mumkin (`education.md` §3 — bir o'quvchida bir nechta
 * davr). Buni ko'rsatmasa, registr qaytib kelgan bolani ham "ketgan"
 * ro'yxatida ushlab turardi va raqam ishonchini yo'qotardi.
 *
 * @param {string[]} studentIds
 * @returns {Promise<Map<string, Array<{startDate: Date, endDate: Date|null}>>>}
 */
const loadStudentPeriods = async (studentIds) => {
  const byStudent = new Map();
  if (studentIds.length === 0) return byStudent;

  const rows = await prisma.studentEnrollment.findMany({
    where: { studentId: { in: studentIds } },
    select: { studentId: true, startDate: true, endDate: true },
    orderBy: { startDate: "asc" },
  });

  for (const row of rows) {
    if (!byStudent.has(row.studentId)) byStudent.set(row.studentId, []);
    byStudent.get(row.studentId).push(row);
  }

  return byStudent;
};

const loadStudents = async (studentIds) => {
  if (studentIds.length === 0) return new Map();

  const students = await prisma.user.findMany({
    where: { id: { in: studentIds } },
    select: STUDENT_SELECT,
  });

  return new Map(students.map((s) => [s.id, s]));
};

/**
 * Davrlar ro'yxatiga kontekst qo'shadi (sinf, o'quvchi, qaytib kelgani).
 * Sahifadagi qatorlar uchun — HAR BIR qator uchun alohida so'rov emas.
 */
const buildContext = async (rows) => {
  const studentIds = [...new Set(rows.map((r) => r.studentId))];

  const [studentById, periodsByStudent, classByKey] = await Promise.all([
    loadStudents(studentIds),
    loadStudentPeriods(studentIds),
    loadDepartureClasses(rows),
  ]);

  return { studentById, periodsByStudent, classByKey, todayIso: todayIsoTashkent() };
};

/**
 * @param {object} row - `StudentEnrollment` qatori
 * @param {object} ctx - `buildContext` natijasi
 */
const serializeDeparture = (row, ctx) => {
  const startIso = iso(row.startDate);
  const endIso = iso(row.endDate);
  const endMonth = monthKeyOfDate(row.endDate);

  const student = ctx.studentById.get(row.studentId) ?? null;
  const currentClasses = (student?.classes ?? []).map((link) => link.class);

  // Ketgan paytdagi sinf → zaxira: joriy sinflar (yuqoridagi izoh)
  const snapshotClass = ctx.classByKey.get(`${row.studentId}|${endMonth}`) ?? null;
  const className =
    snapshotClass ?? (currentClasses.length ? currentClasses.map((c) => c.name).join(", ") : null);

  // Keyin ochilgan davr bormi (eng ERTA) — "qaytib kelgan"
  const periods = ctx.periodsByStudent.get(row.studentId) ?? [];
  const returned = periods.find((p) => iso(p.startDate) > endIso) ?? null;
  const studyingNow = periods.some(
    (p) => iso(p.startDate) <= ctx.todayIso && (p.endDate == null || iso(p.endDate) >= ctx.todayIso),
  );

  return {
    id: row.id,
    studentId: row.studentId,
    student: student
      ? {
          id: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
          username: student.username,
          isArchived: student.isArchived,
          currentClasses,
        }
      : null,
    className,
    // Sinf ketish oyining hisob-fakturasidan olinganmi yoki joriy
    // a'zolikdan — panel "o'sha paytdagi" va "hozirgi" ni aralashtirmasin
    classSource: snapshotClass ? "snapshot" : currentClasses.length ? "current" : null,
    startDate: startIso,
    endDate: endIso,
    endMonth,
    endReason: row.endReason,
    endReasonLabel: END_REASON_LABELS[row.endReason] ?? null,
    // Erkin izoh — "nega" degan savolning asl javobi (toifa faqat kesim
    // uchun). `reason` yopishda, `note` davrning umumiy izohi.
    reason: row.reason || "",
    note: row.note || "",
    studiedDays: Math.floor((row.endDate - row.startDate) / DAY_MS) + 1,
    returnedAt: returned ? iso(returned.startDate) : null,
    isStudyingNow: studyingNow,
    createdAt: row.createdAt,
  };
};

// ─────────────────────────────────────────────
// Kesimlar
// ─────────────────────────────────────────────

/**
 * ORALIQNI BIR MARTA O'QISH — kesimlarning hammasi shu qatorlardan.
 *
 * ⚠️ Sanoqchi SO'ROVLARI (count + groupBy × 2) ATAYLAB olib tashlangan:
 * ularning har biri AYNI shartni qaytadan bajarardi, holbuki kesimlar
 * uchun kerak bo'lgani uchta ustun. Bitta skanerdan jami, o'quvchilar
 * soni, sabab kesimi va oylar kesimi — hammasi BIR XIL ma'lumotdan
 * chiqadi, ya'ni ular bir-biriga qarama-qarshi bo'lishi STRUKTURAVIY
 * imkonsiz.
 *
 * @returns {Promise<Array<{studentId: string, endDate: Date, endReason: string}>>}
 */
const scanRange = (where) =>
  prisma.studentEnrollment.findMany({
    where,
    select: { studentId: true, endDate: true, endReason: true },
  });

/**
 * Sabab toifalari kesimi — HAR DOIM to'rtta qator, nollari ham.
 *
 * Nol qatorni tashlab yuborish kartani "chetlatilganlar yo'q" degan
 * ma'lumotdan mahrum qilardi: bo'sh joy "nol" degani emas, "hisoblanmadi"
 * degani ham bo'lib o'qiladi.
 *
 * @param {Array<{endReason: string}>} rows
 * @returns {Array<{key: string, label: string, count: number}>}
 */
const groupByReason = (rows) => {
  const counts = new Map();
  for (const row of rows) {
    counts.set(row.endReason, (counts.get(row.endReason) ?? 0) + 1);
  }

  return END_REASONS.map((key) => ({
    key,
    label: END_REASON_LABELS[key],
    count: counts.get(key) ?? 0,
  }));
};

/**
 * Sabab kesimi — SO'ROV bilan (karta uchun: oyna ichidagi manzara).
 */
const countByReason = async (where) => groupByReason(await scanRange(where));

/**
 * Oylar kesimi — ketish sanasining OYI bo'yicha, sabab bilan birga.
 *
 * ⚠️ SQL da `GROUP BY` qilinmaydi: oyni ajratish uchun xom SQL
 * (`to_char`) kerak bo'lardi, holbuki qatorlar allaqachon o'qilgan
 * (`scanRange`). Oy kaliti — `monthKeyOfDate` (domendagi YAGONA
 * o'lchov, `finance.md` §0).
 *
 * @param {Array<{endDate: Date, endReason: string}>} rows
 * @returns {Array<object>} eng yangi oy OXIRIDA (grafik tartibi)
 */
const buildMonthlyTrend = (rows) => {
  const emptyBucket = (month) => ({
    month,
    total: 0,
    ...Object.fromEntries(END_REASONS.map((key) => [key, 0])),
  });

  const byMonth = new Map();
  for (const row of rows) {
    const month = monthKeyOfDate(row.endDate);
    if (!byMonth.has(month)) byMonth.set(month, emptyBucket(month));

    const bucket = byMonth.get(month);
    bucket.total += 1;
    if (row.endReason) bucket[row.endReason] += 1;
  }

  const months = [...byMonth.keys()].sort((a, b) => a - b);
  if (months.length === 0) return [];

  // Bo'sh oylar ham qatorga tushadi: grafikda uzilish bo'lsa, "o'sha oyda
  // hech kim ketmagan" bilan "ma'lumot yo'q" bir xil ko'rinardi.
  const filled = [];
  let cursor = months[0];
  const last = months[months.length - 1];
  while (cursor <= last) {
    filled.push(byMonth.get(cursor) ?? emptyBucket(cursor));
    cursor = nextMonth(cursor);
  }

  return filled.slice(-TREND_MONTHS_MAX);
};

/**
 * KETGANDAN KEYIN QAYTIB KELGANLAR — oraliqning BUTUNI bo'yicha.
 *
 * ⚠️ SAHIFADAN hisoblanmaydi: "nechtasi qaytib kelgan" degan raqam
 * sahifani varaqlaganda o'zgarib turishi mumkin emas. Shuning uchun
 * o'sha o'quvchilarning ketishdan KEYIN boshlangan davrlari alohida
 * o'qiladi — qayta yozilish kam uchraydigan hodisa, ya'ni qatorlar
 * ham kam.
 *
 * @param {Array<{studentId: string, endDate: Date}>} rows
 * @returns {Promise<number>}
 */
const countReturned = async (rows) => {
  if (rows.length === 0) return 0;

  const studentIds = [...new Set(rows.map((r) => r.studentId))];
  const earliest = rows.reduce(
    (min, row) => (row.endDate < min ? row.endDate : min),
    rows[0].endDate,
  );

  const later = await prisma.studentEnrollment.findMany({
    where: { studentId: { in: studentIds }, startDate: { gt: earliest } },
    select: { studentId: true, startDate: true },
  });

  const byStudent = new Map();
  for (const row of later) {
    if (!byStudent.has(row.studentId)) byStudent.set(row.studentId, []);
    byStudent.get(row.studentId).push(row.startDate);
  }

  return rows.filter((row) =>
    (byStudent.get(row.studentId) ?? []).some((start) => start > row.endDate),
  ).length;
};

// ─────────────────────────────────────────────
// Ommaviy yo'llar
// ─────────────────────────────────────────────

/**
 * REGISTR — sahifalangan ro'yxat + kesimlar.
 *
 * ⚠️ IKKI XIL "JAMI" BOR va ikkalasi ham kerak:
 *   · `total` — EKRANDAGI ro'yxatning jami (sabab filtri bilan), ya'ni
 *     u `pagination.total` ga TENG. Aks holda karta 15, jadval esa 3
 *     qator ko'rsatib, foydalanuvchini "qolgani qayerda" deb qidirtirardi.
 *   · `reasonTotal` — sabab filtriDAN QAT'I NAZAR hisoblangan jami:
 *     toifalar kesimining ULUSH maxraji. Toifa tanlanganda ham qolgan
 *     toifalarning raqami ko'rinib turishi kerak, aks holda filtr o'z
 *     kontekstini o'chirib qo'yardi (`listClassChanges` dagi AYNI qaror).
 *
 * @param {object} req
 */
const getDepartures = async (req) => {
  const { query } = req;
  const range = resolveRange(query);
  const reason = parseReason(query.reason);

  const { page } = getPaginationParams(req, PAGE_LIMIT_DEFAULT);
  const limit = Math.min(
    Number.parseInt(query.limit, 10) || PAGE_LIMIT_DEFAULT,
    PAGE_LIMIT_MAX,
  );
  const skip = (page - 1) * limit;

  const studentIds = await resolveSearchStudentIds(query.search);

  const emptyStats = {
    total: 0,
    reasonTotal: 0,
    studentCount: 0,
    returnedCount: 0,
    byReason: groupByReason([]),
  };

  // Qidiruv hech kimga mos kelmasa — bo'sh sahifa (bazaga bormasdan)
  if (studentIds && studentIds.length === 0) {
    return {
      ...formatPaginationResponse([], 0, page, limit),
      range: { from: range.fromIso, to: range.toIso, period: range.period },
      stats: emptyStats,
      byMonth: [],
    };
  }

  const scope = { from: range.from, to: range.to, studentIds };
  const where = buildWhere({ ...scope, reason });

  const [rows, scanned, reasonRows] = await Promise.all([
    prisma.studentEnrollment.findMany({
      where,
      orderBy: [{ endDate: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    // Kesimlar — BITTA skanerdan (jami, o'quvchilar soni, oylar)
    scanRange(where),
    // Toifalar kesimi — sabab filtriDAN TASHQARI
    reason ? scanRange(buildWhere(scope)) : null,
  ]);

  const [ctx, returnedCount] = await Promise.all([
    buildContext(rows),
    countReturned(scanned),
  ]);

  const byReason = groupByReason(reasonRows ?? scanned);

  return {
    ...formatPaginationResponse(
      rows.map((row) => serializeDeparture(row, ctx)),
      scanned.length,
      page,
      limit,
    ),
    range: { from: range.fromIso, to: range.toIso, period: range.period },
    stats: {
      total: scanned.length,
      reasonTotal: byReason.reduce((sum, item) => sum + item.count, 0),
      // ⚠️ O'QUVCHILAR SONI va KETISHLAR SONI — IKKI XIL raqam va
      // ikkalasi ham ko'rsatiladi: bir o'quvchi ketib, qaytib, yana
      // ketgan bo'lishi mumkin (`certificates` statistikasidagi AYNI
      // qoida — "277 o'quvchi" degan yolg'on raqam chiqmasin).
      studentCount: new Set(scanned.map((row) => row.studentId)).size,
      returnedCount,
      byReason,
    },
    byMonth: buildMonthlyTrend(scanned),
  };
};

/**
 * BOSH SAHIFA KARTASI — oxirgi 30 kun + so'nggi ketishlar.
 *
 * ⚠️ Kartadagi RO'YXAT oyna bilan CHEGARALANMAGAN (so'nggi 5 ta, sanasi
 * bilan), raqamlar esa aniq oynaga tegishli. Sabab: oyna ichida hech kim
 * ketmagan hafta odatiy hol, lekin rahbar "oxirgi kim ketdi" degan
 * savolga javobni shu kartadan oladi — bo'sh ro'yxat esa bo'limni
 * "ishlamayapti" bo'lib ko'rsatardi. Shuning uchun har bir blok o'z
 * sarlavhasini oladi.
 */
const getDepartureSummary = async () => {
  const todayIso = todayIsoTashkent();
  const fromIso = shiftIsoDays(todayIso, -(SUMMARY_WINDOW_DAYS - 1));
  const prevToIso = shiftIsoDays(fromIso, -1);
  const prevFromIso = shiftIsoDays(prevToIso, -(SUMMARY_WINDOW_DAYS - 1));

  const to = parseDayDate(todayIso);
  const from = parseDayDate(fromIso);
  const month = currentMonthKey();

  const windowWhere = buildWhere({ from, to });

  const [total, prevTotal, monthTotal, byReason, rows] = await Promise.all([
    prisma.studentEnrollment.count({ where: windowWhere }),
    prisma.studentEnrollment.count({
      where: buildWhere({
        from: parseDayDate(prevFromIso),
        to: parseDayDate(prevToIso),
      }),
    }),
    prisma.studentEnrollment.count({
      where: buildWhere({ from: monthStartDate(month), to }),
    }),
    countByReason(windowWhere),
    prisma.studentEnrollment.findMany({
      where: buildWhere({ to }),
      orderBy: [{ endDate: "desc" }, { createdAt: "desc" }],
      take: SUMMARY_ITEMS,
    }),
  ]);

  const ctx = await buildContext(rows);

  return {
    windowDays: SUMMARY_WINDOW_DAYS,
    from: fromIso,
    to: todayIso,
    month,
    total,
    prevTotal,
    monthTotal,
    byReason,
    items: rows.map((row) => serializeDeparture(row, ctx)),
  };
};

module.exports = {
  SUMMARY_WINDOW_DAYS,
  PERIOD_DAYS,
  getDepartures,
  getDepartureSummary,
  // "KETGAN PAYTDAGI SINF" qoidasi BITTA joyda: uni o'quvchilar harakati
  // hisoboti ham chaqiradi (`studentMovement.service.js`). Nusxa olinsa,
  // bir ekran hisob-fakturadagi sinfni, ikkinchisi joriy a'zolikni
  // ko'rsatib, bitta o'quvchi ikki xil sinfda turib qolardi.
  loadDepartureClasses,
};
