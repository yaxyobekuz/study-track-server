/**
 * YIG'ISH REJASI — mas'ul xodim × kirim turi kesimida oylik reja.
 *
 * "Jasur, Undiruv bo'yicha shu oy 24 960 000 yig'ishi kerak; 19 570 000
 * yig'ildi, 5 390 000 qoldi."
 *
 * ⚠️ `expenseBudget.service.js` NING KO'ZGUSI, faqat teskari tomonda:
 * u yerda "qancha sarflash mumkin" (yuqori chegara), bu yerda "qancha
 * yig'ish kerak" (quyi maqsad). Shuning uchun rang mantig'i ham teskari —
 * xarajatda rejadan oshish YOMON, yig'imda esa YAXSHI.
 *
 * ⚠️ Reja HECH NARSANI TO'SMAYDI: rejasi yo'q mas'ulga ham, rejadan
 * ortiq ham kirim yozilaveradi. Bu — o'lchov, ruxsatnoma emas.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const {
  parseMonthKey,
  parseOptionalMonthKey,
  currentMonthKey,
  formatMonthKey,
  nextMonth,
} = require("../helpers/month.helpers");
const { Decimal, formatAmount, parseAmount } = require("../helpers/money.helpers");

/** Rejasi bajarilgan hisoblanadigan chegara (biznes qarori). */
const REACHED_RATE = 100;
/** Shu foizdan pastda — xavotirli. */
const WARNING_RATE = 80;

/** Mas'uli belgilanmagan kirimlar shu nom ostida yig'iladi. */
const NO_RESPONSIBLE_LABEL = "Mas'ul belgilanmagan";
const NO_RESPONSIBLE_KEY = "none";

/** Oyning TOSHKENT chegaralari — `occurredAt` INSTANT, +05:00 bilan. */
const monthRange = (monthKey) => {
  const iso = (key) =>
    `${Math.trunc(key / 100)}-${String(key % 100).padStart(2, "0")}-01T00:00:00+05:00`;

  return {
    from: new Date(iso(monthKey)),
    to: new Date(new Date(iso(nextMonth(monthKey))).getTime() - 1),
  };
};

/** Foiz — 1 xonali. Reja nol bo'lsa `null`. */
const rateOf = (part, whole) => {
  const w = new Decimal(whole);
  if (w.isZero()) return null;
  return Number(new Decimal(part).div(w).times(100).toFixed(1));
};

/** Holat kaliti — rangni frontend shu bo'yicha tanlaydi. */
const statusOf = (rate) => {
  if (rate == null) return "none";
  if (rate >= REACHED_RATE) return "reached";
  if (rate >= WARNING_RATE) return "close";
  return "behind";
};

/**
 * Bir oyning yig'ish rejasi + amaldagi natijasi.
 *
 * ⚠️ Ro'yxat IKKI manbadan quriladi:
 *   1. Reja qatorlari — hali bitta ham pul kelmagan bo'lsa ham ko'rinadi
 *      (aks holda "rejani berdik-u hech narsa yig'ilmadi" holati jim
 *      qolardi — bu esa eng muhim signal)
 *   2. Rejasiz kelgan pul — mas'ul biriktirilgan-u rejasi yo'q, yoki
 *      umuman mas'ulsiz kirimlar
 *
 * @param {{month?: number|string}} query
 */
