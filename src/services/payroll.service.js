/**
 * OYLIK MAJBURIYATLARI — `MonthlyInvoice` ning chiqim tomonidagi ko'zgusi.
 *
 * Qoida (`StaffSalary`) → har oy MAJBURIYAT (`PayrollEntry`) → to'lov uni
 * yopadi. Shu tufayli "kimga qancha qarzdormiz" degan savolga javob bor.
 *
 * ⚠️ QAYTARILMASLIK: `amount` ni o'zgartiradigan funksiya YO'Q. Qoida keyin
 * to'g'rilansa, tuzatish KEYINGI oydan amal qiladi. Yagona olib tashlash
 * yo'li — `cancelled` holati, sababi bilan; to'lov tushgan majburiyat esa
 * umuman bekor qilinmaydi.
 *
 * ⚠️ Kun proratsiyasi YO'Q — "fiksa" qat'iy summa, oy aniqligida.
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
  resolveSalariesForMonth,
  TYPE_LABELS,
  STAFF_SELECT,
} = require("./staffSalary.service");
const { computeLessonHoursForMonth } = require("./lessonHours.service");
const { loadCategoriesByIds } = require("./salaryCategory.service");
const { computeAllowances } = require("../helpers/salaryRules.helpers");

const STATUS_LABELS = {
  unpaid: "To'lanmagan",
  partial: "Qisman to'langan",
  paid: "To'langan",
  cancelled: "Bekor qilingan",
};

const serializeEntry = (row, { staff } = {}) => {
  const debt = new Decimal(row.amount).minus(row.paidAmount);

  return {
    ...row,
    amount: formatAmount(row.amount),
    fixedAmount: formatAmount(row.fixedAmount ?? 0),
    allowanceAmount: formatAmount(row.allowanceAmount ?? 0),
    allowanceBreakdown: Array.isArray(row.allowanceBreakdown) ? row.allowanceBreakdown : [],
    kpiAmount: formatAmount(row.kpiAmount ?? 0),
    perHourRate: formatAmount(row.perHourRate ?? 0),
    lessonHours: Number(row.lessonHours ?? 0),
    categoryName: row.categoryName ?? "",
    salaryTypeLabel: TYPE_LABELS[row.salaryType] ?? row.salaryType,
    paidAmount: formatAmount(row.paidAmount),
    // Ortiqcha to'lov RAD ETILADI, shuning uchun manfiy bo'lmasligi kerak —
    // lekin himoya qavati qoladi
    debt: formatAmount(debt.isNegative() ? new Decimal(0) : debt),
    monthLabel: formatMonthKey(row.month),
    statusLabel: STATUS_LABELS[row.status] ?? row.status,
    // Xodim arxivlangan/o'chirilgan bo'lishi mumkin — snapshot qutqaradi
    staff: staff ?? null,
    staffName: staff
      ? `${staff.firstName} ${staff.lastName ?? ""}`.trim()
      : `${row.staffSnapshot?.firstName ?? ""} ${row.staffSnapshot?.lastName ?? ""}`.trim() ||
        "Noma'lum",
    roleLabel: staff?.role ?? row.staffSnapshot?.role ?? null,
  };
};

// ─────────────────────────────────────────────
// Shakllantirish
// ─────────────────────────────────────────────

const emptySummary = (month, reason) => ({
  month,
  monthLabel: formatMonthKey(month),
  reason,
  dryRun: false,
  eligible: 0,
  created: 0,
  totalAmount: "0.00",
  fixedTotal: "0.00",
  kpiTotal: "0.00",
  // zeroAmount — faqat KPI oladigan, lekin shu oy darsi bo'lmagan xodim
  skipped: { alreadyExists: 0, noSalary: 0, archived: 0, zeroAmount: 0 },
  durationMs: 0,
});

/**
 * Bir oy uchun oylik majburiyatlarini shakllantiradi.
 *
 * IDEMPOTENT: `@@unique([staffId, month])` va oldindan tekshiruv tufayli
 * ikki marta chaqirish ikkinchi qator yaratmaydi.
 *
 * ⚠️ Bekor qilingan majburiyat ham "mavjud" hisoblanadi — u QAROR, bo'shliq
 * emas. Aks holda cron ertasiga uni qaytadan yozib qo'yardi.
 *
 * @param {number|string} monthInput
 * @param {object} options - { dryRun, staffIds, actorId }
 */
