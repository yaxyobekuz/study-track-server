/**
 * O'quvchining o'qish davrlari — moliya domenidagi yagona KUN aniqligidagi
 * davr jadvali.
 *
 * Davr ikki narsani hal qiladi:
 *   1. Shu oyga hisob-faktura YOZILADIMI (davr oyni qamramasa — yo'q);
 *   2. Oyning qaysi ULUSHI to'lanadi (oy ichida kelgan bo'lsa proratsiya).
 *
 * `endDate` faqat 1-savolga ta'sir qiladi. Chiqishda proratsiya YO'Q:
 * 3-sentabrda ketgan o'quvchi sentabrni to'liq to'laydi.
 *
 * ⚠️ `resolveEnrollmentsForStudents` davrlarni OY ORALIG'I BO'YICHA
 * FILTRLAMAYDI — bu ataylab. Filtrlansa, o'tgan yili ketgan o'quvchida
 * bo'sh ro'yxat chiqadi va "davri yo'q = abadiy o'qiydi" qoidasi unga
 * abadiy hisob-faktura yozib berardi.
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const logger = require("../utils/logger");
const {
  currentMonthKey,
  monthKeyOfDate,
  monthEndDate,
  prevMonth,
  parseDayDate,
  parseOptionalDayDate,
  parseOptionalMonthKey,
  formatMonthKey,
} = require("../helpers/month.helpers");
const { formatAmount, parseAmount, sumAmounts } = require("../helpers/money.helpers");
const {
  parseEnrollmentPeriod,
  overlappingDateRangeWhere,
  resolveEnrollmentForMonth,
  describeEnrollment,
} = require("../helpers/enrollment.helpers");
const { resolveStatusForStudent } = require("./studentFinanceStatus.service");

const END_REASONS = ["left", "expelled", "graduated", "transferred"];

const END_REASON_LABELS = {
  left: "O'z ixtiyori bilan ketdi",
  expelled: "Chetlatildi",
  graduated: "Bitirdi",
  transferred: "Boshqa filialga o'tdi",
};

const STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  isArchived: true,
};

// ─────────────────────────────────────────────
// Tekshiruvlar
// ─────────────────────────────────────────────

const assertStudent = async (studentId) => {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { ...STUDENT_SELECT, role: true },
  });

  if (!student || student.role !== ROLES.STUDENT) {
    throw new NotFoundError("O'quvchi topilmadi");
  }

  return student;
};

const parseEndReason = (value) => {
  if (value == null || value === "") return null;

  const reason = String(value).trim();
  if (!END_REASONS.includes(reason)) {
    throw new BadRequestError(
      `Ketish sababi noto'g'ri. Mumkin: ${END_REASONS.map((r) => END_REASON_LABELS[r]).join(", ")}`,
    );
  }
  return reason;
};

/**
 * Bir o'quvchida davrlar kesishmasligi. Tekshiruv yozuv bilan BITTA
 * tranzaksiyada; poyga holatidagi kafolat — `@@unique([studentId, startDate])`
 * (u kesishuvni emas, faqat bir xil boshlanishni ushlaydi).
 */
const assertNoOverlap = async (tx, studentId, period, excludeId = null) => {
  const conflict = await tx.studentEnrollment.findFirst({
    where: {
      studentId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      ...overlappingDateRangeWhere(period.startDate, period.endDate),
    },
    orderBy: { startDate: "asc" },
  });

  if (!conflict) return;

  throw new BadRequestError(
    `Bu davr o'quvchining mavjud davri bilan kesishadi ` +
      `(${formatDay(conflict.startDate)} — ${conflict.endDate ? formatDay(conflict.endDate) : "hozirgacha"}). ` +
      "Avval o'shani yoping yoki sanalarni to'g'rilang.",
  );
};

