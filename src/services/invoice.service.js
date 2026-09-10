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
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
} = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const logger = require("../utils/logger");
const {
  currentMonthKey,
  parseMonthKey,
  parseOptionalMonthKey,
  formatMonthKey,
  monthKeyOfDate,
  nextMonth,
  prevMonth,
  coveringMonthWhere,
} = require("../helpers/month.helpers");
const { Decimal, formatAmount, percentChange } = require("../helpers/money.helpers");

const { deriveStatus } = require("../helpers/allocation.helpers");
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
const {
  resolveServicesForStudent,
  resolveServicesForMonth,
} = require("./service.service");
const { getVacationSet } = require("./vacationMonth.service");
const { getInvoiceAllocations, TX_OPTIONS } = require("./payment.service");
const {
  getPeriodsForStudent,
  resolveEnrollmentsForStudents,
} = require("./studentEnrollment.service");
const {
  resolveForMonth: resolveOverridesForMonth,
  resolveOne: resolveOverrideOne,
  REASON_LABELS: OVERRIDE_REASON_LABELS,
} = require("./studentMonthOverride.service");
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
    // Qo'shimcha xizmatlar ulushi (baseAmount ichida) — "shundan yotoqxona
    // qancha" degan savolga javob. Eski qatorlarda 0/null.
    servicesAmount: formatAmount(invoice.servicesAmount ?? 0),
    servicesSnapshot: invoice.servicesSnapshot ?? null,
    hasServices: new Decimal(invoice.servicesAmount ?? 0).greaterThan(0),
    // Oy summasi qo'lda o'zgartirilgan bo'lsa — sabab yorlig'i (hisobot uchun)
    overrideReasonLabel: invoice.overrideReason
      ? OVERRIDE_REASON_LABELS[invoice.overrideReason] ?? invoice.overrideReason
      : null,
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

  // ⚠️ YIG'INDI HAR DOIM bekor qilinganlarsiz hisoblanadi, `where` bilan
  // EMAS. Ilgari ikkalasi bitta filtrdan olinardi va "bekor qilinganlarni
  // ko'rsatish" tugmasi o'quvchining QARZINI oshirib yuborardi: bekor
  // qilingan qatorning `paidAmount` i nolga qaytariladi (pul depozitga
  // ketadi), summasi esa qolaveradi — ya'ni butun summa qarzga qo'shilardi.
  const liveWhere = { studentId, status: { not: "cancelled" } };

  const [rows, agg, statusInfo, vacationSet, balance, periods] = await Promise.all([
    prisma.monthlyInvoice.findMany({ where, orderBy: { month: "desc" } }),
    prisma.monthlyInvoice.aggregate({
      where: liveWhere,
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
      // Bekor qilingani "to'lanmagan" emas — u QAROR (yuqoridagi
      // `liveWhere` izohiga qarang)
      unpaidCount: rows.filter(
        (r) => r.status !== "paid" && r.status !== "cancelled",
      ).length,
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
  const [resolved, discounts, services, movements, periods, monthOverride] =
    await Promise.all([
      resolveForStudentMonth(studentId, data.currentMonth),
      resolveDiscountsForStudent(studentId, data.currentMonth),
      resolveServicesForStudent(studentId, data.currentMonth),
      getMovements(studentId),
      getPeriodsForStudent(studentId),
      resolveOverrideOne(studentId, data.currentMonth),
    ]);

  const item = resolved.items[0] ?? null;
  const settings = await getFinanceSettings();

  // Joriy oy proratsiya bilan — o'quvchi ekranida ko'rinadigan summa
  // hisob-faktura bilan mos kelishi shart
  const effective = item
    ? computeMonthlyAmount({
        baseAmount: item.amount,
        discounts,
        services,
        periods,
        month: data.currentMonth,
        settings,
        monthOverride,
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
          // Qo'shimcha xizmatlar (yotoqxona, ovqat) — o'quvchi nimaga pul
          // to'layotganini ko'rishi kerak
          services: services.map((s) => ({
            id: s.id,
            name: s.name,
            amount: s.amount,
          })),
          servicesAmount: formatAmount(effective.servicesAmount),
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

/** Registrning bo'sh javobi — bitta shakl, uchta chiqish nuqtasi uchun. */
const emptyRegistry = (month, page, limit, total = 0) => ({
  ...formatPaginationResponse([], total, page, limit),
  month,
  monthLabel: formatMonthKey(month),
  totals: { totalDebt: "0.00", totalBalance: "0.00", debtorCount: 0 },
});

/**
 * Registr filtrini SAHIFALASHDAN OLDIN o'quvchi id'lariga aylantiradi.
 *
 * ⚠️ NIMA UCHUN SQL'DA, XOTIRADA EMAS. Ilgari filtr sahifa yuklangandan
 * KEYIN `items.filter(...)` bilan qo'llanardi va natija buzuq edi: 24 talik
 * sahifadan 2 tasi qarzdor bo'lsa, ekranda 2 qator ko'rinib, sahifalagichda
 * "300 ta" turardi; ikkinchi sahifa esa butunlay bo'sh chiqishi mumkin edi.
 * Bu aynan `getDebtors` sarlavhasida ogohlantirilgan xato — registrda
 * tuzatilmay qolgan edi.
 *
 * Qaytadigan ro'yxat qarzdorlar/depoziti borlar soni bilan chegaralangan,
 * ya'ni butun maktab emas.
 *
 * @param {string|undefined} filter - "debtors" | "deposit" | "noTariff"
 * @param {number} month - YYYYMM (faqat `noTariff` uchun)
 * @returns {Promise<{mode: "in"|"notIn", ids: string[]}|null>}
 */
const resolveRegistryFilter = async (filter, month) => {
  if (filter === "debtors") {
    const rows = await prisma.monthlyInvoice.groupBy({
      by: ["studentId"],
      where: { status: { in: ["unpaid", "partial"] } },
      _sum: { amount: true, paidAmount: true },
    });

    // Qarzi nolga teng qatorlar chiqarib tashlanadi (`getDebtors` bilan
    // bir xil qoida): to'liq to'langani `paid` bo'lib yopiladi, lekin
    // to'g'rilangan holatlarda ayirma nolga tushib qolishi mumkin.
    return {
      mode: "in",
      ids: rows
        .filter((row) =>
          new Decimal(row._sum.amount ?? 0)
            .minus(row._sum.paidAmount ?? 0)
            .greaterThan(0),
        )
        .map((row) => row.studentId),
    };
  }

  if (filter === "deposit") {
    const rows = await prisma.studentAccount.findMany({
      where: { balance: { gt: 0 } },
      select: { studentId: true },
    });
    return { mode: "in", ids: rows.map((row) => row.studentId) };
  }

  if (filter === "noTariff") {
    // "Tarifi yo'q" — INKORNI so'rash: shu oyni qamragan biriktirishi
    // BORlar chiqarib tashlanadi.
    const rows = await prisma.studentTariff.findMany({
      where: coveringMonthWhere(month),
      select: { studentId: true },
      distinct: ["studentId"],
    });
    return { mode: "notIn", ids: rows.map((row) => row.studentId) };
  }

  return null;
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

  // Filtr SQL'ga tushadi — sahifalashdan OLDIN (yuqoridagi izohga qarang)
  const restriction = await resolveRegistryFilter(query.filter, month);
  if (restriction) {
    if (restriction.mode === "in") {
      if (restriction.ids.length === 0) return emptyRegistry(month, page, limit);
      where.id = { in: restriction.ids };
    } else if (restriction.ids.length > 0) {
      where.id = { notIn: restriction.ids };
    }
  }

  // ⚠️ `count` O'RNIGA id ro'yxati. Jami qarz va jami depozit BUTUN FILTR
  // bo'yicha hisoblanishi kerak, sahifa bo'yicha emas — aks holda birinchi
  // sahifada bir summa, ikkinchisida boshqa summa ko'rinardi (`getInvoices`
  // va `getExpenses` da bu qoida allaqachon bor). Ro'yxat arxivlanmagan
  // o'quvchilar soni bilan chegaralangan.
  const [students, allRows] = await Promise.all([
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
    prisma.user.findMany({ where, select: { id: true } }),
  ]);

  const allIds = allRows.map((row) => row.id);
  const total = allIds.length;

  if (students.length === 0) {
    return emptyRegistry(month, page, limit, total);
  }

  const ids = students.map((s) => s.id);

  const [
    { byStudent },
    discountsByStudent,
    servicesByStudent,
    periodsByStudent,
    overridesByStudent,
    balances,
    debtRows,
    statuses,
  ] = await Promise.all([
      resolveManyForMonth(month, { studentIds: ids }),
      resolveDiscountsForMonth(month, { studentIds: ids }),
      resolveServicesForMonth(month, { studentIds: ids }),
      resolveEnrollmentsForStudents(ids),
      resolveOverridesForMonth(month, ids),
      // Qoldiq va qarz — BUTUN FILTR bo'yicha: qatorlar sahifadagilardan,
      // `totals` esa hammasidan olinadi (ikkinchi so'rov to'plami emas)
      getBalances(allIds),
      prisma.monthlyInvoice.groupBy({
        by: ["studentId"],
        where: { studentId: { in: allIds }, status: { in: ["unpaid", "partial"] } },
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

  // JAMI — butun filtr bo'yicha, sahifadan mustaqil
  let totalDebt = new Decimal(0);
  let totalBalance = new Decimal(0);
  let debtorCount = 0;

  for (const studentId of allIds) {
    const debt = debtByStudent.get(studentId) ?? new Decimal(0);
    totalDebt = totalDebt.plus(debt);
    totalBalance = totalBalance.plus(balances.get(studentId) ?? new Decimal(0));
    if (debt.greaterThan(0)) debtorCount += 1;
  }

  const items = students.map((student) => {
    const resolved = byStudent.get(student.id);
    const discounts = discountsByStudent.get(student.id) ?? [];
    const services = servicesByStudent.get(student.id) ?? [];
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
            services,
            periods,
            month,
            settings,
            monthOverride: overridesByStudent.get(student.id) ?? null,
          })
        : null;

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
        isExclusive: d.isExclusive ?? false,
        valueLabel:
          d.type === "percent"
            ? `${Number(d.value)}%`
            : `${formatAmount(d.value)} so'm`,
      })),
      // GRANT = isExclusive (grant/homiylik) chegirmasi bor o'quvchi —
      // dashboard "grant vs to'lovchi" sanog'i shu bilan ajratiladi.
      isGrant: discounts.some((d) => d.isExclusive),
      // Qo'shimcha xizmatlar (yotoqxona, ovqat) — kassir nimadan qancha
      // yig'ilayotganini ko'rishi kerak
      services: services.map((s) => ({ id: s.id, name: s.name, amount: s.amount })),
      servicesAmount: priced ? formatAmount(priced.servicesAmount) : null,
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

  return {
    ...formatPaginationResponse(items, total, page, limit),
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
 * MOLIYA BOSH SAHIFASI (dashboard) — bir oy uchun butun maktabning moliyaviy
 * manzarasi: o'quvchi sanog'i (jami / grant / to'lovchi), pul (kutilgan /
 * yig'ilgan / qarz / depozit), sinf va yo'nalish kesimi.
 *
 * ⚠️ SANOQ JONLI o'quvchidan, PUL esa hisob-fakturadan olinadi. Ikkalasi
 * boshqa-boshqa manba: oy hali shakllantirilmagan bo'lsa ham "500 o'quvchi,
 * 50 grant" ko'rinishi kerak (pul 0 bo'ladi). Invoice snapshot'iga tayansak,
 * shakllantirmagan oyda ro'yxat bo'sh qolib, o'quvchilar "yo'q" bo'lib
 * ko'rinardi.
 *
 * GRANT = isExclusive (grant/homiylik) chegirmasi shu oyda amal qiladigan
 * o'quvchi. Sinf — o'quvchining JONLI birlamchi sinfi (`classes[0]`), invoice
 * snapshot'i emas: shunda sinfni bosganda ochiladigan ro'yxat (registr,
 * `classId` bo'yicha) aynan shu sanoq bilan mos keladi.
 *
 * @param {number|string} monthInput
 * @returns {Promise<object>}
 */
const getOverviewDashboard = async (monthInput) => {
  const month = monthInput ? parseMonthKey(monthInput, "Oy") : currentMonthKey();

  const students = await prisma.user.findMany({
    where: { role: ROLES.STUDENT, isArchived: false },
    select: {
      id: true,
      classes: { select: { class: { select: { id: true, name: true } } } },
    },
  });
  const ids = students.map((s) => s.id);

  const emptyMoney = {
    expected: formatAmount(0),
    collected: formatAmount(0),
    debt: formatAmount(0),
    deposits: formatAmount(0),
  };

  if (ids.length === 0) {
    return {
      month,
      monthLabel: formatMonthKey(month),
      counts: { totalStudents: 0, grantStudents: 0, payingStudents: 0 },
      money: emptyMoney,
      byClass: [],
      byDirection: [],
    };
  }

  const [invoices, discountsByStudent, resolved, depositAgg] = await Promise.all([
    prisma.monthlyInvoice.findMany({
      where: { month, studentId: { in: ids }, status: { not: "cancelled" } },
      select: {
        studentId: true,
        amount: true,
        paidAmount: true,
        directionName: true,
      },
    }),
    resolveDiscountsForMonth(month, { studentIds: ids }),
    // Yo'nalish JONLI tarifdan olinadi (snapshot'dan emas): tarifga yo'nalish
    // keyin biriktirilsa yoki to'lov tushgan invoice qayta shakllanmasa ham
    // o'quvchi to'g'ri yo'nalishga tushadi — "Yo'nalishsiz" bo'lagi qolmaydi.
    resolveManyForMonth(month, { studentIds: ids }),
    prisma.studentAccount.aggregate({
      where: { studentId: { in: ids } },
      _sum: { balance: true },
    }),
  ]);

  // Har o'quvchining JORIY tarif yo'nalishi (nomi)
  const directionByStudent = new Map();
  for (const [sid, res] of resolved.byStudent) {
    const name = res.items?.[0]?.tariff?.direction?.name;
    if (name) directionByStudent.set(sid, name);
  }

  // Bir o'quvchi — bir oy — bitta invoice (@@unique), lekin himoya uchun yig'amiz
  const invByStudent = new Map();
  for (const inv of invoices) {
    const prev =
      invByStudent.get(inv.studentId) ??
      { amount: new Decimal(0), paid: new Decimal(0), directionName: inv.directionName };
    prev.amount = prev.amount.plus(inv.amount);
    prev.paid = prev.paid.plus(inv.paidAmount);
    invByStudent.set(inv.studentId, prev);
  }

  const grantSet = new Set();
  for (const [sid, list] of discountsByStudent) {
    if (list.some((d) => d.isExclusive)) grantSet.add(sid);
  }

  const NO_CLASS = "Sinfsiz";
  const NO_DIRECTION = "Yo'nalishsiz";
  const classMap = new Map();
  const dirMap = new Map();
  let expected = new Decimal(0);
  let collected = new Decimal(0);
  let grantCount = 0;

  for (const s of students) {
    const inv = invByStudent.get(s.id);
    const sExpected = inv?.amount ?? new Decimal(0);
    const sCollected = inv?.paid ?? new Decimal(0);
    const isGrant = grantSet.has(s.id);
    if (isGrant) grantCount += 1;

    expected = expected.plus(sExpected);
    collected = collected.plus(sCollected);

    const cls = s.classes[0]?.class ?? null;
    const classKey = cls?.id ?? "__none__";
    const crow =
      classMap.get(classKey) ??
      {
        classId: cls?.id ?? null,
        className: cls?.name ?? NO_CLASS,
        studentCount: 0,
        grantCount: 0,
        expected: new Decimal(0),
        collected: new Decimal(0),
      };
    crow.studentCount += 1;
    if (isGrant) crow.grantCount += 1;
    crow.expected = crow.expected.plus(sExpected);
    crow.collected = crow.collected.plus(sCollected);
    classMap.set(classKey, crow);

    // Yo'nalish — JONLI tarifdan (undan bo'lmasa invoice snapshot'i, u ham
    // bo'lmasa "Yo'nalishsiz"). Pulsiz (invoice yo'q) o'quvchi kesimga kirmaydi.
    if (inv) {
      const dirName =
        directionByStudent.get(s.id) || inv.directionName || NO_DIRECTION;
      const drow =
        dirMap.get(dirName) ??
        { directionName: dirName, expected: new Decimal(0), collected: new Decimal(0) };
      drow.expected = drow.expected.plus(sExpected);
      drow.collected = drow.collected.plus(sCollected);
      dirMap.set(dirName, drow);
    }
  }

  const clampDebt = (v) => (v.isNegative() ? new Decimal(0) : v);
  const serializeClass = (r) => ({
    classId: r.classId,
    className: r.className,
    studentCount: r.studentCount,
    grantCount: r.grantCount,
    payingCount: r.studentCount - r.grantCount,
    expected: formatAmount(r.expected),
    collected: formatAmount(r.collected),
    debt: formatAmount(clampDebt(r.expected.minus(r.collected))),
  });
  const serializeDir = (r) => ({
    directionName: r.directionName,
    expected: formatAmount(r.expected),
    collected: formatAmount(r.collected),
    debt: formatAmount(clampDebt(r.expected.minus(r.collected))),
  });

  const byClass = [...classMap.values()]
    .map(serializeClass)
    // Eng ko'p kutilgan summali sinf tepada — e'tibor o'sha yerda kerak
    .sort((a, b) => Number(b.expected) - Number(a.expected));
  const byDirection = [...dirMap.values()]
    .map(serializeDir)
    .sort((a, b) => Number(b.collected) - Number(a.collected));

  return {
    month,
    monthLabel: formatMonthKey(month),
    counts: {
      totalStudents: students.length,
      grantStudents: grantCount,
      payingStudents: students.length - grantCount,
    },
    money: {
      expected: formatAmount(expected),
      collected: formatAmount(collected),
      debt: formatAmount(clampDebt(expected.minus(collected))),
      deposits: formatAmount(depositAgg._sum.balance ?? 0),
    },
    byClass,
    byDirection,
  };
};

/**
 * Oy yig'masining XOM raqamlari — bir oyning majburiyat kesimi.
 *
 * `getSummary` uni IKKI marta chaqiradi: tanlangan oy va o'tgan oy uchun.
 * Ikkita mustaqil hisoblash bo'lsa, kartadagi "joriy" bilan "o'tgan oy"
 * boshqa-boshqa qoidadan chiqib qolardi (masalan biri bekor qilinganni
 * hisobga olib, ikkinchisi olmay).
 *
 * @param {number} month
 * @returns {Promise<{counts: object, invoicedCount: number, amount: Decimal, paid: Decimal, debt: Decimal}>}
 */
const monthTotals = async (month) => {
  const grouped = await prisma.monthlyInvoice.groupBy({
    by: ["status"],
    where: { month },
    _count: { _all: true },
    _sum: { amount: true, paidAmount: true },
  });

  const counts = { unpaid: 0, partial: 0, paid: 0, cancelled: 0 };
  let amount = new Decimal(0);
  let paid = new Decimal(0);

  for (const row of grouped) {
    counts[row.status] = row._count._all;
    // Bekor qilingan summalar jami qarzga kirmaydi
    if (row.status === "cancelled") continue;
    amount = amount.plus(row._sum.amount ?? 0);
    paid = paid.plus(row._sum.paidAmount ?? 0);
  }

  return {
    counts,
    invoicedCount: counts.unpaid + counts.partial + counts.paid,
    amount,
    paid,
    debt: amount.minus(paid),
  };
};

/**
 * Oylik yig'ma ma'lumot — admin ekranidagi kartalar va "shakllantirish
 * mumkinmi?" savoli uchun.
 *
 * ⚠️ TAQQOSLASH O'TGAN OY BILAN, kun yoki hafta bilan EMAS. Hisob-faktura
 * OY birligida yoziladi (`finance.md` §0) va unda kun koordinatasi umuman
 * yo'q — "bugungi hisoblangan summa" degan raqamning manbasi ham yo'q.
 * Kun aniqligidagi kesim kassa tomonida ("To'lovlar" va Dashboard'dagi
 * cash flow), majburiyat tomonida esa eng kichik birlik — oy.
 *
 * @param {number|string} monthInput
 * @returns {Promise<object>}
 */
const getSummary = async (monthInput) => {
  const month = monthInput ? parseMonthKey(monthInput, "Oy") : currentMonthKey();
  const compareMonth = prevMonth(month);

  const [current, previous, vacationSet, deposits, discountAgg] = await Promise.all([
    monthTotals(month),
    monthTotals(compareMonth),
    getVacationSet(),
    prisma.studentAccount.aggregate({ _sum: { balance: true } }),
    prisma.monthlyInvoice.aggregate({
      where: { month, status: { not: "cancelled" } },
      _sum: { baseAmount: true, proratedAmount: true, discountAmount: true },
    }),
  ]);

  const { counts, invoicedCount } = current;
  const totalAmount = current.amount;
  const totalPaid = current.paid;
  const isVacation = vacationSet.has(month);

  return {
    month,
    monthLabel: formatMonthKey(month),
    compareMonth,
    compareMonthLabel: formatMonthKey(compareMonth),
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

    // ── O'TGAN OY BILAN TAQQOSLASH ──────────────────────────────────
    // ⚠️ DEPOZIT BU YERDA YO'Q va bo'lmasligi kerak: u oyning emas,
    // BUGUNGI KUNNING qoldig'i (butun maktabdagi oldindan to'langan
    // pul). "O'tgan oydagi depozit" ni ko'rsatish uchun har oy oxirida
    // qoldiqni muhrlab boradigan jadval kerak bo'lardi — hozir bunday
    // jadval yo'q, ayirmani esa "taxmin qilish" soxta raqam bo'lardi.
    previous: {
      amount: formatAmount(previous.amount),
      paid: formatAmount(previous.paid),
      debt: formatAmount(previous.debt),
      invoicedCount: previous.invoicedCount,
      unpaidCount: previous.counts.unpaid + previous.counts.partial,
      paidCount: previous.counts.paid,
    },
    // Foiz — o'tgan oy noldan iborat bo'lsa `null` (ekranda strelka
    // chizilmaydi), 100% emas
    change: {
      amount: percentChange(totalAmount, previous.amount),
      paid: percentChange(totalPaid, previous.paid),
      debt: percentChange(totalAmount.minus(totalPaid), previous.debt),
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

  // ⚠️ AUDIT YOZUVI TRANZAKSIYADAN KEYIN: poyga tufayli rad etilgan urinish
  // ("allaqachon bekor qilingan", taqsimot CAS'i) logda BAJARILGAN bekor
  // qilish bo'lib qolmasligi kerak. O'tgan oy — tarixni qayta yozish,
  // shuning uchun aynan shu holat qayd etiladi.
  if (invoice.month < currentMonthKey()) {
    logger.warn(
      `[invoices] O'tgan oy hisob-fakturasi bekor qilindi: invoice=${id} ` +
        `student=${invoice.studentId} month=${invoice.month} ` +
        `depozitga=${formatAmount(released)} actor=${userId} sabab="${trimmed}"`,
    );
  }

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
const regenerateInvoice = async (id, reason, userId, { skipIfUnchanged = false } = {}) => {
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
  const [resolved, discounts, services, periods, monthOverride] = await Promise.all([
    resolveForStudentMonth(invoice.studentId, invoice.month),
    resolveDiscountsForStudent(invoice.studentId, invoice.month),
    resolveServicesForStudent(invoice.studentId, invoice.month),
    getPeriodsForStudent(invoice.studentId),
    resolveOverrideOne(invoice.studentId, invoice.month),
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
    services,
    periods,
    monthOverride,
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

  // Avtomatik regen tez-tez chaqiriladi (har tarif/chegirma o'zgarishida).
  // Summa AYNAN o'sha bo'lsa — cancel+recreate qilmaymiz: aks holda har
  // teginishda keraksiz `replacesInvoiceId` zanjiri va audit yozuvi paydo
  // bo'lardi. Faqat haqiqiy o'zgarishda qayta muhrlaymiz.
  if (
    skipIfUnchanged &&
    computed.amount.equals(invoice.amount) &&
    computed.baseAmount.equals(invoice.baseAmount) &&
    computed.proratedAmount.equals(invoice.proratedAmount ?? invoice.baseAmount) &&
    computed.discountAmount.equals(invoice.discountAmount ?? 0)
  ) {
    return getInvoiceById(invoice.id);
  }

  const created = await prisma.$transaction(async (tx) => {
    // ⚠️ COMPARE-AND-SWAP O'CHIRISH. `paidAmount` tekshiruvi tranzaksiyadan
    // TASHQARIDA bo'lgani uchun, tekshiruv bilan o'chirish orasida kassir
    // to'lov kiritib ulgursa, `delete` uning taqsimotlarini ham kaskad
    // bilan olib ketardi (`PaymentAllocation.invoice → onDelete: Cascade`):
    // chek `allocatedAmount` bilan turaveradi, hisob-faktura esa yo'q —
    // pul jimgina bug'lanardi. Endi bunday holatda o'chirish bajarilmaydi
    // va foydalanuvchi qayta urinishga chaqiriladi.
    const removed = await tx.monthlyInvoice.deleteMany({
      where: { id, paidAmount: 0 },
    });

    if (removed.count !== 1) {
      throw new ConflictError(
        "Hisob-fakturaga shu orada to'lov tushdi — qayta shakllantirib " +
          "bo'lmaydi. Avval to'lovni bekor qiling.",
      );
    }

    return tx.monthlyInvoice.create({
      data: {
        ...row,
        note: invoice.note,
        replacesInvoiceId: invoice.id,
      },
    });
  }, TX_OPTIONS);

  // ⚠️ AUDIT YOZUVI TRANZAKSIYADAN KEYIN: yuqoridagi CAS o'chirish rad
  // etilganda ("shu orada to'lov tushdi") logda BAJARILGAN qayta
  // shakllantirish bo'lib qolmasligi kerak. Yangi qator id'si ham
  // yoziladi — eskisi o'chirilgani uchun izni faqat shu bog'laydi.
  logger.warn(
    `[invoices] Hisob-faktura qayta shakllantirildi: invoice=${id} ` +
      `→ ${created.id} student=${invoice.studentId} month=${invoice.month} ` +
      `eski=${invoice.amount.toFixed(2)} yangi=${computed.amount.toFixed(2)} ` +
      `${computed.isProrated ? `(${row.billableDays}/${row.monthDays} kun) ` : ""}` +
      `actor=${userId} sabab="${trimmed}"`,
  );

  return getInvoiceById(created.id);
};

// ─────────────────────────────────────────────
// OMMAVIY AMALLAR (bitta oy bo'yicha)
// ─────────────────────────────────────────────
//
// ⚠️ IKKALASI HAM BITTALIK FUNKSIYALARNI CHAQIRADI, mustaqil SQL yozmaydi.
// Nusxa yozilsa, bittalik yo'lda bor tekshiruvlar (to'lov tushganmi,
// taqsimotlar bo'shatildimi, depozitga qaytdimi) ommaviy yo'lda tushib
// qolardi va farqi faqat pul yo'qolgandan keyin bilinardi.
//
// ⚠️ HAR QATOR ALOHIDA TRANZAKSIYADA. Bitta katta tranzaksiya bo'lsa,
// bitta buzuq qator butun oyni orqaga qaytarardi; bu yerda esa qolganlari
// baribir bajariladi va yiqilgani sababi bilan ro'yxatda qaytadi.

/** Ommaviy amallar uchun umumiy hisobot shakli. */
const emptyBulkSummary = (month) => ({
  month,
  monthLabel: formatMonthKey(month),
  total: 0,
  done: 0,
  skipped: [],
  failed: [],
});

const bulkRowLabel = (invoice) => {
  const snap = invoice.studentSnapshot ?? {};
  return (
    `${snap.firstName ?? ""} ${snap.lastName ?? ""}`.trim() || "Noma'lum o'quvchi"
  );
};

/**
 * BIR OYNING BARCHA HISOB-FAKTURASINI BEKOR QILADI.
 *
 * Kerak bo'ladigan holat: oy noto'g'ri ma'lumot bilan shakllantirilgan
 * (tarif hali biriktirilmagan, narx xato) va uni butunlay qaytadan
 * boshlash kerak. Bittalab bekor qilish 100+ o'quvchida amalda
 * bajarib bo'lmaydigan ish edi.
 *
 * ⚠️ TO'LOV TUSHGANI HAM BEKOR QILINADI va bu ATAYLAB: `cancelInvoice`
 * doktrinasi bo'yicha pul o'quvchi DEPOZITIGA qaytadi ("o'quvchi martda
 * ketdi, mayga qadar to'lab qo'ygan edi"). Ya'ni pul yo'qolmaydi —
 * qancha qaytgani hisobotda ko'rsatiladi.
 *
 * ⚠️ ALLAQACHON BEKOR QILINGANLARI TEGILMAYDI (`skipped`).
 *
 * @param {object} data - { month, reason }
 * @param {string} userId
 */
const cancelMonth = async (data, userId) => {
  const month = parseMonthKey(data.month, "Oy");
  const reason = data.reason?.trim();

  if (!reason) throw new BadRequestError("Bekor qilish sababi majburiy");

  const invoices = await prisma.monthlyInvoice.findMany({
    where: { month, status: { not: "cancelled" } },
    select: { id: true, studentId: true, studentSnapshot: true },
    orderBy: { createdAt: "asc" },
  });

  const summary = emptyBulkSummary(month);
  summary.total = invoices.length;
  summary.releasedToDeposit = "0.00";

  let released = new Decimal(0);

  for (const invoice of invoices) {
    try {
      const result = await cancelInvoice(invoice.id, reason, userId);
      released = released.plus(result.releasedToDeposit ?? 0);
      summary.done += 1;
    } catch (error) {
      summary.failed.push({
        invoiceId: invoice.id,
        studentId: invoice.studentId,
        studentName: bulkRowLabel(invoice),
        reason: error.message,
      });
    }
  }

  summary.releasedToDeposit = formatAmount(released);

  if (released.greaterThan(0)) {
    summary.warnings = [
      `${formatAmount(released)} so'm o'quvchilarning depozitiga qaytarildi — ` +
        "u keyingi oyga o'tadi yoki ota-onaga qaytariladi",
    ];
  }

  logger.warn(
    `[invoices] OMMAVIY BEKOR QILISH: ${formatMonthKey(month)} — ` +
      `${summary.done}/${summary.total} ta, depozitga ${formatAmount(released)}, ` +
      `actor=${userId} sabab="${reason}"`,
  );

  return summary;
};

/**
 * AVTOMATIK QAYTA SHAKLLANTIRISH — tarif/narx/chegirma o'zgargach chaqiriladi.
 *
 * Berilgan o'quvchilarning [fromMonth..joriy oy] oralig'idagi TO'LANMAGAN
 * hisob-fakturalarini yangi qoidalar bo'yicha qayta hisoblaydi. Shu tufayli
 * admin qo'lda "Qayta shakllantirish" bosishi shart emas.
 *
 * ⚠️ TO'LOV TUSHGANLARI (paidAmount > 0) TEGILMAYDI — summani o'zgartirish
 * taqsimotni yolg'onga aylantirardi; ular muhrlangan qoladi.
 * ⚠️ O'TGAN OY ham tegilmaydi (`fromMonth` joriy oygacha qisiladi) — sealed
 * tarixni jimgina qayta yozmaslik uchun; tarif o'zgarishi keyingi oydan.
 *
 * ⚠️ NOL SUMMALI "paid" FAKTURA HAM NOMZOD. 0 so'mlik faktura darhol
 * "to'langan" bo'lib yopiladi (buildInvoiceRow: isZero → paid) — unda
 * to'lov YO'Q (paidAmount = 0). Narx 0 dan ko'tarilganda (grant tarifiga
 * narx qo'yildi) aynan shu qatorlar qayta hisoblanishi kerak, aks holda
 * o'quvchi qarzdorlarga hech qachon tushmasdi.
 *
 * Xato bitta o'quvchida qolganini to'xtatmaydi (best-effort). Chaqiruvchi
 * tranzaksiyadan TASHQARIDA (commitdan keyin) chaqirishi kerak.
 *
 * @param {string[]} studentIds
 * @param {{fromMonth?: number}} options
 * @returns {Promise<{regenerated: number}>}
 */
const regenerateForStudents = async (studentIds, { fromMonth } = {}) => {
  const ids = [...new Set((studentIds || []).filter(Boolean))];
  if (ids.length === 0) return { regenerated: 0 };

  const now = currentMonthKey();
  // O'tgan oyga tushmaymiz — sealed. Joriy oydan yuqoriga chiqmaymiz — u oy
  // hali shakllanmagan (uning invoice'i yo'q).
  const from = fromMonth != null ? Math.min(fromMonth, now) : now;

  const invoices = await prisma.monthlyInvoice.findMany({
    where: {
      studentId: { in: ids },
      month: { gte: from, lte: now },
      OR: [
        { status: "unpaid" },
        // 0 so'mlik yopilgan faktura — to'lovsiz "paid" (yuqoridagi izoh)
        { status: "paid", paidAmount: 0, amount: 0 },
      ],
    },
    select: { id: true },
  });

  let regenerated = 0;
  for (const invoice of invoices) {
    try {
      await regenerateInvoice(
        invoice.id,
        "Avtomatik: tarif/narx/chegirma o'zgardi",
        null,
        { skipIfUnchanged: true },
      );
      regenerated += 1;
    } catch (error) {
      // To'lov tushgan yoki boshqa sabab — jim o'tkazamiz (best-effort)
      logger.warn(
        `[auto-regen] invoice ${invoice.id} qayta shakllantirilmadi: ${error.message}`,
      );
    }
  }

  return { regenerated };
};

/**
 * BITTA TARIFGA biriktirilgan o'quvchilarning HALI TO'LANMAGAN
 * hisob-fakturalarini qayta shakllantiradi — narx (yoki versiya davri)
 * o'zgargach chaqiriladi.
 *
 * Biriktirma yozuvi orqali nomzod o'quvchilar topiladi, so'ng
 * `regenerateForStudents` har birini JONLI qayta hisoblaydi. Kengroq to'plam
 * xavfsiz: keyinchalik boshqa tarifga o'tgan o'quvchi ham qayta hisoblanadi,
 * lekin natija o'zgarmaydi (builder yutgan tarifni oladi).
 *
 * @param {string} tariffId
 * @param {{fromMonth?: number}} [opts]
 * @returns {Promise<{regenerated: number}>}
 */
const regenerateForTariff = async (tariffId, { fromMonth } = {}) => {
  if (!tariffId) return { regenerated: 0 };

  const now = currentMonthKey();
  const from = fromMonth != null ? Math.min(fromMonth, now) : now;

  const assignments = await prisma.studentTariff.findMany({
    where: {
      tariffId,
      startMonth: { lte: now },
      OR: [{ endMonth: null }, { endMonth: { gte: from } }],
    },
    select: { studentId: true },
  });

  const studentIds = [...new Set(assignments.map((a) => a.studentId))];
  return regenerateForStudents(studentIds, { fromMonth: from });
};

/**
 * JORIY FILIALDAGI BARCHA to'lanmagan hisob-fakturani joriy tarif/narx/chegirmaga
 * moslashtiradi — "catch-up". Server ishga tushganda va kunlik cronda ishlaydi.
 *
 * Eski, muhrlangan (lekin to'lanmagan) fakturalar narx o'zgargandan keyin ham
 * eski summada qolib ketmasin uchun: har birini JONLI qayta hisoblaydi.
 * `skipIfUnchanged` tufayli summa aynan o'sha bo'lsa hech narsa yozilmaydi —
 * shuning uchun har startup'da bemalol ishlayveradi (o'zgarmagani churn qilmaydi).
 * To'langan oylar chetda qoladi.
 *
 * @param {{fromMonth?: number}} [opts] - null bo'lsa joriy oygacha BARCHA
 *   to'lanmagan oylar
 * @returns {Promise<{total: number, changed: number, failed: number}>}
 */
const regenerateAllUnpaid = async ({ fromMonth = null } = {}) => {
  const now = currentMonthKey();
  const where = {
    month: { lte: now },
    OR: [
      { status: "unpaid" },
      // 0 so'mlik yopilgan faktura — to'lovsiz "paid" (regenerateForStudents
      // dagi izoh): grant tarifiga narx qo'yilganda shular ham tekislanadi
      { status: "paid", paidAmount: 0, amount: 0 },
    ],
  };
  if (fromMonth != null) where.month.gte = fromMonth;

  const invoices = await prisma.monthlyInvoice.findMany({
    where,
    select: { id: true },
    orderBy: { month: "asc" },
  });

  let changed = 0;
  let failed = 0;
  for (const inv of invoices) {
    try {
      const out = await regenerateInvoice(
        inv.id,
        "Avtomatik: joriy tarif narxiga moslashtirildi",
        null,
        { skipIfUnchanged: true },
      );
      // Yangi id qaytsa — qayta yozildi; o'sha id qaytsa — o'zgarmagan (skip)
      if (out?.id && out.id !== inv.id) changed += 1;
    } catch (error) {
      failed += 1;
      logger.warn(`[catchup] invoice ${inv.id} qayta hisoblanmadi: ${error.message}`);
    }
  }

  return { total: invoices.length, changed, failed };
};

/**
 * BIR OYNING BARCHA HISOB-FAKTURASINI QAYTA SHAKLLANTIRADI.
 *
 * Bu — "tarifni to'g'riladim, endi oy yangilansin" tugmasi. Oddiy
 * "Shakllantirish" faqat YO'Q qatorlarni yozadi (mavjudi muhrlangan),
 * shuning uchun tarif o'zgargandan keyin u hech narsani yangilamasdi va
 * foydalanuvchi har bir qatorni qo'lda bosib chiqishga majbur edi.
 *
 * ⚠️ TO'LOV TUSHGANLARI TEGILMAYDI (`skipped`): summani o'zgartirish
 * to'lov taqsimotini yolg'onga aylantirardi. Ularni to'g'rilash uchun
 * avval to'lov bekor qilinadi — bu ongli, alohida qaror.
 *
 * ⚠️ BEKOR QILINGANLARI ham tegilmaydi: ular qaror, bo'shliq emas.
 * Ularni qaytarish uchun "Qaytarish" yoki "Shakllantirish" ishlatiladi.
 *
 * @param {object} data - { month, reason }
 * @param {string} userId
 */
const regenerateMonth = async (data, userId) => {
  const month = parseMonthKey(data.month, "Oy");
  const reason = data.reason?.trim();

  if (!reason) throw new BadRequestError("Qayta shakllantirish sababi majburiy");

  const invoices = await prisma.monthlyInvoice.findMany({
    where: { month, status: { not: "cancelled" } },
    select: {
      id: true,
      studentId: true,
      studentSnapshot: true,
      paidAmount: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const summary = emptyBulkSummary(month);
  summary.total = invoices.length;
  summary.unchanged = 0;

  let before = new Decimal(0);
  let after = new Decimal(0);

  for (const invoice of invoices) {
    // To'lov tushganini bittalik funksiya ham rad etadi — bu yerda
    // OLDINDAN ajratiladi, chunki u XATO emas, kutilgan hol va uni
    // `failed` ro'yxatiga tushirish ekranni qizil xatolarga to'ldirardi.
    if (new Decimal(invoice.paidAmount).greaterThan(0)) {
      summary.skipped.push({
        invoiceId: invoice.id,
        studentId: invoice.studentId,
        studentName: bulkRowLabel(invoice),
        reason: "To'lov tushgan — avval to'lovni bekor qiling",
      });
      continue;
    }

    try {
      const fresh = await prisma.monthlyInvoice.findUnique({
        where: { id: invoice.id },
        select: { amount: true },
      });

      const result = await regenerateInvoice(invoice.id, reason, userId);

      before = before.plus(fresh?.amount ?? 0);
      after = after.plus(result.amount ?? 0);
      summary.done += 1;
    } catch (error) {
      summary.failed.push({
        invoiceId: invoice.id,
        studentId: invoice.studentId,
        studentName: bulkRowLabel(invoice),
        reason: error.message,
      });
    }
  }

  // "Nima o'zgardi" — bitta qatorda. Bu bo'lmasa foydalanuvchi tugmani
  // bosgan-u, natijani ko'rish uchun jadvalni varaqlashga majbur bo'lardi.
  summary.amountBefore = formatAmount(before);
  summary.amountAfter = formatAmount(after);
  summary.amountChange = formatAmount(after.minus(before));

  logger.warn(
    `[invoices] OMMAVIY QAYTA SHAKLLANTIRISH: ${formatMonthKey(month)} — ` +
      `${summary.done}/${summary.total} ta, ${formatAmount(before)} → ` +
      `${formatAmount(after)}, o'tkazib yuborilgan ${summary.skipped.length}, ` +
      `actor=${userId} sabab="${reason}"`,
  );

  return summary;
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

  await prisma.monthlyInvoice.update({
    where: { id },
    data: { status, cancelReason: "", cancelledAt: null, cancelledBy: null },
  });

  // AUDIT YOZUVI YOZUVDAN KEYIN (modul bo'ylab bitta tartib)
  logger.warn(
    `[invoices] Bekor qilingan hisob-faktura qaytarildi: invoice=${id} ` +
      `month=${invoice.month} holat=${status} actor=${userId}`,
  );

  return getInvoiceById(id);
};

module.exports = {
  STATUS_LABELS,
  cancelMonth,
  regenerateMonth,
  serializeInvoice,
  getInvoices,
  getInvoiceById,
  getStudentInvoices,
  getStudentRegistry,
  getOverviewDashboard,
  getDebtors,
  getMyFinance,
  getSummary,
  updateNote,
  cancelInvoice,
  regenerateInvoice,
  regenerateForStudents,
  regenerateForTariff,
  regenerateAllUnpaid,
  restoreInvoice,
};
