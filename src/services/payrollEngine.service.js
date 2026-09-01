/**
 * PAYROLL ENGINE — bitta xodim/o'qituvchi uchun oylik komponentlarini hisoblaydi.
 *
 * FINAL = BASE (lavozim) + FIXED (ixtiyoriy) + TEACHING (toifa × dars soati)
 *         + APPROVED BONUSES
 *
 *   staff (Texnik/Boshqaruv):  base = position.baseSalary
 *   teacher (MTB/Boshlang'ich/Yuqori): teaching = category.perHourRate × hours
 *   fixed  — ixtiyoriy qo'shimcha (mavjud StaffSalary.fixedAmount qatlami)
 *   bonus  — tasdiqlangan PayrollBonus + eski StaffSalary.allowances
 *
 * Bir joyda hisoblanadi va HAM generatsiya (muhrlash), HAM admin ko'rinishi
 * (preview) shu funksiyani chaqiradi — ikki xil raqam chiqmaydi.
 */

const prisma = require("../config/prisma");
const { Decimal, formatAmount } = require("../helpers/money.helpers");
const { ROLES } = require("../utils/constants");
const { resolveSalariesForMonth } = require("./staffSalary.service");
const { computeLessonHoursForMonth } = require("./lessonHours.service");

const round2 = (d) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

const coveringBonusWhere = (month) => ({
  isActive: true,
  startMonth: { lte: month },
  OR: [{ endMonth: null }, { endMonth: { gte: month } }],
});

/**
 * Oy uchun payroll kontekstini bir marta yuklaydi (N+1 so'rovsiz).
 * @param {number} month - YYYYMM
 * @param {Array} users - {id, positionId, salaryCategoryId, ...}
 */
const loadContext = async (month, users, preloaded = {}) => {
  const positionIds = [...new Set(users.map((u) => u.positionId).filter(Boolean))];
  const categoryIds = [...new Set(users.map((u) => u.salaryCategoryId).filter(Boolean))];
  const teacherIds = users.filter((u) => u.salaryCategoryId).map((u) => u.id);
  const staffIds = users.map((u) => u.id);

  const salaryRules = preloaded.salaryRules || (await resolveSalariesForMonth(month));

  const [positions, categories, hoursMap, bonusRows] = await Promise.all([
    positionIds.length
      ? prisma.position.findMany({
          where: { id: { in: positionIds } },
          include: { department: { select: { name: true } } },
        })
      : [],
    categoryIds.length
      ? prisma.salaryCategory.findMany({
          where: { id: { in: categoryIds } },
          include: { department: { select: { name: true } } },
        })
      : [],
    computeLessonHoursForMonth(month, teacherIds),
    prisma.payrollBonus.findMany({
      where: { staffId: { in: staffIds }, ...coveringBonusWhere(month) },
    }),
  ]);

  const positionMap = new Map(positions.map((p) => [p.id, p]));
  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const bonusMap = new Map();
  for (const b of bonusRows) {
    if (!bonusMap.has(b.staffId)) bonusMap.set(b.staffId, []);
    bonusMap.get(b.staffId).push(b);
  }

  return { positionMap, categoryMap, salaryRules, hoursMap, bonusMap };
};

/**
 * Bitta xodim uchun komponentlarni hisoblaydi.
 * @returns {{ eligible, salaryType, fixedAmount, kpiAmount, allowanceAmount,
 *   lessonHours, perHourRate, amount, allowanceBreakdown, categoryName,
 *   positionName, departmentName }|null}
 */
const computeForStaff = (user, month, ctx) => {
  const position = user.positionId ? ctx.positionMap.get(user.positionId) : null;
  const category = user.salaryCategoryId ? ctx.categoryMap.get(user.salaryCategoryId) : null;
  const rule = ctx.salaryRules.get(user.id) || null;

  // Biriktirilmagan (na lavozim, na toifa, na eski qoida) → payroll yo'q
  if (!position && !category && !rule) return null;

  const base = new Decimal(position ? position.baseSalary : 0);
  const extraFixed = new Decimal(rule ? rule.fixedAmount : 0);
  const fixedAmount = base.plus(extraFixed);

  const hoursInfo = ctx.hoursMap.get(user.id);
  const hours = new Decimal(hoursInfo?.hours ?? 0);
  const perHourRate = new Decimal(category ? category.perHourRate : rule ? rule.perHourRate : 0);
  const kpiAmount = round2(perHourRate.times(hours));

  const preBonus = fixedAmount.plus(kpiAmount);

  // Ustamalar: tasdiqlangan PayrollBonus + eski StaffSalary.allowances
  const rawBonuses = [
    ...(ctx.bonusMap.get(user.id) || []).map((b) => ({
      label: b.label || "Ustama",
      type: b.type,
      value: Number(b.value),
    })),
    ...(rule && Array.isArray(rule.allowances) ? rule.allowances : []),
  ];

  let allowanceAmount = new Decimal(0);
  const allowanceBreakdown = [];
  for (const b of rawBonuses) {
    const amt =
      b.type === "percent"
        ? round2(preBonus.times(b.value).div(100))
        : round2(new Decimal(b.value));
    allowanceAmount = allowanceAmount.plus(amt);
    allowanceBreakdown.push({ label: b.label, type: b.type, value: b.value, amount: formatAmount(amt) });
  }

  const amount = fixedAmount.plus(kpiAmount).plus(allowanceAmount);

  const hasFixed = fixedAmount.greaterThan(0);
  const hasKpi = kpiAmount.greaterThan(0) || Boolean(category);
  const salaryType = hasFixed && hasKpi ? "mixed" : hasKpi ? "kpi" : "fixed";

  const departmentName =
    position?.department?.name || category?.department?.name || "";

  return {
    eligible: true,
    salaryType,
    fixedAmount,
    kpiAmount,
    allowanceAmount,
    lessonHours: hours,
    perHourRate,
    amount,
    allowanceBreakdown,
    categoryName: category?.name ?? "",
    positionName: position?.name ?? "",
    departmentName,
  };
};

/** Preview (formatlangan) — admin ko'rinishlari uchun. */
const previewForStaff = (user, month, ctx) => {
  const c = computeForStaff(user, month, ctx);
  if (!c) return null;
  return {
    salaryType: c.salaryType,
    fixedAmount: formatAmount(c.fixedAmount),
    kpiAmount: formatAmount(c.kpiAmount),
    allowanceAmount: formatAmount(c.allowanceAmount),
    lessonHours: Number(c.lessonHours),
    perHourRate: formatAmount(c.perHourRate),
    amount: formatAmount(c.amount),
    allowanceBreakdown: c.allowanceBreakdown,
    categoryName: c.categoryName,
    positionName: c.positionName,
    departmentName: c.departmentName,
  };
};

module.exports = {
  loadContext,
  computeForStaff,
  previewForStaff,
};
