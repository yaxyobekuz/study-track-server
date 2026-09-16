/**
 * PAYROLL KO'RINISHLARI (admin) — "Yo'nalish × Bo'lim" bo'yicha hisoblangan
 * oyliklarni beradi. Hisob HAR DOIM payrollEngine orqali — generatsiya bilan
 * bir xil raqam chiqadi (frontend faqat ko'rsatadi).
 */

const prisma = require("../config/prisma");
const { NotFoundError, BadRequestError } = require("../utils/errors");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { currentMonthKey, parseMonthKey, formatMonthKey } = require("../helpers/month.helpers");
const { Decimal, formatAmount } = require("../helpers/money.helpers");
const payrollEngine = require("./payrollEngine.service");

const USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  role: true,
  isArchived: true,
  positionId: true,
  salaryCategoryId: true,
};

const userInfo = (u) => ({
  id: u.id,
  firstName: u.firstName,
  lastName: u.lastName,
  username: u.username,
  fullName: `${u.firstName} ${u.lastName ?? ""}`.trim(),
  role: u.role,
});

const searchWhere = (search) =>
  search
    ? {
        OR: [
          { firstName: { contains: search, mode: "insensitive" } },
          { lastName: { contains: search, mode: "insensitive" } },
          { username: { contains: search, mode: "insensitive" } },
        ],
      }
    : {};

const resolveMonth = (value) => (value ? parseMonthKey(value, "Oy") : currentMonthKey());

const sumTotals = (rows) => {
  let base = new Decimal(0);
  let kpi = new Decimal(0);
  let bonus = new Decimal(0);
  let final = new Decimal(0);
  for (const r of rows) {
    base = base.plus(r.fixedAmount || 0);
    kpi = kpi.plus(r.kpiAmount || 0);
    bonus = bonus.plus(r.allowanceAmount || 0);
    final = final.plus(r.amount || 0);
  }
  return {
    fixedAmount: formatAmount(base),
    kpiAmount: formatAmount(kpi),
    allowanceAmount: formatAmount(bonus),
    amount: formatAmount(final),
  };
};

/**
 * STAFF bo'lim → xodimlar + hisoblangan oylik (lavozim bazasi + ustama).
 */
const getStaffPayroll = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { departmentId, month: monthQ, search } = req.query;
  if (!departmentId) throw new BadRequestError("Bo'lim tanlanmagan");

  const dept = await prisma.department.findUnique({ where: { id: departmentId } });
  if (!dept) throw new NotFoundError("Bo'lim topilmadi");

  const month = resolveMonth(monthQ);
  const positions = await prisma.position.findMany({
    where: { departmentId },
    select: { id: true },
  });
  const positionIds = positions.map((p) => p.id);

  const where = {
    isArchived: false,
    role: { not: "student" },
    positionId: positionIds.length ? { in: positionIds } : { in: ["__none__"] },
    ...searchWhere(search),
  };

  // SARALASH: 'name' (sukut) — DB darajasida; 'amount' — hisoblangan oylik
  // bo'yicha, u DB ustuni emas, shuning uchun butun ro'yxat xotirada
  // saralanib sahifalanadi (bo'lim xodimlari soni kichik).
  const sortByAmount = req.query.sort === "amount";

  const [users, total] = await Promise.all([
    sortByAmount
      ? prisma.user.findMany({ where, select: USER_SELECT })
      : prisma.user.findMany({
          where,
          select: USER_SELECT,
          orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
          skip,
          take: limit,
        }),
    prisma.user.count({ where }),
  ]);

  const ctx = await payrollEngine.loadContext(month, users);
  let rows = users.map((u) => ({
    ...userInfo(u),
    positionId: u.positionId,
    ...payrollEngine.previewForStaff(u, month, ctx),
  }));

  if (sortByAmount) {
    rows = rows
      .sort((a, b) => Number(b.amount ?? 0) - Number(a.amount ?? 0))
      .slice(skip, skip + limit);
  }

  // Butun bo'lim bo'yicha yakuniy summa (sahifadan qat'i nazar)
  const allUsers = await prisma.user.findMany({ where, select: USER_SELECT });
  const allCtx = await payrollEngine.loadContext(month, allUsers);
  const allRows = allUsers
    .map((u) => payrollEngine.previewForStaff(u, month, allCtx))
    .filter(Boolean);

  return {
    department: { id: dept.id, name: dept.name, kind: dept.kind },
    month,
    monthLabel: formatMonthKey(month),
    totals: sumTotals(allRows),
    ...formatPaginationResponse(rows, total, page, limit),
  };
};

/**
 * TEACHING toifa → o'qituvchilar + hisoblangan oylik (toifa × dars soati + ...).
 */