/** Ochiq davr bittadan ortiq bo'lmasin — xato xabari aniq bo'lishi uchun. */
const assertNoSecondOpenPeriod = async (tx, studentId, endDate, excludeId = null) => {
  if (endDate != null) return;

  const open = await tx.studentEnrollment.findFirst({
    where: {
      studentId,
      endDate: null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });

  if (open) {
    throw new BadRequestError(
      `O'quvchida allaqachon ochiq o'qish davri bor (${formatDay(open.startDate)} dan). ` +
        "Yangisini ochishdan oldin uni yoping.",
    );
  }
};

const formatDay = (date) =>
  date == null ? "—" : date.toISOString().slice(0, 10);

const rethrowDuplicate = (error, message) => {
  if (error?.code === "P2002") throw new BadRequestError(message);
  throw error;
};

// ─────────────────────────────────────────────
// Hal qilish (generator uchun)
// ─────────────────────────────────────────────

/**
 * Ko'p o'quvchining BARCHA o'qish davrlari.
 *
 * ⚠️ Sana bo'yicha FILTR YO'Q — yuqoridagi izohga qarang. Bitta so'rov,
 * o'quvchilar soniga qaramay (`@@index([studentId, startDate])`).
 *
 * @param {string[]} studentIds
 * @returns {Promise<Map<string, Array<{startDate: Date, endDate: Date|null}>>>}
 */
const resolveEnrollmentsForStudents = async (studentIds = []) => {
  const byStudent = new Map();
  if (studentIds.length === 0) return byStudent;

  const rows = await prisma.studentEnrollment.findMany({
    where: { studentId: { in: studentIds } },
    select: {
      studentId: true,
      startDate: true,
      endDate: true,
      firstMonthAmount: true,
      firstMonthKey: true,
    },
    orderBy: { startDate: "asc" },
  });

  for (const row of rows) {
    if (!byStudent.has(row.studentId)) byStudent.set(row.studentId, []);
    byStudent.get(row.studentId).push({
      startDate: row.startDate,
      endDate: row.endDate,
      firstMonthAmount: row.firstMonthAmount,
      firstMonthKey: row.firstMonthKey,
    });
  }

  return byStudent;
};

/**
 * Bitta o'quvchining davrlari (xom, tartiblangan).
 * @param {string} studentId
 * @returns {Promise<Array<object>>}
 */
const getPeriodsForStudent = async (studentId) =>
  prisma.studentEnrollment.findMany({
    where: { studentId },
    orderBy: { startDate: "asc" },
  });

// ─────────────────────────────────────────────
// O'qish
// ─────────────────────────────────────────────

const serializeEnrollment = (row, { student } = {}) => ({
  ...row,
  startDate: formatDay(row.startDate),
  endDate: formatDay(row.endDate) === "—" ? null : formatDay(row.endDate),
  startMonth: monthKeyOfDate(row.startDate),
  endMonth: row.endDate ? monthKeyOfDate(row.endDate) : null,
  endReasonLabel: row.endReason ? END_REASON_LABELS[row.endReason] : null,
  isOpen: row.endDate == null,
  student: student ?? null,
});

/**
 * O'quvchining davrlari + hozirgi holati.
 *
 * @param {string} studentId
 * @returns {Promise<object>}
 */
const getStudentEnrollments = async (studentId) => {
  const student = await assertStudent(studentId);
  const month = currentMonthKey();

  // Muzlatish MOLIYA holati, o'qish davri emas — lekin ekranda ikkalasi
  // bitta qatorda ko'rinadi ("O'qiyapti / Muzlatilgan / O'qimayapti").
  // Shu yerda qo'shilishi admin panelida ikkinchi so'rovni va
  // feature'lararo bog'liqlikni keraksiz qiladi.
  const [rows, financeStatus] = await Promise.all([
    getPeriodsForStudent(studentId),
    resolveStatusForStudent(studentId, month),
  ]);

  const state = describeEnrollment(rows);
  const current = resolveEnrollmentForMonth(rows, month);

  return {
    student,
    isStudying: state.isStudying,
    hasPeriods: state.hasPeriods,
    isFrozen: financeStatus.status === "frozen",
    financeStatus: financeStatus.status,
    financeStatusLabel: financeStatus.statusLabel,
    since: formatDay(state.since) === "—" ? null : formatDay(state.since),
    until: formatDay(state.until) === "—" ? null : formatDay(state.until),
    // Joriy oyda qanday hisoblanadi — "20-yanvardan · 12/31 kun"
    currentMonth: {
      month,
      monthLabel: formatMonthKey(month),
      ...current,
    },
    items: rows.map((row) => serializeEnrollment(row, { student })),
  };
};

/**
 * Davrlar ro'yxati (sahifalangan) — kelajakdagi umumiy ekran uchun.
 * @param {object} req
 * @returns {Promise<object>}
 */
const getEnrollments = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const filter = {};
  if (query.studentId) filter.studentId = query.studentId;
  if (query.openOnly === "true") filter.endDate = null;

  const [rows, total] = await Promise.all([
    prisma.studentEnrollment.findMany({
      where: filter,
      orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    prisma.studentEnrollment.count({ where: filter }),
  ]);

  const students = rows.length
    ? await prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.studentId))] } },
        select: STUDENT_SELECT,
      })
    : [];
  const studentMap = new Map(students.map((s) => [s.id, s]));

  return formatPaginationResponse(
    rows.map((row) => serializeEnrollment(row, { student: studentMap.get(row.studentId) })),
    total,
    page,
    limit,
  );
};

