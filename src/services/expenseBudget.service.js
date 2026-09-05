/**
 * XARAJAT LIMITI — kategoriya bo'yicha oylik shift.
 *
 * "Ijaraga 60 mln, oziq-ovqatga 36 mln" degan reja. Rahbar limitni
 * qo'yadi, tizim esa oy davomida "qancha ishlatildi / qancha qoldi" ni
 * hisoblab boradi.
 *
 * ⚠️ LIMIT HECH NARSANI TO'SMAYDI. Undan oshgan xarajat baribir qabul
 * qilinadi va shunchaki qizil bo'lib ko'rinadi — `finance.md` §10 dagi
 * "kassada pul yetarliligi tekshirilmaydi" qoidasi bilan bir xil mulohaza:
 * daftar HAQIQATNI yozadi, uni bloklash xodimni tizimdan tashqarida ish
 * yuritishga majbur qilardi.
 *
 * ⚠️ XODIMLAR OYLIGI BU YERGA KIRMAYDI. U alohida mexanizm va allaqachon
 * rejalashtirilgan (oylik qoidalarining yig'indisi). Ikki joyda bir raqam
 * turishi — hisobotga ishonchni yo'qotishning eng tez yo'li.
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

/** Limitning "sog'lomligi" — chegaralar biznes qarori. */
const HEALTHY_RATE = 90; // shu foizgacha — yashil
const WARNING_RATE = 100; // 100% gacha — sariq, undan yuqorisi qizil

/**
 * Oyning TOSHKENT bo'yicha chegaralari.
 * `financeDashboard.service.js` dagi bilan bir xil mulohaza: `occurredAt`
 * — INSTANT, shuning uchun chegara aniq +05:00 ofseti bilan quriladi.
 */
const monthRange = (monthKey) => {
  const iso = (key) =>
    `${Math.trunc(key / 100)}-${String(key % 100).padStart(2, "0")}-01T00:00:00+05:00`;

  return {
    from: new Date(iso(monthKey)),
    to: new Date(new Date(iso(nextMonth(monthKey))).getTime() - 1),
  };
};

/** Foiz — 1 xonali. Limit nol bo'lsa `null` (0% BILAN BIR XIL EMAS). */
const rateOf = (part, whole) => {
  const w = new Decimal(whole);
  if (w.isZero()) return null;
  return Number(new Decimal(part).div(w).times(100).toFixed(1));
};

/** Holat kaliti — rangni frontend shu bo'yicha tanlaydi. */
const statusOf = (rate) => {
  if (rate == null) return "none";
  if (rate <= HEALTHY_RATE) return "ok";
  if (rate <= WARNING_RATE) return "warning";
  return "over";
};

/**
 * Bir oyning limit jadvali.
 *
 * ⚠️ FAOL kategoriyalarning HAMMASI qaytariladi, limiti qo'yilmagani ham
 * (`limit: null`). Aks holda rahbar "qaysi kategoriyaga limit qo'ymabmiz"
 * degan savolga javob topolmasdi — ro'yxatda faqat qo'yilganlari turardi.
 *
 * ⚠️ Limitdan tashqarida sarflangan (arxivlangan yoki limitsiz kategoriya)
 * pul ham ko'rinadi: `unbudgeted` qatorlari. Ular jim qolsa, kategoriyalar
 * yig'indisi "Jami xarajat" kartasidan kam chiqib qolardi.
 *
 * @param {{month?: number|string}} query
 */
