/**
 * PAYROLL ENGINE — bitta xodim/o'qituvchi uchun oylik komponentlarini hisoblaydi.
 *
 * FINAL = BASE (lavozim) + FIXED (ixtiyoriy) + TEACHING (toifa × dars soati)
 *         + APPROVED BONUSES + TUTOR GROUPS − DEDUCTIONS (ushlab qolish, yalpidan oshmaydi)
 *
 *   staff (Texnik/Boshqaruv):  base = position.baseSalary
 *                              (yoki xodimning shaxsiy maoshi — `customBaseSalary`)
 *   teacher (MTB/Boshlang'ich/Yuqori): teaching = category.perHourRate × hours
 *   fixed  — ixtiyoriy qo'shimcha (mavjud StaffSalary.fixedAmount qatlami)
 *   bonus  — tasdiqlangan PayrollBonus + eski StaffSalary.allowances
 *   tutor  — tyutor guruhlari: har sinf uchun guruh summasi + o'quvchiga
 *            summa × o'quvchilar soni (`TutorGroup`, ustama qatori `type: "tutor"`)
 *
 * Bir joyda hisoblanadi va HAM generatsiya (muhrlash), HAM admin ko'rinishi
 * (preview) shu funksiyani chaqiradi — ikki xil raqam chiqmaydi.
 */

const prisma = require("../config/prisma");
const { Decimal, formatAmount } = require("../helpers/money.helpers");
const { ROLES } = require("../utils/constants");
const { resolveSalariesForMonth } = require("./staffSalary.service");
const { computeDeductions, computeTutorGroupAmount } = require("../helpers/salaryRules.helpers");
const { computeLessonHoursForMonth } = require("./lessonHours.service");
const { loadGroupsForPayroll } = require("./tutorGroup.service");

const round2 = (d) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

const coveringBonusWhere = (month) => ({
  isActive: true,
  startMonth: { lte: month },
  OR: [{ endMonth: null }, { endMonth: { gte: month } }],
});

/**
 * Oy uchun payroll kontekstini bir marta yuklaydi (N+1 so'rovsiz).
 *
 * ⚠️ `preloaded.hoursMap` — chaqiruvchi dars soatini ALLAQACHON hisoblagan
 * bo'lsa, uni qayta hisoblamaslik uchun. `lessonHoursDashboard` soatni
 * kesim kuni bilan o'qiydi va o'sha bitta natijadan ikki xil kontekst
 * quradi ("bugungacha" va "oy oxirida") — bu yerda qayta hisoblansa,
 * kesim yo'qolib, ikkala raqam bir xil chiqib qolardi.
 *
 * @param {number} month - YYYYMM
 * @param {Array} users - {id, positionId, salaryCategoryId, ...}
 * @param {object} [preloaded] - { salaryRules, hoursMap }
 */
