/**
 * PAYROLL KO'RINISHLARI (admin) — "Yo'nalish × Bo'lim" bo'yicha hisoblangan
 * oyliklarni beradi. Hisob HAR DOIM payrollEngine orqali — generatsiya bilan
 * bir xil raqam chiqadi (frontend faqat ko'rsatadi).
 */

const prisma = require("../config/prisma");
const platformPrisma = require("../config/platformPrisma");
const { requireBranch } = require("../config/branchContext");
const { NotFoundError, BadRequestError } = require("../utils/errors");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { currentMonthKey, parseMonthKey, formatMonthKey } = require("../helpers/month.helpers");
const { Decimal, formatAmount } = require("../helpers/money.helpers");
const payrollEngine = require("./payrollEngine.service");
const { resolveSalariesForMonth } = require("./staffSalary.service");

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
 * Har xodimga oylik tuzilmasi OXIRGI marta qachon tegilgani: lavozim/toifa
 * biriktirish, shartnoma sharti (audit) yoki oylik qoidasi (StaffSalary).
 * Alohida ustun yo'q — audit har biriktirishda baribir yoziladi, shuning
 * uchun eski biriktirishlar ham to'g'ri tartibga tushadi.
 *
 * @param {string[]} ids
 * @returns {Promise<Map<string, number>>} id → ms
 */
const loadLastAssignedAt = async (ids) => {
  if (ids.length === 0) return new Map();
  const [audits, salaries] = await Promise.all([
    prisma.payrollAudit.groupBy({
      by: ["targetId"],
      where: { targetType: "user", targetId: { in: ids } },
      _max: { createdAt: true },
    }),
    prisma.staffSalary.groupBy({
      by: ["staffId"],
      where: { staffId: { in: ids } },
      _max: { updatedAt: true },
    }),
  ]);
  const map = new Map();
  const bump = (id, date) => {
    const ms = date ? date.getTime() : 0;
    if (ms > (map.get(id) ?? 0)) map.set(id, ms);
  };
  audits.forEach((a) => bump(a.targetId, a._max.createdAt));
  salaries.forEach((s) => bump(s.staffId, s._max.updatedAt));
  return map;
};

const byName = (a, b) =>
  `${a.firstName ?? ""} ${a.lastName ?? ""}`.localeCompare(`${b.firstName ?? ""} ${b.lastName ?? ""}`);

/**
 * SARALASH (ikkala ko'rinish uchun bitta qoida):
 *   'recent' (sukut) — oxirgi biriktirilgan/o'zgargan tepada;
 *   'amount'         — hisoblangan oylik bo'yicha;
 *   'name'           — ism bo'yicha (DB darajasida sahifalanadi).
 * 'recent' va 'amount' DB ustuni emas — butun ro'yxat xotirada saralanib
 * sahifalanadi (bo'lim/toifa xodimlari soni kichik).
 */
