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
  monthKeyOfDate,
  nextMonth,
} = require("../helpers/month.helpers");
const { Decimal, formatAmount } = require("../helpers/money.helpers");

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
  getPeriodsForStudent,
  resolveEnrollmentsForStudents,
} = require("./studentEnrollment.service");
const {
  buildInvoiceRow,
  computeMonthlyAmount,
  prorationGap,
} = require("./invoiceBuilder.service");
const {
  resolveEnrollmentForMonth,
  describeEnrollment,
} = require("../helpers/enrollment.helpers");
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

/** Qarzdor topilmaganda qaytariladigan yig'ma. */
const EMPTY_DEBT_TOTALS = {
  totalDebt: "0.00",
  debtorCount: 0,
  oldestMonth: null,
  oldestMonthLabel: null,
};

const STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  isArchived: true,
};

/**
 * O'QUVCHINING OYLAR OYNASI — birinchi kelgan oyidan oxirgi tegishli oygacha.
 *
 * O'quv yili tushunchasi yo'q, shuning uchun oyna o'quvchining O'ZIDAN
 * chiqadi: qachon kelgan bo'lsa o'shandan boshlanadi.
 *
 * Oxirgi oy — hozir o'qiyotgan bo'lsa JORIY oy, aks holda oxirgi ketgan oyi.
 * Kelgusi oylar ro'yxatga KIRMAYDI: ular hali majburiyat emas.
 *
 * ⚠️ Mavjud hisob-faktura oylari ham oynaga qo'shiladi. Davr keyin
 * tahrirlansa (masalan boshlanish sanasi kechiktirilsa), chiqarilgan
 * hisob-faktura oynadan tashqarida qolib, ekranda jimgina g'oyib bo'lardi.
 *
 * @param {Array<{startDate: Date, endDate: Date|null}>} periods
 * @param {number[]} invoiceMonths - mavjud hisob-faktura oylari (YYYYMM)
 * @param {number} currentMonth - YYYYMM
 * @returns {{fromMonth: number, toMonth: number, months: number[]}}
 */