const generateForMonth = async (monthInput, options = {}) => {
  const startedAt = Date.now();
  const month = parseMonthKey(monthInput, "Oy");
  const { dryRun = false, staffIds, actorId = null } = options;

  if (month > currentMonthKey()) {
    throw new BadRequestError("Kelajakdagi oy uchun oylik shakllantirilmaydi");
  }

  const summary = emptySummary(month, null);

  // 1 ── Oylik qoidasi bor xodimlar (bitta so'rov)
  const salaries = await resolveSalariesForMonth(month);
  if (salaries.size === 0) {
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const ids = staffIds?.length
    ? [...salaries.keys()].filter((id) => staffIds.includes(id))
    : [...salaries.keys()];

  // 2 ── Xodimlar. `isArchived` FILTRLANADI: ketgan odamga oylik yozilmaydi.
  // (O'quvchi tomonida `isActive` ataylab filtrlanmaydi — u yerda qarz
  // bekor bo'lmaydi. Bu yerda esa aksincha: biz to'laymiz.)
  const staff = await prisma.user.findMany({
    where: { id: { in: ids }, isArchived: false, role: { not: ROLES.STUDENT } },
    select: STAFF_SELECT,
  });

  summary.skipped.archived = ids.length - staff.length;
  summary.eligible = staff.length;

  if (staff.length === 0) {
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  // 3 ── Allaqachon shakllantirilganlari
  const existing = await prisma.payrollEntry.findMany({
    where: { month, staffId: { in: staff.map((s) => s.id) } },
    select: { staffId: true },
  });
  const existingIds = new Set(existing.map((e) => e.staffId));

  // 3.5 ── Toifalar (KPI stavka manbai) va dars soatlarini yuklaymiz.
  const eligibleSalaries = staff.map((s) => salaries.get(s.id)).filter(Boolean);
  const categoryMap = await loadCategoriesByIds(
    eligibleSalaries.map((s) => s.categoryId),
  );
  // KPI oladigan xodimlar: toifa yoki qo'lda stavka bor
  const kpiStaffIds = staff
    .filter((s) => {
      const rule = salaries.get(s.id);
      if (!rule) return false;
      const rate = rule.categoryId
        ? categoryMap.get(rule.categoryId)?.perHourRate
        : rule.perHourRate;
      return new Decimal(rate ?? 0).greaterThan(0);
    })
    .map((s) => s.id);
  const hoursMap = await computeLessonHoursForMonth(month, kpiStaffIds);

  // 4 ── Qatorlarni yig'ish
  const rows = [];
  let total = new Decimal(0);
  let fixedTotal = new Decimal(0);
  let kpiTotal = new Decimal(0);

  for (const person of staff) {
    if (existingIds.has(person.id)) {
      summary.skipped.alreadyExists += 1;
      continue;
    }

    const salary = salaries.get(person.id);
    if (!salary) {
      summary.skipped.noSalary += 1;
      continue;
    }

    const fixedAmount = new Decimal(salary.fixedAmount);

    // Ustama qoidalari (foizlilar fiksadan)
    const allowances = Array.isArray(salary.allowances) ? salary.allowances : [];
    const { total: allowanceAmount, breakdown: allowanceBreakdown } = computeAllowances(
      fixedAmount,
      allowances,
    );

    // KPI: stavka toifadan yoki qo'lda; soat schedule'dan
    const category = salary.categoryId ? categoryMap.get(salary.categoryId) : null;
    const kpiRate = new Decimal(category ? category.perHourRate : salary.perHourRate || 0);
    const hours = new Decimal(hoursMap.get(person.id)?.hours ?? 0);
    const kpiAmount = kpiRate.times(hours).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    const amount = fixedAmount.plus(allowanceAmount).plus(kpiAmount);

    // Faqat KPI oladigan, lekin shu oy darsi bo'lmagan xodimga 0 li majburiyat
    // yozilmaydi (shovqin bo'lardi). Fiksa/ustama komponent bo'lsa amount > 0.
    if (amount.lessThanOrEqualTo(0)) {
      summary.skipped.zeroAmount += 1;
      continue;
    }

    total = total.plus(amount);
    fixedTotal = fixedTotal.plus(fixedAmount).plus(allowanceAmount);
    kpiTotal = kpiTotal.plus(kpiAmount);

    rows.push({
      staffId: person.id,
      month,
      amount,
      fixedAmount,
      allowanceAmount,
      allowanceBreakdown,
      kpiAmount,
      lessonHours: hours,
      perHourRate: kpiRate,
      categoryName: category?.name ?? "",
      salaryType: salary.type,
      staffSnapshot: {
        firstName: person.firstName,
        lastName: person.lastName ?? "",
        username: person.username,
        role: person.role,
      },
      createdBy: actorId,
    });
  }

  summary.created = rows.length;
  summary.totalAmount = formatAmount(total);
  summary.fixedTotal = formatAmount(fixedTotal);
  summary.kpiTotal = formatAmount(kpiTotal);
  summary.dryRun = dryRun;

  if (!dryRun && rows.length > 0) {
    await prisma.payrollEntry.createMany({ data: rows, skipDuplicates: true });
    logger.info(
      `[payroll] ${formatMonthKey(month)}: ${rows.length} ta oylik majburiyati, ` +
        `jami ${formatAmount(total)}`,
    );
  }

  summary.durationMs = Date.now() - startedAt;
  return summary;
};

// ─────────────────────────────────────────────
// Registr
// ─────────────────────────────────────────────

/** Oylik majburiyatlari ro'yxati (sahifalangan). */
const getEntries = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const where = {};

  if (query.month) where.month = parseMonthKey(query.month, "Oy");
  else {
    const from = parseOptionalMonthKey(query.fromMonth, "Boshlanish oyi");
    const to = parseOptionalMonthKey(query.toMonth, "Tugash oyi");
    if (from != null || to != null) {
      where.month = {
        ...(from != null ? { gte: from } : {}),
        ...(to != null ? { lte: to } : {}),
      };
    }
  }

  if (query.staffId) where.staffId = query.staffId;

  if (query.status) {
    if (!STATUS_LABELS[query.status]) throw new BadRequestError("Holat noto'g'ri");
    where.status = query.status;
  } else if (query.debtOnly === "true") {
    where.status = { in: ["unpaid", "partial"] };
  } else if (query.includeCancelled !== "true") {
    where.status = { not: "cancelled" };
  }

  const [rows, total, agg] = await Promise.all([
    prisma.payrollEntry.findMany({
      where,
      orderBy: [{ month: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    prisma.payrollEntry.count({ where }),
    prisma.payrollEntry.aggregate({
      where: { ...where, status: { not: "cancelled" } },
      _sum: { amount: true, paidAmount: true },
    }),
  ]);

  const staff = rows.length
    ? await prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.staffId))] } },
        select: STAFF_SELECT,
      })
    : [];
  const staffMap = new Map(staff.map((s) => [s.id, s]));

  const accrued = new Decimal(agg._sum.amount ?? 0);
  const paid = new Decimal(agg._sum.paidAmount ?? 0);
  const debt = accrued.minus(paid);

  return {
    ...formatPaginationResponse(
      rows.map((row) => serializeEntry(row, { staff: staffMap.get(row.staffId) })),
      total,
      page,
      limit,
    ),
    totals: {
      accrued: formatAmount(accrued),
      paid: formatAmount(paid),
      debt: formatAmount(debt.isNegative() ? new Decimal(0) : debt),
    },
  };
};