const loadSortedPage = async ({ where, sort, month, skip, limit, withPosition }) => {
  const toRow = (u, ctx) => ({
    ...userInfo(u),
    ...(withPosition ? { positionId: u.positionId } : {}),
    ...payrollEngine.previewForStaff(u, month, ctx),
  });

  if (sort === "name") {
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
    return { rows: users.map((u) => toRow(u, ctx)), total };
  }

  const users = await prisma.user.findMany({ where, select: USER_SELECT });
  const ctx = await payrollEngine.loadContext(month, users);
  let rows = users.map((u) => toRow(u, ctx));

  if (sort === "amount") {
    rows.sort((a, b) => Number(b.amount ?? 0) - Number(a.amount ?? 0));
  } else {
    const lastAt = await loadLastAssignedAt(users.map((u) => u.id));
    rows.sort((a, b) => (lastAt.get(b.id) ?? 0) - (lastAt.get(a.id) ?? 0) || byName(a, b));
  }

  return { rows: rows.slice(skip, skip + limit), total: users.length };
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

  const { rows, total } = await loadSortedPage({
    where,
    sort: req.query.sort,
    month,
    skip,
    limit,
    withPosition: true,
  });

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

  const { rows, total } = await loadSortedPage({
    where,
    sort: req.query.sort,
    month,
    skip,
    limit,
  });

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

  // ── XODIM-GURUHLI qatorlar: har xodim BITTA qator, ustamalari items[] da ──
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

    const items = [];
    let staffActive = new Decimal(0);
    let pendingCount = 0;

    // 1) PayrollBonus (tasdiqlangan zayavka / admin bonusi)
    for (const b of bonuses.filter((x) => x.staffId === user.id)) {
      const amt = amountOf(b.type, b.value);
      staffActive = staffActive.plus(amt);
      activeAmount = activeAmount.plus(amt);
      activeCount += 1;
      items.push({
        key: `bonus-${b.id}`,
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
        staffActive = staffActive.plus(amt);
        activeAmount = activeAmount.plus(amt);
        activeCount += 1;
        items.push({
          key: `rule-${user.id}-${i}`,
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
      pendingCount += 1;
      items.push({
        key: `pending-${r.id}`,
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

    if (items.length === 0) continue;

    // Oylik (asosiy) = lavozim/soatbay + fiksa; Jami = oylik + faol ustamalar
    const baseSalary = preBonus;
    const grandTotal = baseSalary.plus(staffActive);

    rows.push({
      ...info,
      departmentName: deptName,
      items,
      baseSalary: formatAmount(baseSalary),
      activeTotal: formatAmount(staffActive),
      grandTotal: formatAmount(grandTotal),
      activeItemCount: items.filter((i) => i.status === "active").length,
      pendingCount,
    });
  }

  // ── Holat filtri (xodim darajasida) va sahifalash ──
  const filtered = status
    ? rows.filter((r) =>
        status === "pending" ? r.pendingCount > 0 : r.activeItemCount > 0,
      )
    : rows;
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

/**
 * "Xodim qo'shish" tanlagichi uchun nomzodlar.
 *
 * ⚠️ SHU bo'limga allaqachon biriktirilganlar CHIQARIB TASHLANADI: xodimda
 * bitta lavozim/toifa bo'ladi, qayta tanlash hech narsa o'zgartirmay
 * "Biriktirildi" deb turardi. Boshqa bo'limdagilar qoladi (`currentLabel`
 * bilan) — tanlansa ko'chiriladi, ikkinchi nusxa paydo bo'lmaydi.
 * Lavozimni almashtirish — xodim qatoridagi tugma orqali.
 *
 * ⚠️ `isActive` bo'yicha FILTRLANMAYDI — u login bayrog'i. Oylik
 * shakllantirish ham faqat `isArchived` ni filtrlaydi, "Xodimlar" sahifasi
 * ham login o'chirilganlarni ko'rsatadi. Ilgari bu yerda `isActive: true`
 * turardi: tizimga kirmaydigan (oshpaz, farrosh) xodim ro'yxatda bor-u,
 * tanlagichda yo'q edi — "Biriktirilmagan xodim topilmadi".
 * Istisno — FILIALDAN CHIQARILGAN xodim (`detachFromBranch` ham
 * `isActive: false` yozadi): unda shu filialga ruxsat qatori yo'q.
 *
 * Tartib: OYLIGI BELGILANMAGANLAR TEPADA (lavozim/toifa ham, amaldagi
 * StaffSalary qoidasi ham yo'q) — tanlagich aynan shular uchun ochiladi.
 *
 * @param {object} req - query: { departmentId }
 */
const getAssignCandidates = async (req) => {
  const { departmentId } = req.query;
  if (!departmentId) throw new BadRequestError("Bo'lim tanlanmagan");

  const dept = await prisma.department.findUnique({ where: { id: departmentId } });
  if (!dept) throw new NotFoundError("Bo'lim topilmadi");
  const isTeaching = dept.kind === "teaching";

  // Teaching bo'limga faqat o'qituvchilar, staff bo'limga qolgan xodimlar
  const [positions, categories, salaryRules, users] = await Promise.all([
    prisma.position.findMany({ select: { id: true, name: true, departmentId: true } }),
    prisma.salaryCategory.findMany({ select: { id: true, name: true, departmentId: true } }),
    resolveSalariesForMonth(currentMonthKey()),
    prisma.user.findMany({
      where: {
        isArchived: false,
        role: isTeaching ? "teacher" : { notIn: ["student", "teacher", "owner"] },
      },
      select: { ...USER_SELECT, isActive: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
  ]);
  const positionById = new Map(positions.map((p) => [p.id, p]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));

  const inactiveIds = users.filter((u) => !u.isActive).map((u) => u.id);
  const stillAttached = new Set();
  if (inactiveIds.length > 0) {
    const access = await platformPrisma.userBranchAccess.findMany({
      where: { branchId: requireBranch().id, userId: { in: inactiveIds } },
      select: { userId: true },
    });
    access.forEach((a) => stillAttached.add(a.userId));
  }

  const rows = users
    .filter((u) => u.isActive || stillAttached.has(u.id))
    .filter((u) => {
      const own = isTeaching
        ? categoryById.get(u.salaryCategoryId)
        : positionById.get(u.positionId);
      return own?.departmentId !== departmentId;
    })
    .map((u) => {
      const currentLabel =
        positionById.get(u.positionId)?.name ?? categoryById.get(u.salaryCategoryId)?.name ?? null;
      return {
        ...userInfo(u),
        currentLabel,
        hasSalary: Boolean(currentLabel) || salaryRules.has(u.id),
        loginDisabled: !u.isActive,
      };
    });

  // Barqaror saralash — guruh ichida ism tartibi saqlanadi
  return rows.sort((a, b) => Number(a.hasSalary) - Number(b.hasSalary));
};

module.exports = {
  getStaffPayroll,
  getAssignCandidates,
  getTeacherPayroll,
  getAllowancesView,
};