const getEnrollmentById = async (id) => {
  const row = await prisma.studentEnrollment.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("O'qish davri topilmadi");

  const student = await prisma.user.findUnique({
    where: { id: row.studentId },
    select: STUDENT_SELECT,
  });

  return serializeEnrollment(row, { student });
};

// ─────────────────────────────────────────────
// Ogohlantirishlar (RAQAM bilan)
// ─────────────────────────────────────────────

/**
 * Davr o'zgarishi QAMRAB QOLGAN oylarning hisob-fakturalariga qanday tegishini
 * RAQAMLAR bilan aytadi.
 *
 * Muhrlangan summa hech qachon avtomatik o'zgarmaydi (qaytarilmaslik
 * qoidasi), lekin admin nima buzilganini va nima qilish kerakligini
 * ko'rishi shart. "Hisob-faktura bor" degan quruq ogohlantirish bu yerda
 * yetarli emas: proratsiya bilan hisob-faktura noto'g'ri EMAS, balki
 * MA'LUM BIR SUMMAGA noto'g'ri bo'ladi.
 *
 * Davr endi QAMRAMAYDIGAN oylar bu yerda emas — ular bekor qilinadi
 * (`cancelUncoveredInvoices`) va natijasi o'sha yerdan aytiladi.
 *
 * @param {string} studentId
 * @param {Array<object>} periods - YANGI holat
 * @returns {Promise<string[]>}
 */
const collectInvoiceWarnings = async (studentId, periods) => {
  const invoices = await prisma.monthlyInvoice.findMany({
    where: { studentId, status: { not: "cancelled" } },
    select: { month: true, amount: true, billableDays: true, monthDays: true },
    orderBy: { month: "asc" },
  });

  const changed = [];

  for (const invoice of invoices) {
    const next = resolveEnrollmentForMonth(periods, invoice.month);
    if (!next.enrolled) continue;

    const sealedDays = invoice.billableDays ?? invoice.monthDays ?? next.monthDays;
    if (sealedDays !== next.billableDays) {
      changed.push(
        `${formatMonthKey(invoice.month)}: ${formatAmount(invoice.amount)} yozilgan ` +
          `(${sealedDays}/${next.monthDays} kun) → yangi sanaga ko'ra ${next.billableDays}/${next.monthDays} kun`,
      );
    }
  }

  return changed.length
    ? [`Bu oylarning ulushi o'zgardi — kerak bo'lsa qayta shakllantiring: ${changed.join("; ")}`]
    : [];
};

// ─────────────────────────────────────────────
// Davr QAMRAMAYDIGAN oylarning hisob-fakturalari
// ─────────────────────────────────────────────

const serializeImpactInvoice = (invoice) => ({
  id: invoice.id,
  month: invoice.month,
  monthLabel: formatMonthKey(invoice.month),
  amount: formatAmount(invoice.amount),
  paidAmount: formatAmount(invoice.paidAmount),
  status: invoice.status,
});