const getTeacherPayroll = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { categoryId, month: monthQ, search } = req.query;
  if (!categoryId) throw new BadRequestError("Toifa tanlanmagan");

  const category = await prisma.salaryCategory.findUnique({
    where: { id: categoryId },
    include: { department: { select: { id: true, name: true } } },
  });
  if (!category) throw new NotFoundError("Toifa topilmadi");

  const month = resolveMonth(monthQ);
  const where = {
    isArchived: false,
    salaryCategoryId: categoryId,
    ...searchWhere(search),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: USER_SELECT,
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  const ctx = await payrollEngine.loadContext(month, users);
  const rows = users.map((u) => ({
    ...userInfo(u),
    ...payrollEngine.previewForStaff(u, month, ctx),
  }));

  const allUsers = await prisma.user.findMany({ where, select: USER_SELECT });
  const allCtx = await payrollEngine.loadContext(month, allUsers);
  const allRows = allUsers
    .map((u) => payrollEngine.previewForStaff(u, month, allCtx))
    .filter(Boolean);

  return {
    category: {
      id: category.id,
      name: category.name,
      perHourRate: formatAmount(category.perHourRate),
      monthlyPerHour: formatAmount(category.monthlyPerHour),
      hoursPerStavka: category.hoursPerStavka,
      baseSalary: formatAmount(category.baseSalary),
      department: category.department,
    },
    month,
    monthLabel: formatMonthKey(month),
    totals: sumTotals(allRows),
    ...formatPaginationResponse(rows, total, page, limit),
  };
};

/**
 * USTAMA HAQ ko'rinishi — "Yo'nalish → Ustama haq" tanlanganda.
 *
 * Har bir USTAMA KOMPONENTI alohida qator: kimga, nomi, turi (so'm/foiz),
 * shu oydagi hisoblangan summasi, MANBASI va HOLATI. Uch manba:
 *   1. PayrollBonus  — tasdiqlangan zayavka (sourceRequestId bor) yoki
 *      admin yaratgan bonus. Holat: faol / muddati tugagan / o'chirilgan.
 *   2. StaffSalary.allowances — adminning oylik qoidasidagi ustamalar.
 *   3. PayrollRequest (kind=bonus, pending) — KUTILAYOTGAN zayavka:
 *      ko'rinadi, lekin summaga QO'SHILMAYDI (tasdiqlanmagan ustama
 *      payrollga ta'sir qilmaydi — biznes qoida).
 *
 * Foizli ustama summasi engine bilan bir xil qoidada: boshlang'ich oylik
 * (lavozim bazasi + fiksa + KPI) dan olinadi.
 *
 * @param {object} req - query: { month, departmentId, status: 'active'|'pending', search, page, limit }
 */
