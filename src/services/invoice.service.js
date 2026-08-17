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
  billableMonthsOfYear,
  describeBillableMonth,
} = require("../helpers/academicYear.helpers");
const { deriveStatus } = require("../helpers/allocation.helpers");
const { applyDiscounts } = require("../helpers/discount.helpers");
const { getFinanceSettings } = require("./settings.service");
const {
  resolveStatusForStudent,
  resolveStatusesForMonth,
} = require("./studentFinanceStatus.service");
const {
  resolveForStudentMonth,
  resolveManyForMonth,
} = require("./tariffResolution.service");
const {
  resolveDiscountsForStudent,
  resolveDiscountsForMonth,
} = require("./studentDiscount.service");
const { getVacationSet } = require("./vacationMonth.service");
const { getInvoiceAllocations, TX_OPTIONS } = require("./payment.service");
const {
  releaseInvoiceAllocations,
  getBalance,
  getBalances,
  getMovements,
} = require("./studentAccount.service");

const STATUS_LABELS = {
  unpaid: "To'lanmagan",
  partial: "Qisman to'langan",
  paid: "To'langan",
  cancelled: "Bekor qilingan",
};

const STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  isArchived: true,
};

/**
 * Hisob-fakturani javob shakliga keltiradi. `debt` doim hisoblanadi —
 * frontend summalar ustida arifmetika qilmasligi kerak.
 */
