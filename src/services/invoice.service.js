/**
 * Oylik to'lov majburiyatlarini o'qish va boshqarish.
 *
 * QAYTARILMASLIK QOIDASI shu faylda muhrlangan: `amount` ni o'zgartiradigan
 * funksiya YO'Q — na update, na patch, na "qayta hisoblash". Narx keyin
 * to'g'rilansa, tuzatish keyingi oydan amal qiladi (TariffVersion doktrinasi).
 * Yagona olib tashlash yo'li — `cancelled` holati, sabab va aktyor bilan;
 * to'lov qilingan majburiyat esa umuman bekor qilinmaydi.
 *
 * Ro'yxatlar `User` ga INNER JOIN qilmaydi: o'quvchilar alohida Map'ga
 * yuklanadi va topilmasa `studentSnapshot` ishlatiladi. Aks holda arxivlangan
 * o'quvchining qarzi har qanday moliyaviy hisobotdan yo'qolardi.
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
  parseMonthKey,
  parseOptionalMonthKey,
  formatMonthKey,
} = require("../helpers/month.helpers");
const { Decimal, formatAmount } = require("../helpers/money.helpers");
const {
  describeAcademicMonth,
  academicYearBounds,
  academicYearOf,
} = require("../helpers/academicYear.helpers");
const { getFinanceSettings } = require("./settings.service");
const { resolveStatusForStudent } = require("./studentFinanceStatus.service");
const { resolveForStudentMonth } = require("./tariffResolution.service");

const STATUS_LABELS = {
  unpaid: "To'lanmagan",
  partial: "Qisman to'langan",
  paid: "To'langan",
  cancelled: "Bekor qilingan",
};

const METHOD_LABELS = {
  cash: "Naqd",
  card: "Plastik",
  transfer: "O'tkazma",
  other: "Boshqa",
};

const STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  isArchived: true,
};

const serializePayment = (payment) => ({
  ...payment,
  amount: formatAmount(payment.amount),
  methodLabel: METHOD_LABELS[payment.method] ?? payment.method,
});

/**
 * Hisob-fakturani javob shakliga keltiradi. `debt` doim hisoblanadi —
 * frontend summalar ustida arifmetika qilmasligi kerak.
 */
const serializeInvoice = (invoice, { student } = {}) => {
  const { payments, ...rest } = invoice;
  const debt = new Decimal(invoice.amount).minus(invoice.paidAmount);

  return {
    ...rest,
    amount: formatAmount(invoice.amount),
    paidAmount: formatAmount(invoice.paidAmount),
    // Ortiqcha to'lov rad etiladi, lekin eski ma'lumot uchun manfiyni kesamiz
    debt: formatAmount(debt.isNegative() ? new Decimal(0) : debt),
    monthLabel: formatMonthKey(invoice.month),
    statusLabel: STATUS_LABELS[invoice.status] ?? invoice.status,
    // O'quvchi o'chirilgan/arxivlangan bo'lishi mumkin — snapshot qutqaradi
    student: student ?? null,
    studentName:
      student != null
        ? `${student.firstName} ${student.lastName ?? ""}`.trim()
        : `${invoice.studentSnapshot?.firstName ?? ""} ${
            invoice.studentSnapshot?.lastName ?? ""
          }`.trim() || "Noma'lum",
    ...(payments ? { payments: payments.map(serializePayment) } : {}),
  };
};

// ─────────────────────────────────────────────
// Filtr
// ─────────────────────────────────────────────

/**
 * Query paramlaridan Prisma `where` quradi.
 * `academicYear` oy oralig'iga aylantiriladi — shunda [month, status] indeksi
 * ishlaydi va academicYear uchun alohida indeks kerak bo'lmaydi.
 */