/**
 * Davr endi QAMRAMAYDIGAN oylarning amaldagi hisob-fakturalari: nima bekor
 * qilinadi va nima ruxsat yetmagani uchun qoladi.
 *
 * Generator davr qamramagan oyga hisob-faktura YOZMAYDI. Davr keyin yopilsa
 * yoki qisqartirilsa, o'sha oylarga allaqachon yozilgani xuddi shunday
 * ortiqcha — "1-oktabrda shakllandi, 6-oktabrda o'quvchi 30-sentabr bilan
 * yopildi" holatida u qarzdorlar registrida yolg'on qarz bo'lib turardi.
 *
 * ⚠️ BITTA JOY: oynadagi oldindan ko'rish ham, haqiqiy yozuv ham shuni
 * chaqiradi — "oyna bir narsa dedi, boshqasi bekor bo'ldi" holati bo'lmasin.
 *
 * ⚠️ O'TGAN OY — `finance.adjust` (`allowPastCancel`): hisob-fakturani
 * bittalab bekor qilishdagi bilan AYNI shart. Busiz davrni orqa sana bilan
 * yopish o'tgan oylar qarzini o'chirib yuboradigan yo'l bo'lib qolardi.
 * Joriy oy esa davr huquqining o'zi: hisob-faktura bor-yo'qligini aynan davr
 * hal qiladi (`enrollment` bo'limi shu uchun ham pulga tegadi).
 *
 * ⚠️ Davr umuman qolmasa — HECH NARSA: bo'sh ro'yxat "shu oyni qamramaydi"
 * EMAS, ma'lumot to'liq emasligi (`education.md` §3). Yopish va tahrirlash
 * bu holatga olib kelmaydi — bu himoya qavati.
 *
 * @param {string} studentId
 * @param {Array<object>} periods - YANGI holat (o'quvchining BARCHA davrlari)
 * @param {{allowPastCancel?: boolean}} options
 * @returns {Promise<{cancel: object[], blocked: object[]}>}
 */
const planUncoveredInvoices = async (studentId, periods, { allowPastCancel = false } = {}) => {
  if (!periods?.length) return { cancel: [], blocked: [] };

  const invoices = await prisma.monthlyInvoice.findMany({
    where: { studentId, status: { not: "cancelled" } },
    select: { id: true, month: true, amount: true, paidAmount: true, status: true },
    orderBy: [{ month: "asc" }, { id: "asc" }],
  });

  const current = currentMonthKey();
  const cancel = [];
  const blocked = [];

  for (const invoice of invoices) {
    if (resolveEnrollmentForMonth(periods, invoice.month).enrolled) continue;
    (invoice.month < current && !allowPastCancel ? blocked : cancel).push(invoice);
  }

  return { cancel, blocked };
};

/**
 * `planUncoveredInvoices` rejasini bajaradi.
 *
 * ⚠️ BITTALIK `cancelInvoice` ORQALI, mustaqil SQL yozilmaydi: to'lov tushgan
 * oyning puli depozitga qaytishi, boshqa ochiq oylarga yechilishi va lock
 * tartibi faqat o'sha yo'lda bor (`cancelMonth` doktrinasi). Har oy o'z
 * tranzaksiyasida — bittasi yiqilsa qolganlari baribir bekor bo'ladi.
 *
 * Chaqiruvchi davr yozuvi COMMIT bo'lgandan KEYIN chaqiradi: oylik pass
 * bekor qilingan oyni tiklashdan oldin davrni qayta o'qiydi, ya'ni yangi
 * davr ko'rinib turgan paytda bekor qilingan oy qaytib kelmaydi.
 *
 * @param {string} studentId
 * @param {Array<object>} periods - YANGI holat
 * @param {{actorId: string|null, allowPastCancel?: boolean, reason: string}} options
 * @returns {Promise<{cancelled: object[], blocked: object[], failed: object[], releasedToDeposit: string, appliedToOthers: string}|null>}
 */
const cancelUncoveredInvoices = async (studentId, periods, { actorId, allowPastCancel, reason }) => {
  const { cancel, blocked } = await planUncoveredInvoices(studentId, periods, { allowPastCancel });
  if (cancel.length === 0 && blocked.length === 0) return null;

  // Lazy require: invoice.service shu servisni import qiladi (aylanma bog'liqlik)
  const { cancelInvoice } = require("./invoice.service");

  const cancelled = [];
  const failed = [];

  for (const invoice of cancel) {
    try {
      const result = await cancelInvoice(
        invoice.id,
        `${reason} — o'quvchi bu oyda o'qimaydi`,
        actorId,
      );
      cancelled.push({
        ...serializeImpactInvoice(invoice),
        releasedToDeposit: result.releasedToDeposit,
        appliedToOthers: result.appliedToOthers,
      });
    } catch (error) {
      failed.push({ ...serializeImpactInvoice(invoice), reason: error.message });
    }
  }

  if (cancelled.length > 0) {
    logger.warn(
      `[enrollment] Davr qamramaydigan hisob-fakturalar bekor qilindi: student=${studentId} ` +
        `oylar=${cancelled.map((i) => i.month).join(",")} actor=${actorId} sabab="${reason}"`,
    );
  }

  return {
    cancelled,
    blocked: blocked.map(serializeImpactInvoice),
    failed,
    releasedToDeposit: formatAmount(sumAmounts(cancelled.map((i) => i.releasedToDeposit))),
    appliedToOthers: formatAmount(sumAmounts(cancelled.map((i) => i.appliedToOthers))),
  };
};