const loadContext = async (month, users, preloaded = {}) => {
  const positionIds = [...new Set(users.map((u) => u.positionId).filter(Boolean))];
  const categoryIds = [...new Set(users.map((u) => u.salaryCategoryId).filter(Boolean))];
  const staffIds = users.map((u) => u.id);

  const salaryRules = preloaded.salaryRules || (await resolveSalariesForMonth(month));

  // Soat kerak bo'lganlar: toifasi bor YOKI qoidasida qo'lda soat narxi bor.
  // ⚠️ Faqat toifa bo'yicha filtrlansa, qo'lda stavkali o'qituvchining soati
  // 0 bo'lib qolardi: vedomost (soatni o'zi yuklaydi) KPI ni ko'rsatardi,
  // shakllantirilgan majburiyat esa KPI siz muhrlanardi.
  const teacherIds = users
    .filter(
      (u) =>
        u.salaryCategoryId ||
        new Decimal(salaryRules.get(u.id)?.perHourRate ?? 0).greaterThan(0),
    )
    .map((u) => u.id);

  const [positions, categories, hoursMap, bonusRows, deductionRows, customBaseRows, tutor] = await Promise.all([
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
    preloaded.hoursMap || computeLessonHoursForMonth(month, teacherIds),
    prisma.payrollBonus.findMany({
      where: { staffId: { in: staffIds }, ...coveringBonusWhere(month) },
    }),
    // Ushlab qolish — YARATILISH TARTIBIDA: yalpidan oshsa, chegara
    // avval yozilganidan boshlab qo'llanadi (`computeDeductions`)
    staffIds.length
      ? prisma.payrollDeduction.findMany({
          where: {
            staffId: { in: staffIds },
            status: "active",
            startMonth: { lte: month },
            OR: [{ endMonth: null }, { endMonth: { gte: month } }],
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      : [],
    // SHAXSIY MAOSH — chaqiruvchining `select` iga ishonilmaydi: bitta
    // ekranda maydon tanlanmay qolsa, u lavozim maoshini ko'rsatib, vedomost
    // bilan boshqa raqam chiqarardi. Shu yerda bir marta, bazadan.
    positionIds.length
      ? prisma.user.findMany({
          where: { id: { in: staffIds }, customBaseSalary: { not: null } },
          select: { id: true, positionId: true, customBaseSalary: true },
        })
      : [],
    // TYUTOR GURUHLARI — o'quvchilar soni bilan, bir marta
    loadGroupsForPayroll(month, staffIds),
  ]);

  // Faqat O'SHA lavozimda amal qiladi: taxminiy (hypothetical) lavozim
  // almashtirishda eski shaxsiy summa yangi lavozimga ko'chib ketmasin
  const customBaseMap = new Map(
    customBaseRows
      .filter((row) => row.customBaseSalary != null && row.positionId)
      .map((row) => [row.id, { positionId: row.positionId, amount: row.customBaseSalary }]),
  );

  const deductionMap = new Map();
  for (const d of deductionRows) {
    if (!deductionMap.has(d.staffId)) deductionMap.set(d.staffId, []);
    deductionMap.get(d.staffId).push(d);
  }

  const positionMap = new Map(positions.map((p) => [p.id, p]));
  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const bonusMap = new Map();
  for (const b of bonusRows) {
    if (!bonusMap.has(b.staffId)) bonusMap.set(b.staffId, []);
    bonusMap.get(b.staffId).push(b);
  }

  return {
    positionMap,
    categoryMap,
    salaryRules,
    hoursMap,
    bonusMap,
    deductionMap,
    customBaseMap,
    tutorGroupMap: tutor.groupMap,
    classStudentCounts: tutor.studentCounts,
  };
};

/**
 * Lavozim bazasi: shaxsiy maosh bo'lsa — u, aks holda lavozim maoshi.
 * @returns {{ amount: Decimal, isCustom: boolean }}
 */
const resolvePositionBase = (user, position, ctx) => {
  if (!position) return { amount: new Decimal(0), isCustom: false };
  const custom = ctx.customBaseMap?.get(user.id);
  if (custom && custom.positionId === user.positionId) {
    return { amount: new Decimal(custom.amount), isCustom: true };
  }
  return { amount: new Decimal(position.baseSalary), isCustom: false };
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
  const tutorGroups = ctx.tutorGroupMap?.get(user.id) || [];

  // Biriktirilmagan (na lavozim, na toifa, na eski qoida, na tyutor guruhi) → payroll yo'q.
  // ⚠️ Faqat guruhi bor tyutor ham oylik oladi: aks holda lavozimi hali
  // belgilanmagan tyutorning qo'shimcha oyligi jimgina yo'qolardi.
  if (!position && !category && !rule && tutorGroups.length === 0) return null;

  const { amount: base, isCustom: baseIsCustom } = resolvePositionBase(user, position, ctx);
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

  // TYUTOR GURUHLARI — foizli ustama bazasiga (`preBonus`) KIRMAYDI, ustiga
  // qo'shiladi. Qatorda sinf va o'quvchilar soni MUHRLANADI: keyin sinf
  // tarkibi o'zgarsa ham "nega shuncha" degan savolga javob qoladi.
  let tutorAmount = new Decimal(0);
  for (const g of tutorGroups) {
    const studentCount = ctx.classStudentCounts?.get(g.classId) ?? 0;
    const amt = computeTutorGroupAmount(g, studentCount);
    const className = g.class?.name ?? "";
    tutorAmount = tutorAmount.plus(amt);
    allowanceBreakdown.push({
      label: `Tyutor: ${className || "sinf"}`,
      type: "tutor",
      value: Number(amt),
      amount: formatAmount(amt),
      tutorGroupId: g.id,
      classId: g.classId,
      className,
      studentCount,
      perStudentAmount: formatAmount(g.perStudentAmount),
      groupAmount: formatAmount(g.groupAmount),
    });
  }
  allowanceAmount = allowanceAmount.plus(tutorAmount);

  const grossAmount = fixedAmount.plus(kpiAmount).plus(allowanceAmount);

  // Ushlab qolish — YALPIDAN, oylik manfiy bo'lolmaydi
  const { total: deductionAmount, breakdown: deductionBreakdown } = computeDeductions(
    grossAmount,
    ctx.deductionMap?.get(user.id) || [],
    { perHourRate },
  );

  const amount = grossAmount.minus(deductionAmount);

  const hasFixed = fixedAmount.greaterThan(0);
  const hasKpi = kpiAmount.greaterThan(0) || Boolean(category);
  const salaryType = hasFixed && hasKpi ? "mixed" : hasKpi ? "kpi" : "fixed";

  const departmentName =
    position?.department?.name || category?.department?.name || "";

  return {
    eligible: true,
    salaryType,
    baseAmount: base,
    baseIsCustom,
    fixedAmount,
    kpiAmount,
    allowanceAmount,
    tutorAmount,
    lessonHours: hours,
    perHourRate,
    amount,
    allowanceBreakdown,
    grossAmount,
    deductionAmount,
    deductionBreakdown,
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
    baseAmount: formatAmount(c.baseAmount),
    baseIsCustom: c.baseIsCustom,
    fixedAmount: formatAmount(c.fixedAmount),
    kpiAmount: formatAmount(c.kpiAmount),
    allowanceAmount: formatAmount(c.allowanceAmount),
    tutorAmount: formatAmount(c.tutorAmount),
    lessonHours: Number(c.lessonHours),
    perHourRate: formatAmount(c.perHourRate),
    amount: formatAmount(c.amount),
    allowanceBreakdown: c.allowanceBreakdown,
    grossAmount: formatAmount(c.grossAmount),
    deductionAmount: formatAmount(c.deductionAmount),
    deductionBreakdown: c.deductionBreakdown,
    categoryName: c.categoryName,
    positionName: c.positionName,
    departmentName: c.departmentName,
  };
};

module.exports = {
  loadContext,
  resolvePositionBase,
  computeForStaff,
  previewForStaff,
};