const getPlans = async (query = {}) => {
  const month = parseOptionalMonthKey(query.month, "Oy") ?? currentMonthKey();
  const { from, to } = monthRange(month);

  const [plans, collectedRows, categories] = await Promise.all([
    prisma.incomePlan.findMany({
      where: { month },
      include: { category: { select: { name: true, isArchived: true } } },
      orderBy: { createdAt: "asc" },
    }),
    // Amaldagi yig'im — mas'ul × kategoriya kesimida
    prisma.externalIncome.groupBy({
      by: ["responsibleId", "categoryId", "responsibleName", "categoryName"],
      where: { isVoided: false, occurredAt: { gte: from, lte: to } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.incomeCategory.findMany({
      where: { isArchived: false },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  // Mas'ullarning JORIY ismi — ro'yxatda eskirgan nom turmasin.
  // Muhrlangan nom esa xodim o'chirilgan holat uchun zaxira bo'lib qoladi.
  const staffIds = [
    ...new Set([
      ...plans.map((p) => p.responsibleId),
      ...collectedRows.map((r) => r.responsibleId).filter(Boolean),
    ]),
  ];
  const staff = staffIds.length
    ? await prisma.user.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, firstName: true, lastName: true, isArchived: true },
      })
    : [];
  const staffById = new Map(
    staff.map((u) => [
      u.id,
      { name: `${u.firstName} ${u.lastName ?? ""}`.trim(), isArchived: u.isArchived },
    ]),
  );

  const cellKey = (responsibleId, categoryId) =>
    `${responsibleId ?? NO_RESPONSIBLE_KEY}::${categoryId}`;

  const collectedByCell = new Map();
  for (const row of collectedRows) {
    collectedByCell.set(cellKey(row.responsibleId, row.categoryId), {
      amount: new Decimal(row._sum.amount ?? 0),
      count: row._count._all,
      responsibleName: row.responsibleName,
      categoryName: row.categoryName,
    });
  }

  let totalTarget = new Decimal(0);
  let totalCollected = new Decimal(0);

  const items = [];

  // ── 1. Reja qatorlari ───────────────────────────────────────────────
  for (const plan of plans) {
    const key = cellKey(plan.responsibleId, plan.categoryId);
    const actual = collectedByCell.get(key);
    const collected = actual?.amount ?? new Decimal(0);
    const target = new Decimal(plan.targetAmount);

    totalTarget = totalTarget.plus(target);
    totalCollected = totalCollected.plus(collected);
    collectedByCell.delete(key);

    const rate = rateOf(collected, target);
    const person = staffById.get(plan.responsibleId);

    items.push({
      key,
      responsibleId: plan.responsibleId,
      responsibleName: person?.name || actual?.responsibleName || "Noma'lum xodim",
      isStaffArchived: person?.isArchived ?? true,
      categoryId: plan.categoryId,
      categoryName: plan.category?.name ?? actual?.categoryName ?? "—",
      studentCount: plan.studentCount,
      target: formatAmount(target),
      collected: formatAmount(collected),
      // Manfiy qoldiq — rejadan OSHGANI. Nolga qisilmaydi: "qancha oshdik"
      // degan raqam ham xuddi shu ustunda ko'rinishi kerak.
      remaining: formatAmount(target.minus(collected)),
      rate,
      status: statusOf(rate),
      entryCount: actual?.count ?? 0,
      hasPlan: true,
      note: plan.note,
    });
  }

  // ── 2. Rejasiz kelgan pul ───────────────────────────────────────────
  for (const [key, row] of collectedByCell) {
    const [responsibleId] = key.split("::");
    const isNone = responsibleId === NO_RESPONSIBLE_KEY;
    const person = isNone ? null : staffById.get(responsibleId);

    totalCollected = totalCollected.plus(row.amount);

    items.push({
      key,
      responsibleId: isNone ? null : responsibleId,
      responsibleName: isNone
        ? NO_RESPONSIBLE_LABEL
        : person?.name || row.responsibleName || "Noma'lum xodim",
      isStaffArchived: isNone ? false : (person?.isArchived ?? true),
      categoryId: key.split("::")[1],
      categoryName: row.categoryName || "—",
      studentCount: 0,
      target: null,
      collected: formatAmount(row.amount),
      remaining: null,
      rate: null,
      status: "none",
      entryCount: row.count,
      hasPlan: false,
      note: "",
    });
  }

  // Rejasi bor qatorlar oldinda; ular ichida eng ORQADA qolgani tepada —
  // rahbar birinchi navbatda muammoni ko'rishi kerak
  items.sort((a, b) => {
    if (a.hasPlan !== b.hasPlan) return a.hasPlan ? -1 : 1;
    if (!a.hasPlan) return Number(b.collected) - Number(a.collected);
    return (a.rate ?? 0) - (b.rate ?? 0);
  });

  const totalRate = rateOf(totalCollected, totalTarget);

  return {
    month,
    monthLabel: formatMonthKey(month),
    items,
    // Reja oynasi uchun: kategoriyalar ro'yxati
    categories,
    totals: {
      target: formatAmount(totalTarget),
      collected: formatAmount(totalCollected),
      remaining: formatAmount(totalTarget.minus(totalCollected)),
      rate: totalRate,
      status: statusOf(totalRate),
      planCount: plans.length,
      behindCount: items.filter((row) => row.status === "behind").length,
      unplannedCount: items.filter((row) => !row.hasPlan).length,
    },
  };
};

/**
 * Rejani yozadi.
 *
 * Bo'sh (`null`) summa — qatorni OLIB TASHLASH. Yuborilmagan juftlik
 * o'z holicha qoladi.
 *
 * @param {{month: number|string, items: Array<{responsibleId: string, categoryId: string, targetAmount?: *, studentCount?: *, note?: string}>}} data
 * @param {string} userId
 */
const upsertPlans = async (data = {}, userId) => {
  const month = parseMonthKey(data.month, "Oy");

  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw new BadRequestError("Reja qatorlari yuborilmadi");
  }
  if (data.items.length > 200) {
    throw new BadRequestError("Reja qatorlari juda ko'p");
  }

  const seen = new Set();
  const plan = [];

  const staffIds = [...new Set(data.items.map((i) => i?.responsibleId).filter(Boolean))];
  const categoryIds = [...new Set(data.items.map((i) => i?.categoryId).filter(Boolean))];

  const [staff, categories] = await Promise.all([
    staffIds.length
      ? prisma.user.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, role: true },
        })
      : [],
    categoryIds.length
      ? prisma.incomeCategory.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true },
        })
      : [],
  ]);

  const staffById = new Map(staff.map((u) => [u.id, u]));
  const knownCategories = new Set(categories.map((c) => c.id));

  // ── Avval HAMMASI tekshiriladi, keyin yoziladi ──────────────────────
  for (const item of data.items) {
    if (!item?.responsibleId) throw new BadRequestError("Mas'ul xodim tanlanmagan");
    if (!item?.categoryId) throw new BadRequestError("Kirim turi tanlanmagan");

    const person = staffById.get(item.responsibleId);
    if (!person) throw new NotFoundError("Mas'ul xodim topilmadi");
    if (person.role === "student") {
      throw new BadRequestError("O'quvchini mas'ul qilib belgilab bo'lmaydi");
    }
    if (!knownCategories.has(item.categoryId)) {
      throw new NotFoundError("Kirim turi topilmadi");
    }

    const key = `${item.responsibleId}::${item.categoryId}`;
    if (seen.has(key)) {
      throw new BadRequestError("Bitta mas'ul va kirim turi ikki marta yuborilgan");
    }
    seen.add(key);

    const isEmpty = item.targetAmount == null || item.targetAmount === "";
    if (isEmpty) {
      plan.push({ ...item, remove: true });
      continue;
    }

    const targetAmount = parseAmount(item.targetAmount, "Reja summasi");

    const rawCount = Number(item.studentCount ?? 0);
    if (!Number.isInteger(rawCount) || rawCount < 0 || rawCount > 100000) {
      throw new BadRequestError("O'quvchi soni noto'g'ri");
    }

    plan.push({
      responsibleId: item.responsibleId,
      categoryId: item.categoryId,
      targetAmount,
      studentCount: rawCount,
      note: String(item.note ?? "").trim().slice(0, 300),
    });
  }

  await prisma.$transaction(
    plan.map((row) =>
      row.remove
        ? prisma.incomePlan.deleteMany({
            where: {
              month,
              responsibleId: row.responsibleId,
              categoryId: row.categoryId,
            },
          })
        : prisma.incomePlan.upsert({
            where: {
              month_responsibleId_categoryId: {
                month,
                responsibleId: row.responsibleId,
                categoryId: row.categoryId,
              },
            },
            create: {
              month,
              responsibleId: row.responsibleId,
              categoryId: row.categoryId,
              targetAmount: row.targetAmount,
              studentCount: row.studentCount,
              note: row.note,
              createdBy: userId,
              updatedBy: userId,
            },
            update: {
              targetAmount: row.targetAmount,
              studentCount: row.studentCount,
              note: row.note,
              updatedBy: userId,
            },
          }),
    ),
  );

  return getPlans({ month });
};

/**
 * Dashboard uchun ixcham kesim — eng orqada qolgan qatorlar.
 * @param {number} month
 */
const loadPlanSummary = async (month) => {
  const report = await getPlans({ month });
  return { items: report.items.slice(0, 8), totals: report.totals };
};

module.exports = {
  getPlans,
  upsertPlans,
  loadPlanSummary,
  NO_RESPONSIBLE_LABEL,
};