/** Bekor qilinMAGAN qatorlar — admin qo'lda hal qilishi kerak bo'lgani. */
const describeImpactWarnings = (impact) => {
  if (!impact) return [];

  const warnings = [];
  const list = (rows) => rows.map((i) => `${i.monthLabel} (${i.amount})`).join(", ");

  if (impact.blocked.length) {
    warnings.push(
      `O'tgan oy hisob-fakturasi endi ortiqcha, lekin uni bekor qilish uchun ruxsatingiz ` +
        `yo'q — moliya bo'limi bekor qilsin: ${list(impact.blocked)}`,
    );
  }
  if (impact.failed.length) {
    warnings.push(
      `Bu hisob-fakturalar bekor qilinmadi — qo'lda bekor qiling: ` +
        impact.failed.map((i) => `${i.monthLabel} (${i.reason})`).join("; "),
    );
  }

  return warnings;
};

/** Muzlatilgan oylar davr tashqarisida qolib ketmasin (B5 doktrinasi). */
const collectFrozenWarnings = async (studentId, periods) => {
  const statuses = await prisma.studentFinanceStatus.findMany({
    where: { studentId, status: "frozen" },
    select: { startMonth: true, endMonth: true },
  });

  if (statuses.length === 0) return [];

  const orphaned = statuses.filter(
    (s) => !resolveEnrollmentForMonth(periods, s.startMonth).enrolled,
  );

  if (orphaned.length === 0) return [];

  return [
    `${orphaned.map((s) => formatMonthKey(s.startMonth)).join(", ")} — bu oylarda ` +
      "o'quvchi o'qimaydi, muzlatish esa belgilangan. Muzlatish ortiqcha: " +
      "vaqtinchalik tanaffus davr ICHIDA bo'ladi, maktabdan ketish esa davrni yopish bilan qayd etiladi.",
  ];
};

/**
 * Boshlang'ich oy summasi o'zgargach, o'quvchining TO'LANMAGAN hisob-fakturasini
 * avtomatik qayta shakllantiradi (best-effort). To'langan oylar muhrlangan.
 */
const autoRegen = async (studentId, fromMonth) => {
  try {
    const { regenerateForStudents } = require("./invoice.service");
    await regenerateForStudents([studentId], { fromMonth });
  } catch (error) {
    logger.warn(`[auto-regen] ${error.message}`);
  }
};

// ─────────────────────────────────────────────
// Yozish
// ─────────────────────────────────────────────

/**
 * Yangi o'qish davri.
 *
 * O'TGAN sanadan boshlash `allowPast` talab qiladi (controller `finance.adjust`
 * bilan tekshiradi): retro-sana narx kutilmasini jimgina o'zgartiradi.
 *
 * @param {object} data - { studentId, startDate, endDate, endReason, reason, note }
 * @param {string} userId
 * @param {{allowPast?: boolean}} options
 * @returns {Promise<object>}
 */