const buildStudentMonthWindow = (periods, invoiceMonths, currentMonth) => {
  const starts = periods.map((period) => monthKeyOfDate(period.startDate));
  const candidates = [...starts, ...invoiceMonths];

  if (candidates.length === 0) {
    return { fromMonth: null, toMonth: null, months: [] };
  }

  const fromMonth = Math.min(...candidates);

  const isStudying = periods.some((period) => period.endDate == null);
  const endMonths = periods
    .filter((period) => period.endDate != null)
    .map((period) => monthKeyOfDate(period.endDate));

  const lastPeriodMonth = isStudying
    ? currentMonth
    : endMonths.length > 0
      ? Math.max(...endMonths)
      : currentMonth;

  const toMonth = Math.max(lastPeriodMonth, ...invoiceMonths, fromMonth);

  const months = [];
  for (let m = fromMonth; m <= toMonth; m = nextMonth(m)) months.push(m);

  return { fromMonth, toMonth, months };
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
    // Kirish proratsiyasi: baza → ulush → chegirma → summa
    proratedAmount: formatAmount(invoice.proratedAmount ?? invoice.baseAmount),
    prorationAmount: formatAmount(
      prorationGap(invoice.baseAmount, invoice.proratedAmount ?? invoice.baseAmount),
    ),
    isProrated: invoice.billableDays != null,
    prorationLabel:
      invoice.billableDays != null
        ? `${invoice.billableDays}/${invoice.monthDays} kun`
        : null,
    discountAmount: formatAmount(discount),
    hasDiscount: discount.greaterThan(0),
    amount: formatAmount(invoice.amount),
    paidAmount: formatAmount(invoice.paidAmount),
    // Ortiqcha to'lov depozitga tushadi, shuning uchun bu yerda manfiy
    // bo'lmasligi kerak — lekin himoya qavati qoladi
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
 * Oy oralig'i `month: {gte, lte}` ga aylantiriladi — shunda [month, status]
 * indeksi ishlaydi.
 */
const buildInvoiceFilter = async (query) => {
  const filter = {};

  if (query.month) {
    filter.month = parseMonthKey(query.month, "Oy");
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
/**
 * SAHIFADAGI hisob-fakturalarning TO'LOV TURI kesimi.
 *
 * "Bu o'quvchi shu oy 700 000 ni naqd, 600 000 ni plastik to'ladi" degan
 * savolga javob. Registrda ustun sifatida ko'rsatiladi.
 *
 * ⚠️ BITTA so'rov — sahifadagi hamma qator uchun. Har qatorga alohida
 * so'rov yuborilsa, 50 qatorli sahifa 50 marta bazaga borardi.
 *
 * ⚠️ `payment.accountId` bo'yicha guruhlanadi, `allocation` ning o'zida
 * to'lov turi yo'q: pul QAYSI kassaga tushgani chekda yozilgan.
 * `source: deposit` taqsimoti ham o'z chekining turiga tushadi — pul
 * o'sha kassaga o'sha chek bilan kirgan.
 *
 * @param {string[]} invoiceIds
 * @returns {Promise<Map<string, Array<{accountId: string, name: string, amount: string}>>>}
 */
const loadPaidByAccount = async (invoiceIds) => {
  if (invoiceIds.length === 0) return new Map();

  const rows = await prisma.paymentAllocation.groupBy({
    by: ["invoiceId"],
    where: { invoiceId: { in: invoiceIds }, isVoided: false },
    _sum: { amount: true },
  });

  // Prisma `groupBy` bog'langan jadval ustuni bo'yicha guruhlay olmaydi,
  // shuning uchun to'lov turi xom so'rov bilan olinadi
  const perAccount = await prisma.$queryRawUnsafe(
    `SELECT a.invoice_id AS invoice_id,
            p.account_id  AS account_id,
            SUM(a.amount)::text AS amount
       FROM payment_allocations a
       JOIN payments p ON p.id = a.payment_id
      WHERE a.is_voided = false
        AND p.is_voided = false
        AND a.invoice_id = ANY($1::char(24)[])
      GROUP BY 1, 2`,
    invoiceIds,
  );

  const accountIds = [...new Set(perAccount.map((row) => row.account_id))];
  const accounts = accountIds.length
    ? await prisma.paymentAccount.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(accounts.map((a) => [a.id, a.name]));

  const byInvoice = new Map();
  for (const row of perAccount) {
    const list = byInvoice.get(row.invoice_id) ?? [];
    list.push({
      accountId: row.account_id,
      name: nameById.get(row.account_id) ?? "Noma'lum",
      amount: formatAmount(new Decimal(row.amount ?? 0)),
    });
    byInvoice.set(row.invoice_id, list);
  }

  // Yig'indi qatori bilan solishtirish uchun tartib barqaror bo'lsin
  for (const list of byInvoice.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name, "uz"));
  }

  // `rows` faqat "umuman taqsimot bormi" ni bilish uchun — bo'sh massiv
  // bilan null orasidagi farq frontendga kerak emas
  for (const row of rows) {
    if (!byInvoice.has(row.invoiceId)) byInvoice.set(row.invoiceId, []);
  }

  return byInvoice;
};

const getInvoices = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const settings = await getFinanceSettings();
  const filter = await buildInvoiceFilter(req.query);

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

  const [studentMap, paidByAccount] = await Promise.all([
    loadStudentMap(rows),
    loadPaidByAccount(rows.map((row) => row.id)),
  ]);

  const totalAmount = new Decimal(agg._sum.amount ?? 0);
  const totalPaid = new Decimal(agg._sum.paidAmount ?? 0);

  return {
    ...formatPaginationResponse(
      rows.map((row) => ({
        ...serializeInvoice(row, { student: studentMap.get(row.studentId) }),
        // To'lov turi kesimi — registrdagi "Naqd / Plastik" ustunlari
        paidByAccount: paidByAccount.get(row.id) ?? [],
      })),
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
 * @param {{includeCancelled?: boolean}} options
 * @returns {Promise<object>}
 */
const getStudentInvoices = async (studentId, options = {}) => {
  const settings = await getFinanceSettings();
  const month = currentMonthKey();

  // Oy oralig'i bo'yicha FILTRLAMAYMIZ: oyna o'quvchining o'qish davridan
  // chiqadi va uni bilish uchun avval hisob-faktura oylari kerak. O'quvchida
  // ko'pi bilan bir necha o'nlab qator bo'ladi — filtr foyda bermaydi.
  const where = {
    studentId,
    ...(options.includeCancelled ? {} : { status: { not: "cancelled" } }),
  };

  const [rows, agg, statusInfo, vacationSet, balance, periods] = await Promise.all([
    prisma.monthlyInvoice.findMany({ where, orderBy: { month: "desc" } }),
    prisma.monthlyInvoice.aggregate({
      where,
      _sum: {
        amount: true,
        paidAmount: true,
        baseAmount: true,
        proratedAmount: true,
        discountAmount: true,
      },
    }),
    resolveStatusForStudent(studentId, month),
    getVacationSet(),
    getBalance(studentId),
    getPeriodsForStudent(studentId),
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

  // O'quvchining TO'LIQ oylar jadvali — ta'til oylari ham ko'rinadi,
  // shunda "iyulda nega hisob yo'q?" savoli tug'ilmaydi.
  const invoiceByMonth = new Map(rows.map((r) => [r.month, r]));
  const window = buildStudentMonthWindow(
    periods,
    rows.map((r) => r.month),
    month,
  );

  // O'quvchi to'lagan/to'lashi kerak bo'lgan oylar sanog'i — JONLI hisob
  // (snapshot emas): davr keyin to'g'rilansa yorliq ham to'g'rilanadi, u pul
  // emas, shuning uchun muhrlash talab qilinmaydi.
  let enrolledIndex = 0;
  // Qarz progressining maxraji — hozirga qadar KELGAN oylar. Oyna kelgusi
  // oylarni o'z ichiga olmasa ham, davr kelajakda boshlangan holat bor.
  let dueIndex = 0;

  const timeline = window.months.map((entryMonth) => {
    const invoice = invoiceByMonth.get(entryMonth);
    const isVacation = vacationSet.has(entryMonth);
    const enrollment = resolveEnrollmentForMonth(periods, entryMonth);
    const isEnrolled = !isVacation && enrollment.enrolled;

    if (isEnrolled) enrolledIndex += 1;
    if (isEnrolled && entryMonth <= month) dueIndex += 1;

    const skipReason = isVacation
      ? "vacation"
      : !enrollment.enrolled
        ? // "davri umuman yo'q" ni "bu oyda o'qimagan" dan ajratamiz: birinchisi
          // to'ldirilishi kerak bo'lgan MA'LUMOT KAMCHILIGI, ikkinchisi esa fakt.
          enrollment.reason === "no_periods"
          ? "no_periods"
          : "not_enrolled"
        : settings.firstInvoiceMonth != null && entryMonth < settings.firstInvoiceMonth
          ? "before_first_invoice_month"
          : null;

    return {
      month: entryMonth,
      monthLabel: formatMonthKey(entryMonth),
      isVacation,
      isEnrolled,
      enrolledIndex: isEnrolled ? enrolledIndex : null,
      skipReason,
      isProrated: invoice?.billableDays != null,
      billableDays: invoice?.billableDays ?? null,
      monthDays: invoice?.monthDays ?? null,
      isFuture: entryMonth > month,
      invoice: invoice
        ? serializeInvoice(invoice, { payments: paymentsByInvoice.get(invoice.id) ?? [] })
        : null,
    };
  });

  const enrolledMonthCount = enrolledIndex;
  const dueMonthCount = dueIndex;
  const paidMonths = rows.filter((r) => r.status === "paid").length;

  return {
    // Oyna — o'quvchi kelgan oyidan oxirgi tegishli oygacha
    fromMonth: window.fromMonth,
    fromMonthLabel: window.fromMonth ? formatMonthKey(window.fromMonth) : null,
    toMonth: window.toMonth,
    toMonthLabel: window.toMonth ? formatMonthKey(window.toMonth) : null,
    vacationMonths: [...vacationSet].sort().map((m) => ({
      month: m,
      monthLabel: formatMonthKey(m),
    })),
    currentMonth: month,
    currentMonthLabel: formatMonthKey(month),
    financeStatus: {
      status: statusInfo.status,
      statusLabel: statusInfo.statusLabel,
      startMonth: statusInfo.row?.startMonth ?? null,
      endMonth: statusInfo.row?.endMonth ?? null,
      reason: statusInfo.row?.reason ?? "",
    },
    balance: formatAmount(balance),
    enrolledMonthCount,
    enrollment: describeEnrollmentForStudent(periods),
    totals: {
      baseAmount: formatAmount(new Decimal(agg._sum.baseAmount ?? 0)),
      // Kirish proratsiyasi tufayli hisoblanmagan summa — aks holda
      // "baza 600 000 · chegirma 6 000 · summa 54 000" da 540 000
      // yorliqsiz g'oyib bo'lardi
      prorationAmount: formatAmount(
        prorationGap(agg._sum.baseAmount ?? 0, agg._sum.proratedAmount ?? 0),
      ),
      discountAmount: formatAmount(new Decimal(agg._sum.discountAmount ?? 0)),
      invoiced: formatAmount(invoiced),
      paid: formatAmount(paid),
      debt: formatAmount(debt.isNegative() ? new Decimal(0) : debt),
      unpaidCount: rows.filter((r) => r.status !== "paid").length,
      paidMonths,
      // O'quvchi maktabda bo'lgan oylar (ta'til chegirilgan)
      enrolledMonths: enrolledMonthCount,
      // Hozirga qadar KELGAN oylar — qarz progressining maxraji.
      // Kelgusi oylar bu yerda sanalmaydi: ular hali majburiyat emas.
      dueMonths: dueMonthCount,
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
  const [resolved, discounts, movements, periods] = await Promise.all([
    resolveForStudentMonth(studentId, data.currentMonth),
    resolveDiscountsForStudent(studentId, data.currentMonth),
    getMovements(studentId),
    getPeriodsForStudent(studentId),
  ]);

  const item = resolved.items[0] ?? null;
  const settings = await getFinanceSettings();

  // Joriy oy proratsiya bilan — o'quvchi ekranida ko'rinadigan summa
  // hisob-faktura bilan mos kelishi shart
  const effective = item
    ? computeMonthlyAmount({
        baseAmount: item.amount,
        discounts,
        periods,
        month: data.currentMonth,
        settings,
      })
    : null;

  return {
    student: {
      id: student.id,
      fullName: `${student.firstName} ${student.lastName ?? ""}`.trim(),
      username: student.username,
      className: student.classes[0]?.class?.name ?? null,
    },
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
          effectiveMonthly: formatAmount(effective.amount),
          isProrated: effective.isProrated,
          billableDays: effective.isProrated ? effective.enrollment.billableDays : null,
          monthDays: effective.isProrated ? effective.enrollment.monthDays : null,
        }
      : null,
    tariffReason: resolved.reason,
    enrollment: describeEnrollmentForStudent(periods),
    movements: movements.items,
    ...data,
  };
};

/** O'quvchi paneliga chiqadigan qisqa holat. */
const describeEnrollmentForStudent = (periods) => {
  const state = describeEnrollment(periods);
  const toDay = (d) => (d ? d.toISOString().slice(0, 10) : null);

  return {
    isStudying: state.isStudying,
    hasPeriods: state.hasPeriods,
    since: toDay(state.since),
    until: toDay(state.until),
  };
};

/**
 * QARZDORLAR REGISTRI — "kim qancha qarzdor va qachondan beri".
 *
 * ⚠️ So'rov O'QUVCHIDAN emas, QARZDAN boshlanadi. O'quvchilar ro'yxatini
 * sahifalab, so'ng qarzdorlarni xotirada filtrlash NOTO'G'RI bo'lardi:
 * birinchi sahifada 2 ta, ikkinchisida 0 ta qator chiqib, "jami qarz" esa
 * faqat o'sha sahifani sanardi. Shuning uchun avval to'lanmagan
 * hisob-fakturalar guruhlanadi, keyin sahifaning o'quvchilari yuklanadi.
 *
 * Guruhlash natijasi o'quvchilar soni bilan chegaralangan (har o'quvchiga
 * bitta qator), shuning uchun saralash va sahifalash xotirada bajariladi —
 * "amount - paid_amount" ayirmasini SQL darajasida saralash uchun xom so'rov
 * kerak bo'lardi va u filial schema'si bilan bog'liq xavf tug'dirardi.
 *
 * @param {object} req
 * @returns {Promise<object>}
 */
const getDebtors = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;
  const search = query.search?.trim();
  // Qarz "yoshi" (necha oy turgani) shunga nisbatan hisoblanadi
  const currentMonth = currentMonthKey();

  // Qidiruv/sinf filtri bo'lsa avval o'quvchilar aniqlanadi
  let studentFilter = null;
  if (search || query.classId) {
    const matched = await prisma.user.findMany({
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
    studentFilter = matched.map((s) => s.id);
    if (studentFilter.length === 0) {
      return {
        ...formatPaginationResponse([], 0, page, limit),
        currentMonth,
        totals: EMPTY_DEBT_TOTALS,
      };
    }
  }

  const grouped = await prisma.monthlyInvoice.groupBy({
    by: ["studentId"],
    where: {
      status: { in: ["unpaid", "partial"] },
      ...(studentFilter ? { studentId: { in: studentFilter } } : {}),
    },
    _sum: { amount: true, paidAmount: true },
    _min: { month: true },
    _count: { _all: true },
  });

  // Qarzi nolga teng qatorlar chiqarib tashlanadi: to'liq to'langan
  // hisob-faktura "paid" bo'lib yopiladi, lekin bekor qilingan/tuzatilgan
  // holatlarda ayirma nolga tushib qolishi mumkin.
  const rows = grouped
    .map((row) => ({
      studentId: row.studentId,
      debt: new Decimal(row._sum.amount ?? 0).minus(row._sum.paidAmount ?? 0),
      unpaidCount: row._count._all,
      oldestMonth: row._min.month,
    }))
    .filter((row) => row.debt.greaterThan(0));

  const totalDebt = rows.reduce((sum, row) => sum.plus(row.debt), new Decimal(0));
  const oldestMonth = rows.reduce(
    (min, row) => (min == null || row.oldestMonth < min ? row.oldestMonth : min),
    null,
  );

  // "Eng katta qarz" (sukut) yoki "Eng eski qarz"
  const byOldest = query.sort === "oldest";
  rows.sort((a, b) =>
    byOldest
      ? a.oldestMonth - b.oldestMonth || b.debt.comparedTo(a.debt)
      : b.debt.comparedTo(a.debt) || a.oldestMonth - b.oldestMonth,
  );

  const pageRows = rows.slice(skip, skip + limit);

  if (pageRows.length === 0) {
    return {
      ...formatPaginationResponse([], rows.length, page, limit),
      currentMonth,
      totals: {
        totalDebt: formatAmount(totalDebt),
        debtorCount: rows.length,
        oldestMonth,
        oldestMonthLabel: oldestMonth ? formatMonthKey(oldestMonth) : null,
      },
    };
  }

  const ids = pageRows.map((row) => row.studentId);

  // Ro'yxatda ko'rsatilmaydigan hech narsa o'qilmaydi: sinf JOIN'i ham,
  // depozit qoldig'i ham olib tashlangan. Sinf bo'yicha FILTR esa yuqorida,
  // alohida so'rovda ishlaydi.
  const students = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: STUDENT_SELECT,
  });

  const studentMap = new Map(students.map((s) => [s.id, s]));

  const items = pageRows.map((row) => {
    // O'quvchi arxivlangan/o'chirilgan bo'lishi mumkin — qarz baribir ko'rinadi
    const student = studentMap.get(row.studentId) ?? null;

    return {
      id: row.studentId,
      fullName: student
        ? `${student.firstName} ${student.lastName ?? ""}`.trim()
        : "Noma'lum",
      isArchived: student?.isArchived ?? false,
      debt: formatAmount(row.debt),
      unpaidCount: row.unpaidCount,
      oldestMonth: row.oldestMonth,
      oldestMonthLabel: formatMonthKey(row.oldestMonth),
    };
  });

  return {
    ...formatPaginationResponse(items, rows.length, page, limit),
    currentMonth,
    totals: {
      totalDebt: formatAmount(totalDebt),
      debtorCount: rows.length,
      oldestMonth,
      oldestMonthLabel: oldestMonth ? formatMonthKey(oldestMonth) : null,
    },
  };
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

  const [{ byStudent }, discountsByStudent, periodsByStudent, balances, debtRows, statuses] =
    await Promise.all([
      resolveManyForMonth(month, { studentIds: ids }),
      resolveDiscountsForMonth(month, { studentIds: ids }),
      resolveEnrollmentsForStudents(ids),
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

    const periods = periodsByStudent.get(student.id) ?? [];
    const enrollment = resolveEnrollmentForMonth(periods, month);

    const base = resolved?.total != null ? new Decimal(resolved.total) : null;
    // ⚠️ Proratsiya bilan hisoblanadi — aks holda kassir ekrani 600 000
    // ko'rsatib, hisob-fakturada 240 000 turardi va kassir ortiqcha pul
    // qabul qilib, farqni depozitga tushirib yuborardi.
    const priced =
      base != null && enrollment.enrolled
        ? computeMonthlyAmount({
            baseAmount: base,
            discounts,
            periods,
            month,
            settings,
          })
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
      monthlyAmount: priced ? formatAmount(priced.amount) : null,
      // Kirish proratsiyasi — UI da "20-yanvardan · 12/31 kun" deb ko'rinadi
      isEnrolled: enrollment.enrolled,
      isProrated: priced?.isProrated ?? false,
      billableDays: priced?.isProrated ? enrollment.billableDays : null,
      monthDays: priced?.isProrated ? enrollment.monthDays : null,
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
  const month = monthInput ? parseMonthKey(monthInput, "Oy") : currentMonthKey();

  const [grouped, vacationSet, deposits, discountAgg] = await Promise.all([
    prisma.monthlyInvoice.groupBy({
      by: ["status"],
      where: { month },
      _count: { _all: true },
      _sum: { amount: true, paidAmount: true },
    }),
    getVacationSet(),
    prisma.studentAccount.aggregate({ _sum: { balance: true } }),
    prisma.monthlyInvoice.aggregate({
      where: { month, status: { not: "cancelled" } },
      _sum: { baseAmount: true, proratedAmount: true, discountAmount: true },
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
    isVacation,
    // Ta'til oyida "Shakllantirish" tugmasi o'chadi va sabab ko'rsatiladi
    canGenerate: !isVacation && month <= currentMonthKey(),
    blockedReason: isVacation
      ? "vacation"
      : month > currentMonthKey()
        ? "future"
        : null,
    counts: { ...counts, invoiced: invoicedCount },
    totals: {
      baseAmount: formatAmount(new Decimal(discountAgg._sum.baseAmount ?? 0)),
      // amount = baseAmount − proration − discount
      prorationAmount: formatAmount(
        prorationGap(
          discountAgg._sum.baseAmount ?? 0,
          discountAgg._sum.proratedAmount ?? 0,
        ),
      ),
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
  const [resolved, discounts, periods] = await Promise.all([
    resolveForStudentMonth(invoice.studentId, invoice.month),
    resolveDiscountsForStudent(invoice.studentId, invoice.month),
    getPeriodsForStudent(invoice.studentId),
  ]);

  // ⚠️ Summa AYNAN oylik pass bilan bir xil quruvchi orqali hisoblanadi.
  // Ilgari bu yerda mustaqil hisob bor edi va u proratsiyani bilmasdi:
  // kech qo'shilgan chegirmani qayta shakllantirish oy o'rtasida kelgan
  // o'quvchining hisobini 240 000 dan 540 000 ga ko'tarib yuborardi.
  const { row, skip, computed } = buildInvoiceRow({
    student: { id: invoice.studentId },
    month: invoice.month,
    settings,
    resolved,
    discounts,
    periods,
    source: "manual",
    actorId: userId,
    studentSnapshot: invoice.studentSnapshot,
  });

  if (skip === "notEnrolled") {
    throw new BadRequestError(
      "O'quvchi bu oyda o'qimagan — qayta shakllantirmang, hisob-fakturani bekor qiling",
    );
  }
  if (skip) {
    throw new BadRequestError(
      "O'quvchida bu oy uchun tarif yoki narx yo'q — qayta shakllantirib bo'lmaydi",
    );
  }

  logger.warn(
    `[invoices] Hisob-faktura qayta shakllantirildi: invoice=${id} ` +
      `student=${invoice.studentId} month=${invoice.month} ` +
      `eski=${invoice.amount.toFixed(2)} yangi=${computed.amount.toFixed(2)} ` +
      `${computed.isProrated ? `(${row.billableDays}/${row.monthDays} kun) ` : ""}` +
      `actor=${userId} sabab="${trimmed}"`,
  );

  const created = await prisma.$transaction(async (tx) => {
    await tx.monthlyInvoice.delete({ where: { id } });

    return tx.monthlyInvoice.create({
      data: {
        ...row,
        note: invoice.note,
        replacesInvoiceId: invoice.id,
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
  getStudentRegistry,
  getDebtors,
  getMyFinance,
  getSummary,
  updateNote,
  cancelInvoice,
  regenerateInvoice,
  restoreInvoice,
};