const getAllowancesView = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { departmentId, month: monthQ, search, status } = req.query;
  const month = resolveMonth(monthQ);

  const coveringMonth = {
    startMonth: { lte: month },
    OR: [{ endMonth: null }, { endMonth: { gte: month } }],
  };

  // ── Manbalar ────────────────────────────────
  const [bonuses, pendingRequests] = await Promise.all([
    prisma.payrollBonus.findMany({ where: { isActive: true, ...coveringMonth } }),
    prisma.payrollRequest.findMany({
      where: { kind: "bonus", status: "pending" },
      select: {
        id: true,
        staffId: true,
        bonusLabel: true,
        bonusType: true,
        bonusValue: true,
        createdAt: true,
      },
    }),
  ]);

  // Nomzod xodimlar: bonusi borlar + kutilayotgan zayavka egalari.
  // Qoida (StaffSalary.allowances) egalari engine kontekstidan chiqadi —
  // ular uchun ham userni yuklashimiz kerak, shuning uchun qoida jadvalidan
  // ham id yig'amiz.
  const ruleRows = await prisma.staffSalary.findMany({
    where: { ...coveringMonth, NOT: { allowances: { equals: [] } } },
    select: { staffId: true },
  });

  const staffIds = [
    ...new Set([
      ...bonuses.map((b) => b.staffId),
      ...pendingRequests.map((r) => r.staffId),
      ...ruleRows.map((r) => r.staffId),
    ]),
  ];

  if (staffIds.length === 0) {
    return {
      month,
      monthLabel: formatMonthKey(month),
      totals: { activeAmount: "0.00", activeCount: 0, pendingCount: 0 },
      ...formatPaginationResponse([], 0, page, limit),
    };
  }

  // ── Bo'lim filtri ───────────────────────────
  // staff bo'lim → lavozimlari orqali; teaching bo'lim → toifalari orqali
  let deptFilter = {};
  if (departmentId) {
    const dept = await prisma.department.findUnique({ where: { id: departmentId } });
    if (!dept) throw new NotFoundError("Bo'lim topilmadi");
    if (dept.kind === "staff") {
      const positions = await prisma.position.findMany({
        where: { departmentId },
        select: { id: true },
      });
      deptFilter = { positionId: { in: positions.length ? positions.map((p) => p.id) : ["__none__"] } };
    } else {
      const categories = await prisma.salaryCategory.findMany({
        where: { departmentId },
        select: { id: true },
      });
      deptFilter = {
        salaryCategoryId: { in: categories.length ? categories.map((c) => c.id) : ["__none__"] },
      };
    }
  }

  const users = await prisma.user.findMany({
    where: {
      id: { in: staffIds },
      isArchived: false,
      role: { not: "student" },
      ...deptFilter,
      ...searchWhere(search),
    },
    select: USER_SELECT,
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  // ── Engine: har xodimning boshlang'ich oyligi (foiz bazasi) ──
  const ctx = await payrollEngine.loadContext(month, users);
  const round2 = (d) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  const rows = [];
  let activeAmount = new Decimal(0);
  let activeCount = 0;

  for (const user of users) {
    const computed = payrollEngine.computeForStaff(user, month, ctx);
    const preBonus = computed
      ? computed.fixedAmount.plus(computed.kpiAmount)
      : new Decimal(0);
    const info = userInfo(user);
    const deptName = computed?.departmentName || "";

    const amountOf = (type, value) =>
      type === "percent"
        ? round2(preBonus.times(value).div(100))
        : new Decimal(value);

    // 1) PayrollBonus (tasdiqlangan zayavka / admin bonusi)
    for (const b of bonuses.filter((x) => x.staffId === user.id)) {
      const amt = amountOf(b.type, b.value);
      activeAmount = activeAmount.plus(amt);
      activeCount += 1;
      rows.push({
        key: `bonus-${b.id}`,
        ...info,
        departmentName: deptName,
        label: b.label || "Ustama",
        type: b.type,
        value: formatAmount(b.value),
        amount: formatAmount(amt),
        source: b.sourceRequestId ? "request" : "admin",
        sourceLabel: b.sourceRequestId ? "Zayavka (tasdiqlangan)" : "Admin qo'shgan",
        status: "active",
        statusLabel: "Faol",
        periodLabel: `${formatMonthKey(b.startMonth)}${b.endMonth ? " — " + formatMonthKey(b.endMonth) : " dan"}`,
      });
    }

    // 2) Oylik qoidasidagi ustamalar (StaffSalary.allowances)
    const rule = ctx.salaryRules.get(user.id);
    if (rule && Array.isArray(rule.allowances)) {
      rule.allowances.forEach((a, i) => {
        const amt = amountOf(a.type, a.value);
        activeAmount = activeAmount.plus(amt);
        activeCount += 1;
        rows.push({
          key: `rule-${user.id}-${i}`,
          ...info,
          departmentName: deptName,
          label: a.label || "Ustama",
          type: a.type,
          value: formatAmount(a.value),
          amount: formatAmount(amt),
          source: "rule",
          sourceLabel: "Oylik qoidasi",
          status: "active",
          statusLabel: "Faol",
          periodLabel: `${formatMonthKey(rule.startMonth)}${rule.endMonth ? " — " + formatMonthKey(rule.endMonth) : " dan"}`,
        });
      });
    }

    // 3) Kutilayotgan zayavkalar — summaga QO'SHILMAYDI
    for (const r of pendingRequests.filter((x) => x.staffId === user.id)) {
      rows.push({
        key: `pending-${r.id}`,
        ...info,
        departmentName: deptName,
        label: r.bonusLabel || "Ustama",
        type: r.bonusType || "fixed",
        value: r.bonusValue != null ? formatAmount(r.bonusValue) : "0.00",
        amount: null, // tasdiqlanmagan — hisobga kirmaydi
        source: "request",
        sourceLabel: "Zayavka",
        status: "pending",
        statusLabel: "Kutilmoqda",
        requestId: r.id,
        periodLabel: "—",
      });
    }
  }

  // ── Holat filtri va sahifalash (xotirada — qatorlar komponent soni bilan
  // chegaralangan, xodim emas) ──
  const filtered = status ? rows.filter((r) => r.status === status) : rows;
  const pageRows = filtered.slice(skip, skip + limit);

  return {
    month,
    monthLabel: formatMonthKey(month),
    totals: {
      activeAmount: formatAmount(activeAmount),
      activeCount,
      pendingCount: pendingRequests.length,
    },
    ...formatPaginationResponse(pageRows, filtered.length, page, limit),
  };
};

module.exports = {
  getStaffPayroll,
  getTeacherPayroll,
  getAllowancesView,
};