const createEnrollment = async (data, userId, { allowPast = false } = {}) => {
  if (!data.studentId) throw new BadRequestError("O'quvchi tanlanmagan");

  const period = parseEnrollmentPeriod(data.startDate, data.endDate);
  const endReason = parseEndReason(data.endReason);
  const student = await assertStudent(data.studentId);

  // Birinchi oy summasi — qo'lda (ixtiyoriy). `firstMonthKey` (to'lov oyi)
  // hisob-fakturasini override qiladi (invoiceBuilder). null bo'lsa — odatiy.
  const firstMonthAmount =
    data.firstMonthAmount != null && String(data.firstMonthAmount).trim() !== ""
      ? parseAmount(data.firstMonthAmount, "Birinchi oy summasi")
      : null;
  const firstMonthKey = parseOptionalMonthKey(data.firstMonthKey, "To'lov oyi");

  if (period.endDate != null && endReason == null) {
    throw new BadRequestError("Tugash sanasi bilan birga ketish sababi ham tanlanishi kerak");
  }

  if (!allowPast && monthKeyOfDate(period.startDate) < currentMonthKey()) {
    throw new BadRequestError(
      "O'tgan oydan boshlanadigan o'qish davri qo'shish uchun alohida ruxsat kerak",
    );
  }

  try {
    const row = await prisma.$transaction(async (tx) => {
      await assertNoSecondOpenPeriod(tx, data.studentId, period.endDate);
      await assertNoOverlap(tx, data.studentId, period);

      return tx.studentEnrollment.create({
        data: {
          studentId: data.studentId,
          ...period,
          firstMonthAmount,
          firstMonthKey,
          endReason,
          reason: data.reason?.trim() || "",
          note: data.note?.trim() || "",
          createdBy: userId,
        },
      });
    });

    const periods = await getPeriodsForStudent(data.studentId);
    const warnings = [
      ...(await collectInvoiceWarnings(data.studentId, periods)),
      ...(await collectFrozenWarnings(data.studentId, periods)),
    ];

    logger.info(
      `[enrollment] Davr ochildi: student=${data.studentId} ` +
        `${formatDay(period.startDate)} → ${formatDay(period.endDate)} actor=${userId}`,
    );

    return { ...serializeEnrollment(row, { student }), warnings };
  } catch (error) {
    return rethrowDuplicate(
      error,
      `O'quvchida ${formatDay(period.startDate)} dan boshlanadigan davr allaqachon bor`,
    );
  }
};

/**
 * Tahrirlangan davrning sanalari (o'zgarmagan maydon — qatordagi qiymat).
 * Yozuv ham, oldindan ko'rish ham shundan o'qiydi.
 */
const resolveEditedDates = (row, data) => {
  const startDate =
    data.startDate !== undefined ? parseDayDate(data.startDate, "Boshlanish sanasi") : row.startDate;
  const endDate =
    data.endDate !== undefined
      ? parseOptionalDayDate(data.endDate, "Tugash sanasi")
      : row.endDate;

  if (endDate != null && endDate < startDate) {
    throw new BadRequestError("Tugash sanasi boshlanish sanasidan oldin bo'lishi mumkin emas");
  }

  return { startDate, endDate };
};

/**
 * Davr o'zgarsa hisob-fakturalar bilan NIMA bo'lishini oldindan aytadi —
 * yopish va tahrirlash oynasi saqlashdan OLDIN ko'rsatadi.
 *
 * Sabab: ketish oyi TO'LIQ to'lanadi va "oxirgi o'qigan kun" 1-oktabr bo'lsa,
 * oktabr ham to'lanadi. "1-sentabrdan 1-oktabrgacha o'qidi" deb o'ylagan
 * admin buni faqat moliyada qarz paydo bo'lgandan keyin bilardi.
 *
 * Hech narsa yozmaydi. Bekor qilinadiganlar ro'yxati yozuvdagi bilan AYNI
 * funksiyadan (`planUncoveredInvoices`).
 *
 * @param {string} id
 * @param {{startDate?: string, endDate?: string|null}} data
 * @param {{allowPastCancel?: boolean}} options
 * @returns {Promise<object>}
 */
const previewEnrollmentChange = async (id, data, { allowPastCancel = false } = {}) => {
  const row = await prisma.studentEnrollment.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("O'qish davri topilmadi");

  const { startDate, endDate } = resolveEditedDates(row, data);
  const periods = (await getPeriodsForStudent(row.studentId)).map((period) =>
    period.id === id ? { ...period, startDate, endDate } : period,
  );

  const { cancel, blocked } = await planUncoveredInvoices(row.studentId, periods, {
    allowPastCancel,
  });

  // Ketish oyi — "oxirgi o'qigan kun" tushgan oy, TO'LIQ to'lanadi
  let lastMonth = null;
  let previousMonthEnd = null;

  if (endDate != null) {
    const month = monthKeyOfDate(endDate);
    const invoice = await prisma.monthlyInvoice.findFirst({
      where: { studentId: row.studentId, month, status: { not: "cancelled" } },
      select: { id: true, month: true, amount: true, paidAmount: true, status: true },
    });

    lastMonth = {
      month,
      monthLabel: formatMonthKey(month),
      invoice: invoice ? serializeImpactInvoice(invoice) : null,
    };

    // "Bu oyda umuman o'qimagan bo'lsa" — oldingi oyning oxirgi kuni. Sana
    // allaqachon oy oxiri bo'lsa yoki davr boshlanishidan oldin qolsa — yo'q.
    const candidate = monthEndDate(prevMonth(month));
    if (
      endDate.getTime() !== monthEndDate(month).getTime() &&
      candidate >= startDate
    ) {
      previousMonthEnd = formatDay(candidate);
    }
  }

  return {
    startDate: formatDay(startDate),
    endDate: endDate ? formatDay(endDate) : null,
    lastMonth,
    previousMonthEnd,
    cancel: cancel.map(serializeImpactInvoice),
    blocked: blocked.map(serializeImpactInvoice),
    releasedToDeposit: formatAmount(sumAmounts(cancel.map((i) => i.paidAmount))),
  };
};