const buildInvoiceFilter = async (query, settings) => {
  const filter = {};

  if (query.month) {
    filter.month = parseMonthKey(query.month, "Oy");
  } else if (query.academicYear) {
    const bounds = academicYearBounds(Number(query.academicYear), settings);
    filter.month = { gte: bounds.startMonth, lte: bounds.endMonth };
  } else {
    const from = parseOptionalMonthKey(query.fromMonth, "Boshlanish oyi");
    const to = parseOptionalMonthKey(query.toMonth, "Tugash oyi");
    if (from != null || to != null) {
      filter.month = { ...(from != null ? { gte: from } : {}), ...(to != null ? { lte: to } : {}) };
    }
  }

  if (query.studentId) filter.studentId = query.studentId;

  if (query.status) {
    if (!STATUS_LABELS[query.status]) throw new BadRequestError("Holat noto'g'ri");
    filter.status = query.status;
  } else if (query.debtOnly === "true") {
    filter.status = { in: ["unpaid", "partial"] };
  } else if (query.includeCancelled !== "true") {
    filter.status = { not: "cancelled" };
  }

  const search = query.search?.trim();
  if (query.classId || search) {
    const students = await prisma.user.findMany({
      where: {
        role: ROLES.STUDENT,
        ...(query.classId ? { classes: { some: { classId: query.classId } } } : {}),
        ...(search
          ? {
              OR: [
                { firstName: { contains: search, mode: "insensitive" } },
                { lastName: { contains: search, mode: "insensitive" } },
                { username: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: { id: true },
    });

    const ids = query.studentId
      ? students.map((s) => s.id).filter((id) => id === query.studentId)
      : students.map((s) => s.id);

    filter.studentId = { in: ids };
  }

  return filter;
};

/** O'quvchilarni alohida yuklab, Map qaytaradi (inner join O'RNIGA). */
const loadStudentMap = async (invoices) => {
  const ids = [...new Set(invoices.map((i) => i.studentId))];
  if (ids.length === 0) return new Map();

  const students = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: STUDENT_SELECT,
  });

  return new Map(students.map((s) => [s.id, s]));
};

// ─────────────────────────────────────────────
// O'qish
// ─────────────────────────────────────────────

/**
 * Hisob-fakturalar ro'yxati. `totals` — butun filtr bo'yicha (joriy sahifa
 * emas), shuning uchun agregatsiya alohida so'rov bilan olinadi.
 *
 * @param {object} req
 * @returns {Promise<object>}
 */
const getInvoices = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const settings = await getFinanceSettings();
  const filter = await buildInvoiceFilter(req.query, settings);

  // `studentId: { in: [] }` — hech kim topilmadi, bo'sh sahifa
  if (filter.studentId?.in?.length === 0) {
    return {
      ...formatPaginationResponse([], 0, page, limit),
      totals: { count: 0, totalAmount: "0.00", totalPaid: "0.00", totalDebt: "0.00" },
    };
  }

  const [rows, total, agg] = await Promise.all([
    prisma.monthlyInvoice.findMany({
      where: filter,
      orderBy: [{ month: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    prisma.monthlyInvoice.count({ where: filter }),
    prisma.monthlyInvoice.aggregate({
      where: filter,
      _sum: { amount: true, paidAmount: true },
    }),
  ]);

  const studentMap = await loadStudentMap(rows);

  const totalAmount = new Decimal(agg._sum.amount ?? 0);
  const totalPaid = new Decimal(agg._sum.paidAmount ?? 0);

  return {
    ...formatPaginationResponse(
      rows.map((row) => serializeInvoice(row, { student: studentMap.get(row.studentId) })),
      total,
      page,
      limit,
    ),
    totals: {
      count: total,
      totalAmount: formatAmount(totalAmount),
      totalPaid: formatAmount(totalPaid),
      totalDebt: formatAmount(totalAmount.minus(totalPaid)),
    },
  };
};

/**
 * Bitta hisob-faktura — to'lovlari bilan.
 * @param {string} id
 * @param {{includeVoided?: boolean}} options
 * @returns {Promise<object>}
 */
const getInvoiceById = async (id, { includeVoided = false } = {}) => {
  const invoice = await prisma.monthlyInvoice.findUnique({
    where: { id },
    include: {
      payments: {
        where: includeVoided ? {} : { isVoided: false },
        orderBy: { paidAt: "desc" },
      },
    },
  });

  if (!invoice) throw new NotFoundError("Hisob-faktura topilmadi");

  const student = await prisma.user.findUnique({
    where: { id: invoice.studentId },
    select: STUDENT_SELECT,
  });

  return serializeInvoice(invoice, { student });
};

/**
 * Bitta o'quvchining hisob-fakturalari (admin foydalanuvchi detali va
 * o'quvchining o'z sahifasi uchun umumiy yadro).
 *
 * @param {string} studentId
 * @param {{academicYear?: number, includeCancelled?: boolean}} options
 * @returns {Promise<object>}
 */
const getStudentInvoices = async (studentId, options = {}) => {
  const settings = await getFinanceSettings();
  const month = currentMonthKey();

  const academicYear =
    options.academicYear != null && options.academicYear !== ""
      ? Number(options.academicYear)
      : academicYearOf(month, settings);

  const bounds = academicYearBounds(academicYear, settings);

  const where = {
    studentId,
    month: { gte: bounds.startMonth, lte: bounds.endMonth },
    ...(options.includeCancelled ? {} : { status: { not: "cancelled" } }),
  };

  const [rows, agg, statusInfo] = await Promise.all([
    prisma.monthlyInvoice.findMany({
      where,
      orderBy: { month: "desc" },
      include: { payments: { where: { isVoided: false }, orderBy: { paidAt: "desc" } } },
    }),
    prisma.monthlyInvoice.aggregate({
      where,
      _sum: { amount: true, paidAmount: true },
    }),
    resolveStatusForStudent(studentId, month),
  ]);

  const invoiced = new Decimal(agg._sum.amount ?? 0);
  const paid = new Decimal(agg._sum.paidAmount ?? 0);
  const debt = invoiced.minus(paid);

  return {
    academicYear,
    academicYearLabel: `${academicYear}/${academicYear + 1}`,
    academicMonthCount: settings.academicMonthCount,
    currentMonth: month,
    currentMonthLabel: formatMonthKey(month),
    ...describeAcademicMonth(month, settings),
    financeStatus: {
      status: statusInfo.status,
      statusLabel: statusInfo.statusLabel,
      startMonth: statusInfo.row?.startMonth ?? null,
      endMonth: statusInfo.row?.endMonth ?? null,
      reason: statusInfo.row?.reason ?? "",
    },
    totals: {
      invoiced: formatAmount(invoiced),
      paid: formatAmount(paid),
      debt: formatAmount(debt.isNegative() ? new Decimal(0) : debt),
      unpaidCount: rows.filter((r) => r.status !== "paid").length,
    },
    invoices: rows.map((row) => serializeInvoice(row)),
  };
};

/**
 * O'quvchining o'z moliyaviy manzarasi (student panel).
 * `studentId` HAR DOIM `req.user.id` dan keladi — query'dan hech qachon emas.
 *
 * @param {string} studentId
 * @param {object} options
 * @returns {Promise<object>}
 */
const getMyFinance = async (studentId, options = {}) => {
  const [student, data] = await Promise.all([
    prisma.user.findUnique({
      where: { id: studentId },
      select: {
        ...STUDENT_SELECT,
        classes: { select: { class: { select: { id: true, name: true } } } },
      },
    }),
    getStudentInvoices(studentId, options),
  ]);

  if (!student) throw new NotFoundError("O'quvchi topilmadi");

  // Joriy oydagi tarif va narx — hisob-faktura hali shakllanmagan bo'lsa ham
  // o'quvchi nimaga qarzdor bo'lishini ko'rishi kerak.
  const resolved = await resolveForStudentMonth(studentId, data.currentMonth);
  const item = resolved.items[0] ?? null;

  return {
    student: {
      id: student.id,
      fullName: `${student.firstName} ${student.lastName ?? ""}`.trim(),
      username: student.username,
      className: student.classes[0]?.class?.name ?? null,
    },
    tariff: item
      ? { id: item.tariff.id, name: item.tariff.name, monthlyAmount: item.amount }
      : null,
    tariffReason: resolved.reason,
    ...data,
  };
};

/**
 * Oylik yig'ma ma'lumot — admin ekranidagi kartalar va "shakllantirish
 * mumkinmi?" savoli uchun.
 *
 * @param {number|string} monthInput
 * @returns {Promise<object>}
 */
const getSummary = async (monthInput) => {
  const settings = await getFinanceSettings();
  const month = monthInput ? parseMonthKey(monthInput, "Oy") : currentMonthKey();
  const academic = describeAcademicMonth(month, settings);

  const grouped = await prisma.monthlyInvoice.groupBy({
    by: ["status"],
    where: { month },
    _count: { _all: true },
    _sum: { amount: true, paidAmount: true },
  });

  const counts = { unpaid: 0, partial: 0, paid: 0, cancelled: 0 };
  let totalAmount = new Decimal(0);
  let totalPaid = new Decimal(0);

  for (const row of grouped) {
    counts[row.status] = row._count._all;
    // Bekor qilingan summalar jami qarzga kirmaydi
    if (row.status === "cancelled") continue;
    totalAmount = totalAmount.plus(row._sum.amount ?? 0);
    totalPaid = totalPaid.plus(row._sum.paidAmount ?? 0);
  }

  const invoicedCount = counts.unpaid + counts.partial + counts.paid;

  return {
    month,
    monthLabel: formatMonthKey(month),
    ...academic,
    canGenerate: academic.isAcademicMonth && month <= currentMonthKey(),
    counts: { ...counts, invoiced: invoicedCount },
    totals: {
      amount: formatAmount(totalAmount),
      paid: formatAmount(totalPaid),
      debt: formatAmount(totalAmount.minus(totalPaid)),
    },
  };
};

// ─────────────────────────────────────────────
// Yozish (summa TEGILMAYDI)
// ─────────────────────────────────────────────

/**
 * Faqat izohni yangilaydi. Summa, oy, o'quvchi va snapshot o'zgarmas.
 * @param {string} id
 * @param {string} note
 * @returns {Promise<object>}
 */
const updateNote = async (id, note) => {
  const invoice = await prisma.monthlyInvoice.findUnique({ where: { id } });
  if (!invoice) throw new NotFoundError("Hisob-faktura topilmadi");

  await prisma.monthlyInvoice.update({
    where: { id },
    data: { note: note?.trim() || "" },
  });

  return getInvoiceById(id);
};

/**
 * Hisob-fakturani bekor qiladi — yagona "o'chirish" yo'li.
 *
 * To'lov qilingan majburiyat bekor qilinmaydi: pul olingan qarzni yo'q qilib
 * bo'lmaydi, avval to'lovlar bekor qilinishi kerak (o'zi alohida ruxsat).
 *
 * @param {string} id
 * @param {string} reason
 * @param {string} userId
 * @returns {Promise<object>}
 */
const cancelInvoice = async (id, reason, userId) => {
  const invoice = await prisma.monthlyInvoice.findUnique({ where: { id } });
  if (!invoice) throw new NotFoundError("Hisob-faktura topilmadi");

  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError("Bekor qilish sababi majburiy");

  if (invoice.status === "cancelled") {
    throw new BadRequestError("Hisob-faktura allaqachon bekor qilingan");
  }

  if (new Decimal(invoice.paidAmount).greaterThan(0)) {
    throw new BadRequestError(
      "To'lov qabul qilingan hisob-fakturani bekor qilib bo'lmaydi. Avval to'lovlarni bekor qiling.",
    );
  }

  if (invoice.month < currentMonthKey()) {
    logger.warn(
      `[invoices] O'tgan oy hisob-fakturasi bekor qilindi: invoice=${id} ` +
        `student=${invoice.studentId} month=${invoice.month} actor=${userId} sabab="${trimmed}"`,
    );
  }

  await prisma.monthlyInvoice.update({
    where: { id },
    data: {
      status: "cancelled",
      cancelReason: trimmed,
      cancelledAt: new Date(),
      cancelledBy: userId,
    },
  });

  return getInvoiceById(id);
};

/**
 * Bekor qilingan hisob-fakturani qaytaradi. Butun tarix bitta qatorda qoladi —
 * o'chirib qayta yaratish o'rniga.
 *
 * @param {string} id
 * @param {string} userId
 * @returns {Promise<object>}
 */
const restoreInvoice = async (id, userId) => {
  const invoice = await prisma.monthlyInvoice.findUnique({ where: { id } });
  if (!invoice) throw new NotFoundError("Hisob-faktura topilmadi");

  if (invoice.status !== "cancelled") {
    throw new BadRequestError("Hisob-faktura bekor qilinmagan");
  }

  const paid = new Decimal(invoice.paidAmount);
  const amount = new Decimal(invoice.amount);
  const status = paid.lessThanOrEqualTo(0)
    ? "unpaid"
    : paid.greaterThanOrEqualTo(amount)
      ? "paid"
      : "partial";

  logger.warn(
    `[invoices] Bekor qilingan hisob-faktura qaytarildi: invoice=${id} actor=${userId}`,
  );

  await prisma.monthlyInvoice.update({
    where: { id },
    data: { status, cancelReason: "", cancelledAt: null, cancelledBy: null },
  });

  return getInvoiceById(id);
};

module.exports = {
  STATUS_LABELS,
  METHOD_LABELS,
  serializeInvoice,
  serializePayment,
  getInvoices,
  getInvoiceById,
  getStudentInvoices,
  getMyFinance,
  getSummary,
  updateNote,
  cancelInvoice,
  restoreInvoice,
};