const serializeInvoice = (invoice, { student, payments } = {}) => {
  const { allocations, ...rest } = invoice;
  const debt = new Decimal(invoice.amount).minus(invoice.paidAmount);
  const discount = new Decimal(invoice.discountAmount ?? 0);

  return {
    ...rest,
    baseAmount: formatAmount(invoice.baseAmount),
    discountAmount: formatAmount(discount),
    hasDiscount: discount.greaterThan(0),
    amount: formatAmount(invoice.amount),
    paidAmount: formatAmount(invoice.paidAmount),
    // Ortiqcha to'lov depozitga tushadi, shuning uchun bu yerda manfiy
    // bo'lmasligi kerak — lekin himoya qavati qoladi
    debt: formatAmount(debt.isNegative() ? new Decimal(0) : debt),
    monthLabel: formatMonthKey(invoice.month),
    statusLabel: STATUS_LABELS[invoice.status] ?? invoice.status,
    // "8 oydan 5-si" — ta'til hisobga olingan holda
    billableLabel:
      invoice.billableIndex != null
        ? `${invoice.billableMonthCount} oydan ${invoice.billableIndex}-si`
        : null,
    // O'quvchi o'chirilgan/arxivlangan bo'lishi mumkin — snapshot qutqaradi
    student: student ?? null,
    studentName:
      student != null
        ? `${student.firstName} ${student.lastName ?? ""}`.trim()
        : `${invoice.studentSnapshot?.firstName ?? ""} ${
            invoice.studentSnapshot?.lastName ?? ""
          }`.trim() || "Noma'lum",
    ...(allocations
      ? {
          allocations: allocations.map((a) => ({
            ...a,
            amount: formatAmount(a.amount),
          })),
        }
      : {}),
    ...(payments ? { payments } : {}),
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
  const invoice = await prisma.monthlyInvoice.findUnique({ where: { id } });
  if (!invoice) throw new NotFoundError("Hisob-faktura topilmadi");

  const [student, payments] = await Promise.all([
    prisma.user.findUnique({
      where: { id: invoice.studentId },
      select: STUDENT_SELECT,
    }),
    getInvoiceAllocations(id, { includeVoided }),
  ]);

  return serializeInvoice(invoice, { student, payments });
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

  const [rows, agg, statusInfo, vacationSet, balance] = await Promise.all([
    prisma.monthlyInvoice.findMany({ where, orderBy: { month: "desc" } }),
    prisma.monthlyInvoice.aggregate({
      where,
      _sum: { amount: true, paidAmount: true, baseAmount: true, discountAmount: true },
    }),
    resolveStatusForStudent(studentId, month),
    getVacationSet(academicYear),
    getBalance(studentId),
  ]);

  // To'lovlar chek raqami bilan — har bir hisob-faktura uchun alohida
  // so'rov emas, bittasida
  const payments = rows.length
    ? await prisma.paymentAllocation.findMany({
        where: { invoiceId: { in: rows.map((r) => r.id) }, isVoided: false },
        orderBy: { appliedAt: "desc" },
        include: { payment: { select: { receiptNo: true, paidAt: true, accountId: true } } },
      })
    : [];

  const paymentsByInvoice = new Map();
  for (const allocation of payments) {
    if (!paymentsByInvoice.has(allocation.invoiceId)) {
      paymentsByInvoice.set(allocation.invoiceId, []);
    }
    paymentsByInvoice.get(allocation.invoiceId).push({
      id: allocation.id,
      amount: formatAmount(allocation.amount),
      source: allocation.source,
      appliedAt: allocation.appliedAt,
      paymentId: allocation.paymentId,
      receiptNo: allocation.payment.receiptNo,
      receiptLabel: `#${String(allocation.payment.receiptNo).padStart(6, "0")}`,
      paidAt: allocation.payment.paidAt,
    });
  }

  const invoiced = new Decimal(agg._sum.amount ?? 0);
  const paid = new Decimal(agg._sum.paidAmount ?? 0);
  const debt = invoiced.minus(paid);

  // O'quv yilining TO'LIQ oylar jadvali — ta'til oylari ham ko'rinadi,
  // shunda "yanvarda nega hisob yo'q?" savoli tug'ilmaydi.
  const invoiceByMonth = new Map(rows.map((r) => [r.month, r]));
  const { months, billableMonthCount } = billableMonthsOfYear(
    academicYear,
    settings,
    vacationSet,
  );

  const timeline = months.map((entry) => {
    const invoice = invoiceByMonth.get(entry.month);

    return {
      month: entry.month,
      monthLabel: formatMonthKey(entry.month),
      academicIndex: entry.academicIndex,
      billableIndex: entry.billableIndex,
      isVacation: entry.isVacation,
      isFuture: entry.month > month,
      invoice: invoice
        ? serializeInvoice(invoice, { payments: paymentsByInvoice.get(invoice.id) ?? [] })
        : null,
    };
  });

  const paidMonths = rows.filter((r) => r.status === "paid").length;

  return {
    academicYear,
    academicYearLabel: `${academicYear}/${academicYear + 1}`,
    academicMonthCount: settings.academicMonthCount,
    billableMonthCount,
    vacationMonths: [...vacationSet].sort().map((m) => ({
      month: m,
      monthLabel: formatMonthKey(m),
    })),
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
    balance: formatAmount(balance),
    totals: {
      baseAmount: formatAmount(new Decimal(agg._sum.baseAmount ?? 0)),
      discountAmount: formatAmount(new Decimal(agg._sum.discountAmount ?? 0)),
      invoiced: formatAmount(invoiced),
      paid: formatAmount(paid),
      debt: formatAmount(debt.isNegative() ? new Decimal(0) : debt),
      unpaidCount: rows.filter((r) => r.status !== "paid").length,
      paidMonths,
      billableMonths: billableMonthCount,
    },
    timeline,
    invoices: rows.map((row) =>
      serializeInvoice(row, { payments: paymentsByInvoice.get(row.id) ?? [] }),
    ),
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

  // Joriy oydagi tarif, chegirma va narx — hisob-faktura hali shakllanmagan
  // bo'lsa ham o'quvchi nimaga qarzdor bo'lishini ko'rishi kerak.
  const [resolved, discounts, movements, years] = await Promise.all([
    resolveForStudentMonth(studentId, data.currentMonth),
    resolveDiscountsForStudent(studentId, data.currentMonth),
    getMovements(studentId),
    getStudentAcademicYears(studentId),
  ]);

  const item = resolved.items[0] ?? null;
  const settings = await getFinanceSettings();

  const effective = item
    ? applyDiscounts(new Decimal(item.amount), discounts, {
        maxPercent: settings.maxDiscountPercent,
      })
    : null;

  return {
    student: {
      id: student.id,
      fullName: `${student.firstName} ${student.lastName ?? ""}`.trim(),
      username: student.username,
      className: student.classes[0]?.class?.name ?? null,
    },
    academicYears: years,
    tariff: item
      ? {
          id: item.tariff.id,
          name: item.tariff.name,
          monthlyAmount: item.amount,
          discounts: discounts.map((d) => ({
            id: d.id,
            name: d.name,
            type: d.type,
            value: formatAmount(d.value),
            valueLabel:
              d.type === "percent" ? `${Number(d.value)}%` : `${formatAmount(d.value)} so'm`,
          })),
          discountAmount: formatAmount(effective.discountAmount),
          effectiveMonthly: formatAmount(effective.finalAmount),
        }
      : null,
    tariffReason: resolved.reason,
    movements: movements.items,
    ...data,
  };
};

/**
 * O'quvchi qaysi o'quv yillarida o'qigan — "o'zi o'qigan davrlar" tanlagichi.
 *
 * Manba: hisob-fakturalar (`academicYear` snapshot'i). Joriy yil hisob-faktura
 * hali yo'q bo'lsa ham qo'shiladi — o'quvchi bo'sh sahifaga tushmasligi kerak.
 *
 * @param {string} studentId
 * @returns {Promise<Array<{academicYear: number, label: string, isCurrent: boolean}>>}
 */
const getStudentAcademicYears = async (studentId) => {
  const settings = await getFinanceSettings();
  const current = academicYearOf(currentMonthKey(), settings);

  const grouped = await prisma.monthlyInvoice.groupBy({
    by: ["academicYear"],
    where: { studentId },
    _count: { _all: true },
  });

  const years = new Set(grouped.map((g) => g.academicYear));
  years.add(current);

  return [...years]
    .sort((a, b) => b - a)
    .map((year) => ({
      academicYear: year,
      label: `${year}/${year + 1}`,
      isCurrent: year === current,
    }));
};

/**
 * O'QUVCHILAR REGISTRI — kassirning asosiy ekrani.
 *
 * Har bir qatorda: tarif, chegirma, shu oydagi summa, depozit qoldig'i va
 * JAMI qarz. Kassir shu ro'yxatdan o'quvchini topib, darhol to'lov qabul
 * qiladi.
 *
 * So'rovlar soni sahifadagi o'quvchilar soniga BOG'LIQ EMAS — 6 ta:
 * o'quvchilar, narx, chegirma, qoldiq, qarz, holat. Har qator uchun
 * alohida so'rov qilinsa, 24 talik sahifa 100+ so'rovga aylanardi.
 *
 * @param {object} req - query: page, limit, search, classId, month, filter
 * @returns {Promise<object>}
 */
const getStudentRegistry = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const settings = await getFinanceSettings();
  const month = query.month ? parseMonthKey(query.month, "Oy") : currentMonthKey();
  const search = query.search?.trim();

  const where = {
    role: ROLES.STUDENT,
    isArchived: false,
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
  };

  const [students, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      skip,
      take: limit,
      select: {
        ...STUDENT_SELECT,
        classes: { select: { class: { select: { id: true, name: true } } } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  if (students.length === 0) {
    return {
      ...formatPaginationResponse([], 0, page, limit),
      month,
      monthLabel: formatMonthKey(month),
      totals: { totalDebt: "0.00", totalBalance: "0.00", debtorCount: 0 },
    };
  }

  const ids = students.map((s) => s.id);

  const [{ byStudent }, discountsByStudent, balances, debtRows, statuses] =
    await Promise.all([
      resolveManyForMonth(month, { studentIds: ids }),
      resolveDiscountsForMonth(month, { studentIds: ids }),
      getBalances(ids),
      prisma.monthlyInvoice.groupBy({
        by: ["studentId"],
        where: { studentId: { in: ids }, status: { in: ["unpaid", "partial"] } },
        _sum: { amount: true, paidAmount: true },
      }),
      resolveStatusesForMonth(month, { studentIds: ids }),
    ]);

  const debtByStudent = new Map(
    debtRows.map((row) => [
      row.studentId,
      new Decimal(row._sum.amount ?? 0).minus(row._sum.paidAmount ?? 0),
    ]),
  );

  let totalDebt = new Decimal(0);
  let totalBalance = new Decimal(0);
  let debtorCount = 0;

  const items = students.map((student) => {
    const resolved = byStudent.get(student.id);
    const discounts = discountsByStudent.get(student.id) ?? [];
    const balance = balances.get(student.id) ?? new Decimal(0);
    const debt = debtByStudent.get(student.id) ?? new Decimal(0);
    const status = statuses.get(student.id)?.status ?? "active";

    const base = resolved?.total != null ? new Decimal(resolved.total) : null;
    const priced =
      base != null
        ? applyDiscounts(base, discounts, { maxPercent: settings.maxDiscountPercent })
        : null;

    totalDebt = totalDebt.plus(debt);
    totalBalance = totalBalance.plus(balance);
    if (debt.greaterThan(0)) debtorCount += 1;

    return {
      id: student.id,
      fullName: `${student.firstName} ${student.lastName ?? ""}`.trim(),
      username: student.username,
      className: student.classes[0]?.class?.name ?? null,
      status,
      tariff: resolved?.items?.[0]?.tariff
        ? { id: resolved.items[0].tariff.id, name: resolved.items[0].tariff.name }
        : null,
      // Narx hal qilinmagan sabab: tarif yo'q yoki bu oyga narx yo'q
      tariffReason: resolved?.reason ?? "no_assignment",
      discounts: discounts.map((d) => ({
        id: d.id,
        name: d.name,
        type: d.type,
        valueLabel:
          d.type === "percent"
            ? `${Number(d.value)}%`
            : `${formatAmount(d.value)} so'm`,
      })),
      baseAmount: base != null ? formatAmount(base) : null,
      discountAmount: priced ? formatAmount(priced.discountAmount) : null,
      monthlyAmount: priced ? formatAmount(priced.finalAmount) : null,
      balance: formatAmount(balance),
      debt: formatAmount(debt),
      hasDebt: debt.greaterThan(0),
    };
  });

  // Filtr xotirada: qarz/depozit hisoblangandan keyin ma'lum bo'ladi va
  // uni SQL'ga ko'chirish bir nechta jadval bo'ylab join talab qilardi.
  const filtered =
    query.filter === "debtors"
      ? items.filter((i) => i.hasDebt)
      : query.filter === "deposit"
        ? items.filter((i) => Number(i.balance) > 0)
        : query.filter === "noTariff"
          ? items.filter((i) => !i.tariff)
          : items;

  return {
    ...formatPaginationResponse(filtered, total, page, limit),
    month,
    monthLabel: formatMonthKey(month),
    totals: {
      totalDebt: formatAmount(totalDebt),
      totalBalance: formatAmount(totalBalance),
      debtorCount,
    },
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

  const [grouped, vacationSet, deposits, discountAgg] = await Promise.all([
    prisma.monthlyInvoice.groupBy({
      by: ["status"],
      where: { month },
      _count: { _all: true },
      _sum: { amount: true, paidAmount: true },
    }),
    getVacationSet(academic.academicYear),
    prisma.studentAccount.aggregate({ _sum: { balance: true } }),
    prisma.monthlyInvoice.aggregate({
      where: { month, status: { not: "cancelled" } },
      _sum: { baseAmount: true, discountAmount: true },
    }),
  ]);

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
  const isVacation = vacationSet.has(month);

  return {
    month,
    monthLabel: formatMonthKey(month),
    ...academic,
    isVacation,
    // Ta'til oyida "Shakllantirish" tugmasi o'chadi va sabab ko'rsatiladi
    canGenerate: academic.isAcademicMonth && !isVacation && month <= currentMonthKey(),
    blockedReason: !academic.isAcademicMonth
      ? "not_academic"
      : isVacation
        ? "vacation"
        : month > currentMonthKey()
          ? "future"
          : null,
    counts: { ...counts, invoiced: invoicedCount },
    totals: {
      baseAmount: formatAmount(new Decimal(discountAgg._sum.baseAmount ?? 0)),
      discountAmount: formatAmount(new Decimal(discountAgg._sum.discountAmount ?? 0)),
      amount: formatAmount(totalAmount),
      paid: formatAmount(totalPaid),
      debt: formatAmount(totalAmount.minus(totalPaid)),
      // Butun maktabdagi oldindan to'langan pul — oyga bog'liq emas,
      // lekin admin ekranida shu yerda ko'rinishi mantiqiy
      deposits: formatAmount(new Decimal(deposits._sum.balance ?? 0)),
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

  if (invoice.month < currentMonthKey()) {
    logger.warn(
      `[invoices] O'tgan oy hisob-fakturasi bekor qilindi: invoice=${id} ` +
        `student=${invoice.studentId} month=${invoice.month} actor=${userId} sabab="${trimmed}"`,
    );
  }

  // To'langan majburiyatni bekor qilish ODATIY hol: "o'quvchi martda ketdi,
  // mayga qadar to'lab qo'ygan edi". To'lovni bekor qilish noto'g'ri javob
  // bo'lardi — pul haqiqatan ham olingan. Shuning uchun taqsimotlar
  // bo'shatiladi va pul DEPOZITGA qaytadi (u yerdan keyingi oyga tushadi
  // yoki ota-onaga qaytariladi).
  const released = await prisma.$transaction(async (tx) => {
    await tx.studentAccount.upsert({
      where: { studentId: invoice.studentId },
      create: { studentId: invoice.studentId, balance: 0 },
      update: { version: { increment: 1 } },
    });

    const fresh = await tx.monthlyInvoice.findUnique({ where: { id } });
    if (fresh.status === "cancelled") {
      throw new BadRequestError("Hisob-faktura allaqachon bekor qilingan");
    }

    const amount = await releaseInvoiceAllocations(tx, fresh);

    await tx.monthlyInvoice.update({
      where: { id },
      data: {
        status: "cancelled",
        cancelReason: trimmed,
        cancelledAt: new Date(),
        cancelledBy: userId,
      },
    });

    return amount;
  }, TX_OPTIONS);

  const result = await getInvoiceById(id);

  return {
    ...result,
    releasedToDeposit: formatAmount(released),
    ...(released.greaterThan(0)
      ? {
          warnings: [
            `${formatAmount(released)} so'm o'quvchining depozitiga qaytarildi — ` +
              "u keyingi oyga o'tadi yoki ota-onaga qaytariladi",
          ],
        }
      : {}),
  };
};

/**
 * Hisob-fakturani bekor qilib, joriy tarif va chegirmalar bo'yicha
 * QAYTA yaratadi.
 *
 * Kerak bo'ladigan holat: chegirma kech qo'shildi yoki tarif narxi xato
 * kiritilgan edi. Summa muhrlangani uchun uni tahrirlashning yo'li yo'q —
 * yagona halol yechim shu. `@@unique([studentId, month])` sababli eskisi
 * avval bekor qilinishi va yangisi `replacesInvoiceId` bilan bog'lanishi
 * kerak edi, lekin unique cheklov bekor qilingan qatorni ham hisoblaydi —
 * shuning uchun eskisi O'CHIRILADI va butun tarix yangi qatorda qoladi.
 *
 * @param {string} id
 * @param {string} reason
 * @param {string} userId
 * @returns {Promise<object>}
 */
const regenerateInvoice = async (id, reason, userId) => {
  const invoice = await prisma.monthlyInvoice.findUnique({ where: { id } });
  if (!invoice) throw new NotFoundError("Hisob-faktura topilmadi");

  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError("Qayta shakllantirish sababi majburiy");

  if (new Decimal(invoice.paidAmount).greaterThan(0)) {
    throw new BadRequestError(
      "To'lov tushgan hisob-fakturani qayta shakllantirib bo'lmaydi. " +
        "Avval uni bekor qiling — pul depozitga qaytadi.",
    );
  }

  const settings = await getFinanceSettings();
  const [resolved, discounts, vacationSet] = await Promise.all([
    resolveForStudentMonth(invoice.studentId, invoice.month),
    resolveDiscountsForStudent(invoice.studentId, invoice.month),
    getVacationSet(invoice.academicYear),
  ]);

  const item = resolved.items[0];
  if (!item) {
    throw new BadRequestError(
      "O'quvchida bu oy uchun tarif yoki narx yo'q — qayta shakllantirib bo'lmaydi",
    );
  }

  const base = new Decimal(item.amount);
  const discounted = applyDiscounts(base, discounts, {
    maxPercent: settings.maxDiscountPercent,
  });
  const billable = describeBillableMonth(invoice.month, settings, vacationSet);

  logger.warn(
    `[invoices] Hisob-faktura qayta shakllantirildi: invoice=${id} ` +
      `student=${invoice.studentId} month=${invoice.month} ` +
      `eski=${invoice.amount.toFixed(2)} yangi=${discounted.finalAmount.toFixed(2)} ` +
      `actor=${userId} sabab="${trimmed}"`,
  );

  const created = await prisma.$transaction(async (tx) => {
    await tx.monthlyInvoice.delete({ where: { id } });

    const isZero = discounted.finalAmount.isZero();

    return tx.monthlyInvoice.create({
      data: {
        studentId: invoice.studentId,
        month: invoice.month,
        academicYear: invoice.academicYear,
        academicIndex: invoice.academicIndex,
        billableIndex: billable.billableIndex ?? invoice.billableIndex,
        billableMonthCount: billable.billableMonthCount,
        tariffId: item.tariff.id,
        tariffVersionId: item.version.id,
        tariffName: item.tariff.name,
        baseAmount: base,
        discountAmount: discounted.discountAmount,
        discountSnapshot: discounted.snapshot.length ? discounted.snapshot : null,
        amount: discounted.finalAmount,
        paidAmount: 0,
        status: isZero ? "paid" : "unpaid",
        paidAt: isZero ? new Date() : null,
        source: "manual",
        studentSnapshot: invoice.studentSnapshot,
        note: invoice.note,
        replacesInvoiceId: invoice.id,
        createdBy: userId,
      },
    });
  }, TX_OPTIONS);

  return getInvoiceById(created.id);
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

  const status = deriveStatus(
    new Decimal(invoice.amount),
    new Decimal(invoice.paidAmount),
  );

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
  serializeInvoice,
  getInvoices,
  getInvoiceById,
  getStudentInvoices,
  getStudentAcademicYears,
  getStudentRegistry,
  getMyFinance,
  getSummary,
  updateNote,
  cancelInvoice,
  regenerateInvoice,
  restoreInvoice,
};