/**
 * Davrni tahrirlaydi.
 *
 * Davr endi qamramaydigan oylarning hisob-fakturalari shu yerda bekor
 * qilinadi (`cancelUncoveredInvoices`) — yopish ham shu yo'ldan o'tadi.
 *
 * @param {string} id
 * @param {object} data
 * @param {{allowPast?: boolean, allowPastCancel?: boolean, actorId?: string|null}} options
 * @returns {Promise<object>}
 */
const updateEnrollment = async (
  id,
  data,
  { allowPast = false, allowPastCancel = false, actorId = null } = {},
) => {
  const row = await prisma.studentEnrollment.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("O'qish davri topilmadi");

  const { startDate, endDate } = resolveEditedDates(row, data);

  if (
    !allowPast &&
    data.startDate !== undefined &&
    monthKeyOfDate(startDate) < currentMonthKey()
  ) {
    throw new BadRequestError(
      "Boshlanish sanasini o'tgan oyga ko'chirish uchun alohida ruxsat kerak",
    );
  }

  const payload = { startDate, endDate };
  if (data.endReason !== undefined) payload.endReason = parseEndReason(data.endReason);
  if (data.reason !== undefined) payload.reason = data.reason?.trim() || "";
  if (data.note !== undefined) payload.note = data.note?.trim() || "";

  // Boshlang'ich (birinchi oy) summasi va to'lov oyi — tahrirlash mumkin.
  // Bo'sh yuborilsa (null/"") tozalanadi → odatiy hisobga qaytadi.
  if (data.firstMonthAmount !== undefined) {
    payload.firstMonthAmount =
      data.firstMonthAmount != null && String(data.firstMonthAmount).trim() !== ""
        ? parseAmount(data.firstMonthAmount, "Birinchi oy summasi")
        : null;
  }
  if (data.firstMonthKey !== undefined) {
    payload.firstMonthKey = parseOptionalMonthKey(data.firstMonthKey, "To'lov oyi");
  }

  if (payload.endDate != null && (payload.endReason ?? row.endReason) == null) {
    throw new BadRequestError("Tugash sanasi bilan birga ketish sababi ham tanlanishi kerak");
  }
  // Davr qayta ochilsa sabab ham tozalanadi
  if (payload.endDate == null) payload.endReason = null;

  try {
    await prisma.$transaction(async (tx) => {
      await assertNoSecondOpenPeriod(tx, row.studentId, payload.endDate, id);
      await assertNoOverlap(tx, row.studentId, payload, id);
      return tx.studentEnrollment.update({ where: { id }, data: payload });
    });

    const periods = await getPeriodsForStudent(row.studentId);

    // Davr endi qamramaydigan oylar BIRINCHI bekor qilinadi: quyidagi
    // qayta shakllantirish ularni "o'quvchi bu oyda o'qimagan" deb rad etib,
    // logni to'ldirardi xolos.
    // ⚠️ Davr allaqachon COMMIT bo'lgan: bu bosqich yiqilsa javob xato bo'lib
    // qaytmasin — admin "yopilmadi" deb qayta bosib, "allaqachon yopilgan"
    // xatosiga urilardi. Yiqilgani ogohlantirish bilan aytiladi.
    const closing = row.endDate == null && payload.endDate != null;
    let invoiceImpact = null;
    const impactErrors = [];
    try {
      invoiceImpact = await cancelUncoveredInvoices(row.studentId, periods, {
        actorId,
        allowPastCancel,
        reason: closing ? "O'qish davri yopildi" : "O'qish davri o'zgartirildi",
      });
    } catch (error) {
      logger.error(
        `[enrollment] Davr qamramaydigan hisob-fakturalar bekor qilinmadi: ` +
          `student=${row.studentId} — ${error.message}`,
      );
      impactErrors.push(
        "Davr saqlandi, lekin ortiqcha hisob-fakturalarni tekshirib bo'lmadi — " +
          "oynani qayta ochib saqlang yoki moliyada qo'lda bekor qiling",
      );
    }

    // Boshlang'ich oy summasi/oyi o'zgarsa — o'sha oyning to'lanmagan
    // hisob-fakturasi avtomatik yangilanadi. Kirish sanasi o'zgarib ulush
    // o'zgargan oylar esa ogohlantirish bilan aytiladi (summa muhrlangan).
    if (data.firstMonthAmount !== undefined || data.firstMonthKey !== undefined) {
      await autoRegen(row.studentId, monthKeyOfDate(startDate));
    }

    const warnings = [
      ...impactErrors,
      ...describeImpactWarnings(invoiceImpact),
      ...(await collectInvoiceWarnings(row.studentId, periods)),
      ...(await collectFrozenWarnings(row.studentId, periods)),
    ];

    logger.info(
      `[enrollment] Davr tahrirlandi: id=${id} student=${row.studentId} ` +
        `${formatDay(payload.startDate)} → ${formatDay(payload.endDate)}`,
    );

    const fresh = await getEnrollmentById(id);
    return { ...fresh, warnings, invoiceImpact };
  } catch (error) {
    return rethrowDuplicate(
      error,
      "O'quvchida shu sanadan boshlanadigan davr allaqachon bor",
    );
  }
};