const getBudgets = async (query = {}) => {
  const month = parseOptionalMonthKey(query.month, "Oy") ?? currentMonthKey();
  const { from, to } = monthRange(month);

  const [categories, budgets, spentRows] = await Promise.all([
    prisma.expenseCategory.findMany({
      where: { isArchived: false },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, isActive: true, excludeFromEbitda: true },
    }),
    prisma.expenseBudget.findMany({ where: { month } }),
    prisma.expense.groupBy({
      by: ["categoryId", "categoryName"],
      where: { isVoided: false, occurredAt: { gte: from, lte: to } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const limitByCategory = new Map(budgets.map((row) => [row.categoryId, row]));
  const spentByCategory = new Map();
  for (const row of spentRows) {
    spentByCategory.set(row.categoryId, {
      amount: new Decimal(row._sum.amount ?? 0),
      count: row._count._all,
      name: row.categoryName,
    });
  }

  let totalLimit = new Decimal(0);
  let totalSpent = new Decimal(0);

  const items = categories.map((category) => {
    const budget = limitByCategory.get(category.id);
    const spentRow = spentByCategory.get(category.id);
    const spent = spentRow?.amount ?? new Decimal(0);
    const limit = budget ? new Decimal(budget.limitAmount) : null;

    if (limit) totalLimit = totalLimit.plus(limit);
    totalSpent = totalSpent.plus(spent);
    spentByCategory.delete(category.id);

    const rate = limit ? rateOf(spent, limit) : null;
    // Manfiy qoldiq — limitdan oshgani. Nolga qisib qo'ymaymiz: "qancha
    // oshdik" degan raqam aynan shu ustunda ko'rinishi kerak.
    const remaining = limit ? limit.minus(spent) : null;

    return {
      categoryId: category.id,
      name: category.name,
      isActive: category.isActive,
      excludeFromEbitda: category.excludeFromEbitda,
      limit: limit ? formatAmount(limit) : null,
      spent: formatAmount(spent),
      remaining: remaining ? formatAmount(remaining) : null,
      rate,
      status: statusOf(rate),
      expenseCount: spentRow?.count ?? 0,
      note: budget?.note ?? "",
    };
  });

  // Arxivlangan kategoriyaga tushgan xarajat — ro'yxatdan tushib qolmasin
  const unbudgeted = [...spentByCategory.entries()].map(([categoryId, row]) => {
    totalSpent = totalSpent.plus(row.amount);
    return {
      categoryId,
      name: row.name || "Kategoriyasiz",
      isActive: false,
      excludeFromEbitda: false,
      limit: null,
      spent: formatAmount(row.amount),
      remaining: null,
      rate: null,
      status: "none",
      expenseCount: row.count,
      note: "",
      isArchived: true,
    };
  });

  const all = [...items, ...unbudgeted];
  const totalRate = rateOf(totalSpent, totalLimit);

  return {
    month,
    monthLabel: formatMonthKey(month),
    items: all,
    // Limiti qo'yilganlar oldinda, ular ichida eng ko'p sarflangani tepada:
    // rahbar birinchi navbatda "qaysi limit yonyapti" ni ko'rishi kerak
    ranked: [...all]
      .sort((a, b) => {
        if ((a.limit == null) !== (b.limit == null)) return a.limit == null ? 1 : -1;
        return Number(b.spent) - Number(a.spent);
      })
      .slice(0, 8),
    totals: {
      limit: formatAmount(totalLimit),
      spent: formatAmount(totalSpent),
      remaining: formatAmount(totalLimit.minus(totalSpent)),
      rate: totalRate,
      status: statusOf(totalRate),
      withLimit: items.filter((row) => row.limit != null).length,
      categoryCount: all.length,
      overCount: all.filter((row) => row.status === "over").length,
    },
  };
};

/**
 * Limitlarni yozadi.
 *
 * Bo'sh (`null`) qiymat — limitni OLIB TASHLASH. Yuborilmagan kategoriya
 * o'z holicha qoladi.
 *
 * @param {{month: number|string, items: Array<{categoryId: string, limitAmount?: *, note?: string}>}} data
 * @param {string} userId
 */
const upsertBudgets = async (data = {}, userId) => {
  const month = parseMonthKey(data.month, "Oy");

  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw new BadRequestError("Limit qatorlari yuborilmadi");
  }
  if (data.items.length > 200) {
    throw new BadRequestError("Limit qatorlari juda ko'p");
  }

  const ids = [...new Set(data.items.map((item) => item?.categoryId).filter(Boolean))];
  if (ids.length !== data.items.length) {
    throw new BadRequestError("Kategoriya ikki marta yuborilgan yoki tanlanmagan");
  }

  const categories = await prisma.expenseCategory.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  const known = new Map(categories.map((c) => [c.id, c.name]));

  // ── Avval HAMMASI tekshiriladi, keyin yoziladi ──────────────────────
  // Yarim yozilgan reja eng yomon holat: rahbar ekranda nima saqlanganini
  // bilmay qoladi.
  const plan = [];
  for (const item of data.items) {
    const name = known.get(item.categoryId);
    if (!name) throw new NotFoundError("Xarajat kategoriyasi topilmadi");

    const isEmpty = item.limitAmount == null || item.limitAmount === "";
    if (isEmpty) {
      plan.push({ categoryId: item.categoryId, remove: true });
      continue;
    }

    const limitAmount = parseAmount(item.limitAmount, `"${name}" limiti`);
    plan.push({
      categoryId: item.categoryId,
      limitAmount,
      note: String(item.note ?? "").trim().slice(0, 300),
    });
  }

  await prisma.$transaction(
    plan.map((row) =>
      row.remove
        ? prisma.expenseBudget.deleteMany({
            where: { month, categoryId: row.categoryId },
          })
        : prisma.expenseBudget.upsert({
            where: { month_categoryId: { month, categoryId: row.categoryId } },
            create: {
              month,
              categoryId: row.categoryId,
              limitAmount: row.limitAmount,
              note: row.note,
              createdBy: userId,
              updatedBy: userId,
            },
            update: {
              limitAmount: row.limitAmount,
              note: row.note,
              updatedBy: userId,
            },
          }),
    ),
  );

  return getBudgets({ month });
};

/**
 * Dashboard uchun ixcham kesim — eng "yonayotgan" limitlar.
 * @param {number} month
 */
const loadBudgetSummary = async (month) => {
  const report = await getBudgets({ month });
  return { items: report.ranked, totals: report.totals };
};

module.exports = {
  getBudgets,
  upsertBudgets,
  loadBudgetSummary,
  HEALTHY_RATE,
  WARNING_RATE,
};
