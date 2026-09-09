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
    positionId: u.positionId,
    ...payrollEngine.previewForStaff(u, month, ctx),
  }));

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

module.exports = {
  getStaffPayroll,
  getTeacherPayroll,
};