/**
 * Davrni yopadi — "o'quvchi maktabdan ketdi".
 *
 * Ketish oyi (`endDate` oyi) TO'LIQ to'lanadi; undan keyingi oylarga
 * allaqachon chiqarilgan hisob-fakturalar bekor qilinadi (`updateEnrollment`).
 *
 * @param {string} id
 * @param {object} data - { endDate, endReason, reason }
 * @param {{allowPast?: boolean, allowPastCancel?: boolean, actorId?: string|null}} options
 * @returns {Promise<object>}
 */
const closeEnrollment = async (id, data, options = {}) => {
  const row = await prisma.studentEnrollment.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("O'qish davri topilmadi");
  if (row.endDate != null) throw new BadRequestError("Bu davr allaqachon yopilgan");

  const endReason = parseEndReason(data.endReason);
  if (!endReason) throw new BadRequestError("Ketish sababi tanlanmagan");

  return updateEnrollment(
    id,
    { endDate: data.endDate, endReason, reason: data.reason },
    options,
  );
};

/**
 * Davrni o'chiradi.
 *
 * ⚠️ Davr qamragan oylarda hisob-faktura bo'lsa BLOKLANADI: o'chirish
 * o'quvchini "davri yo'q = abadiy o'qiydi" holatiga qaytaradi va o'tgan
 * proratsiya qilingan hisob-fakturalar tushuntirib bo'lmaydigan bo'lib
 * qoladi. Yopish — to'g'ri yo'l (`deleteStatus` bilan bir xil doktrina).
 *
 * @param {string} id
 * @returns {Promise<{message: string}>}
 */
const deleteEnrollment = async (id) => {
  const row = await prisma.studentEnrollment.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("O'qish davri topilmadi");

  const count = await prisma.monthlyInvoice.count({
    where: {
      studentId: row.studentId,
      status: { not: "cancelled" },
      month: {
        gte: monthKeyOfDate(row.startDate),
        ...(row.endDate ? { lte: monthKeyOfDate(row.endDate) } : {}),
      },
    },
  });

  if (count > 0) {
    throw new BadRequestError(
      `Bu davr qamragan oylarda ${count} ta hisob-faktura bor — o'chirib bo'lmaydi. ` +
        "Uni yoping yoki sanalarni to'g'rilang.",
    );
  }

  await prisma.studentEnrollment.delete({ where: { id } });

  logger.info(`[enrollment] Davr o'chirildi: id=${id} student=${row.studentId}`);

  return { message: "O'qish davri o'chirildi" };
};

module.exports = {
  END_REASONS,
  END_REASON_LABELS,
  serializeEnrollment,
  resolveEnrollmentsForStudents,
  getPeriodsForStudent,
  getStudentEnrollments,
  getEnrollments,
  getEnrollmentById,
  planUncoveredInvoices,
  previewEnrollmentChange,
  createEnrollment,
  updateEnrollment,
  closeEnrollment,
  deleteEnrollment,
};
