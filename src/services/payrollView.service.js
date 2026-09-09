/**
 * PAYROLL STRUKTURA KO'RINISHLARI (admin) — "Yo'nalish × Bo'lim" bo'yicha
 * hisoblangan oyliklarni beradi.
 *
 * ⚠️ Bu StaffSalary oylik-hisobidan ALOHIDA (coexist): raqamlar strukturadan
 * (lavozim bazasi / toifa × dars soati) chiqadi va faqat KO'RSATILADI.
 *   staff    → fixedAmount = Position.baseSalary
 *   teaching → kpiAmount   = SalaryCategory.perHourRate × dars soati
 * Dars soati main'ning `lessonHours.service` idan olinadi (o'rinbosarlikni
 * ham hisoblaydi) — ikkita alohida soat-hisobi bo'lmasligi uchun.
 */

const prisma = require("../config/prisma");
const { NotFoundError, BadRequestError } = require("../utils/errors");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { currentMonthKey, parseMonthKey, formatMonthKey } = require("../helpers/month.helpers");
const { Decimal, formatAmount } = require("../helpers/money.helpers");
const { getTeachersHours } = require("./lessonHours.service");

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

const round2 = (dec) => formatAmount(new Decimal(dec).toDecimalPlaces(2));

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
 * STAFF bo'lim → xodimlar + hisoblangan oylik (lavozim bazasidan).
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
    select: { id: true, name: true, baseSalary: true },
  });
  const positionIds = positions.map((p) => p.id);
  const posMap = new Map(positions.map((p) => [p.id, p]));

  const where = {
    isArchived: false,
    role: { not: "student" },
    positionId: positionIds.length ? { in: positionIds } : { in: ["__none__"] },
    ...searchWhere(search),
  };

  const [users, total, allUsers] = await Promise.all([
    prisma.user.findMany({
      where,
      select: USER_SELECT,
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
    prisma.user.findMany({ where, select: USER_SELECT }),
  ]);

  const toRow = (u) => {
    const pos = posMap.get(u.positionId);
    const fixed = formatAmount(pos?.baseSalary ?? 0);
    return {
      ...userInfo(u),
      positionId: u.positionId,
      positionName: pos?.name ?? null,
      fixedAmount: fixed,
      kpiAmount: "0.00",
      allowanceAmount: "0.00",
      amount: fixed,
    };
  };

  const rows = users.map(toRow);

  return {
    department: { id: dept.id, name: dept.name, kind: dept.kind },
    month,
    monthLabel: formatMonthKey(month),
    totals: sumTotals(allUsers.map(toRow)),
    ...formatPaginationResponse(rows, total, page, limit),
  };
};

/**
 * TEACHING toifa → o'qituvchilar + hisoblangan oylik
 * (toifa.perHourRate × dars soati; soat main lessonHours'dan).
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
  const rate = new Decimal(category.perHourRate);

  const where = {
    isArchived: false,
    salaryCategoryId: categoryId,
    ...searchWhere(search),
  };

  const [users, total, allUsers] = await Promise.all([
    prisma.user.findMany({
      where,
      select: USER_SELECT,
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
    prisma.user.findMany({ where, select: USER_SELECT }),
  ]);

  // Barcha (butun toifa) uchun dars soatini bitta so'rovda olamiz
  const hoursMap = allUsers.length
    ? await getTeachersHours(allUsers.map((u) => u.id), month)
    : new Map();

  const toRow = (u) => {
    const info = hoursMap.get(String(u.id));
    const hours = info?.hours ?? 0;
    const kpi = round2(rate.times(hours));
    return {
      ...userInfo(u),
      lessonHours: hours,
      kpiAmount: kpi,
      allowanceAmount: "0.00",
      amount: kpi,
    };
  };

  const rows = users.map(toRow);

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
    totals: sumTotals(allUsers.map(toRow)),
    ...formatPaginationResponse(rows, total, page, limit),
  };
};

module.exports = {
  getStaffPayroll,
  getTeacherPayroll,
};