/** Bitta xodimning oylik tarixi va qarzi. */
const getStaffEntries = async (staffId) => {
  const [staff, rows, agg] = await Promise.all([
    prisma.user.findUnique({ where: { id: staffId }, select: STAFF_SELECT }),
    prisma.payrollEntry.findMany({
      where: { staffId, status: { not: "cancelled" } },
      orderBy: { month: "desc" },
      include: {
        allocations: {
          where: { isVoided: false },
          orderBy: { appliedAt: "desc" },
          include: { payment: { select: { paidAt: true, accountId: true } } },
        },
      },
    }),
    prisma.payrollEntry.aggregate({
      where: { staffId, status: { not: "cancelled" } },
      _sum: { amount: true, paidAmount: true },
    }),
  ]);

  if (!staff) throw new NotFoundError("Xodim topilmadi");

  const accrued = new Decimal(agg._sum.amount ?? 0);
  const paid = new Decimal(agg._sum.paidAmount ?? 0);
  const debt = accrued.minus(paid);

  return {
    staff,
    totals: {
      accrued: formatAmount(accrued),
      paid: formatAmount(paid),
      debt: formatAmount(debt.isNegative() ? new Decimal(0) : debt),
      unpaidCount: rows.filter((r) => r.status !== "paid").length,
    },
    items: rows.map(({ allocations, ...row }) => ({
      ...serializeEntry(row, { staff }),
      payments: allocations.map((a) => ({
        id: a.id,
        amount: formatAmount(a.amount),
        appliedAt: a.appliedAt,
        paidAt: a.payment?.paidAt ?? null,
      })),
    })),
  };
};

// ─────────────────────────────────────────────
// Bekor qilish
// ─────────────────────────────────────────────

/**
 * Majburiyatni bekor qilish — summani o'zgartirishning YAGONA yo'li emas,
 * balki uni OLIB TASHLASH yo'li. Xato summa bo'lsa: bekor qilinadi, qoida
 * to'g'rilanadi, qayta shakllantiriladi.
 *
 * ⚠️ To'lov tushgan majburiyat bekor qilinmaydi — avval to'lov bekor
 * qilinishi kerak. Aks holda to'langan pul "havoda" qolardi.
 */
const cancelEntry = async (id, reason, userId) => {
  const entry = await prisma.payrollEntry.findUnique({ where: { id } });
  if (!entry) throw new NotFoundError("Oylik majburiyati topilmadi");

  if (entry.status === "cancelled") {
    throw new BadRequestError("Majburiyat allaqachon bekor qilingan");
  }

  if (new Decimal(entry.paidAmount).greaterThan(0)) {
    throw new BadRequestError(
      "Bu majburiyatga to'lov tushgan — avval to'lovni bekor qiling",
    );
  }

  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError("Bekor qilish sababi majburiy");

  logger.warn(
    `[payroll] Majburiyat bekor qilindi: entry=${id} ` +
      `staff=${entry.staffId} oy=${entry.month} summa=${formatAmount(entry.amount)} ` +
      `actor=${userId} sabab="${trimmed}"`,
  );

  const updated = await prisma.payrollEntry.update({
    where: { id },
    data: {
      status: "cancelled",
      cancelReason: trimmed,
      cancelledAt: new Date(),
      cancelledBy: userId,
    },
  });

  return serializeEntry(updated);
};

module.exports = {
  STATUS_LABELS,
  serializeEntry,
  generateForMonth,
  getEntries,
  getStaffEntries,
  cancelEntry,
};
