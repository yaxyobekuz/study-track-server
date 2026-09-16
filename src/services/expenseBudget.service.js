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
  monthInstantRange,
} = require("../helpers/month.helpers");
const { Decimal, formatAmount, parseAmount } = require("../helpers/money.helpers");
const { sumIncome, sumExpense } = require("./financeReport.service");

/** Limitning "sog'lomligi" — chegaralar biznes qarori. */
const HEALTHY_RATE = 90; // shu foizgacha — yashil
const WARNING_RATE = 100; // 100% gacha — sariq, undan yuqorisi qizil

/** Foiz rejimi cheklovi — 0 dan katta, 1000% gacha (foydaning 10 barobari). */
const MAX_LIMIT_PERCENT = 1000;

/**
 * Bir oyning SOF FOYDASI (tushum − xarajat) — "% foyda" limiti uchun baza.
 *
 * ⚠️ `financeDashboard` dagi `monthFigures.profit` bilan AYNAN bir manba
 * (`sumIncome`/`sumExpense`) — aks holda dashboarddagi "Sof foyda" bilan
 * limit bazasi bir-biriga to'g'ri kelmasdi.
 *
 * @param {Date} from
 * @param {Date} to
 * @returns {Promise<Decimal>}
 */
const computeMonthProfit = async (from, to) => {
  const [income, expense] = await Promise.all([sumIncome(from, to), sumExpense(from, to)]);
  return new Decimal(income).minus(expense.total);
};

/**
 * Budjet qatorining AMALDAGI limiti (so'mda).
 *   money         → limitAmount.
 *   percentProfit → max(0, foyda) × foiz / 100. Foyda manfiy bo'lsa limit 0
 *     (yo'q foydadan foiz olib bo'lmaydi) — natijada har xarajat "oshgan"
 *     bo'lib ko'rinadi, bu ATAYLAB: zarar oyida yangi xarajatga ruxsat bermaslik.
 *
 * @param {{limitKind: string, limitAmount: *, limitPercent: *}} budget
 * @param {Decimal|null} profit
 * @returns {Decimal}
 */
const effectiveLimit = (budget, profit) => {
  if (budget.limitKind === "percentProfit") {
    const pct = new Decimal(budget.limitPercent ?? 0);
    const base = profit && profit.greaterThan(0) ? profit : new Decimal(0);
    return base.times(pct).div(100).toDecimalPlaces(2);
  }
  return new Decimal(budget.limitAmount);
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
  const { from, to } = monthInstantRange(month);

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

  // Sof foyda — "% foyda" limitining bazasi. DOIM hisoblanadi: modal foiz
  // rejimiga o'tkazganda amaldagi summani darhol ko'rsatishi kerak va
  // kartada "Sof foyda: X" hint chiqadi.
  const profit = await computeMonthProfit(from, to);

  let totalLimit = new Decimal(0);
  let totalSpent = new Decimal(0);

  const items = categories.map((category) => {
    const budget = limitByCategory.get(category.id);
    const spentRow = spentByCategory.get(category.id);
    const spent = spentRow?.amount ?? new Decimal(0);
    const limit = budget ? effectiveLimit(budget, profit) : null;

    if (limit) totalLimit = totalLimit.plus(limit);
    totalSpent = totalSpent.plus(spent);
    spentByCategory.delete(category.id);

    const rate = limit ? rateOf(spent, limit) : null;
    // Manfiy qoldiq — limitdan oshgani. Nolga qisib qo'ymaymiz: "qancha
    // oshdik" degan raqam aynan shu ustunda ko'rinishi kerak.
    const remaining = limit ? limit.minus(spent) : null;

    const kind = budget?.limitKind ?? "money";

    return {
      categoryId: category.id,
      name: category.name,
      isActive: category.isActive,
      excludeFromEbitda: category.excludeFromEbitda,
      // `limit` — AMALDAGI so'm (foiz rejimida foydadan hisoblangan)
      limit: limit ? formatAmount(limit) : null,
      // Rejim va uni tahrirlash uchun xom qiymatlar (modal shulardan to'ladi)
      limitKind: kind,
      limitPercent:
        kind === "percentProfit" && budget?.limitPercent != null
          ? Number(budget.limitPercent)
          : null,
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
      limitKind: "money",
      limitPercent: null,
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
    // "% foyda" limiti bazasi — UI "foydaning 20% i = X so'm" ni ko'rsatadi.
    profit: formatAmount(profit),
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

    const kind = item.limitKind === "percentProfit" ? "percentProfit" : "money";
    const note = String(item.note ?? "").trim().slice(0, 300);

    if (kind === "percentProfit") {
      // Foiz rejimi — qiymat `limitPercent` dan keladi
      const raw = item.limitPercent;
      if (raw == null || raw === "") {
        plan.push({ categoryId: item.categoryId, remove: true });
        continue;
      }
      const pct = Number(raw);
      if (!Number.isFinite(pct) || pct <= 0 || pct > MAX_LIMIT_PERCENT) {
        throw new BadRequestError(
          `"${name}" limiti foizi 0 dan katta va ${MAX_LIMIT_PERCENT} dan kichik bo'lishi kerak`,
        );
      }
      plan.push({
        categoryId: item.categoryId,
        kind,
        // Foiz — 2 xonagacha; limitAmount foiz rejimida ishlatilmaydi (0)
        limitPercent: new Decimal(pct).toDecimalPlaces(2),
        limitAmount: new Decimal(0),
        note,
      });
      continue;
    }

    // Qat'iy summa rejimi
    const isEmpty = item.limitAmount == null || item.limitAmount === "";
    if (isEmpty) {
      plan.push({ categoryId: item.categoryId, remove: true });
      continue;
    }
    const limitAmount = parseAmount(item.limitAmount, `"${name}" limiti`);
    plan.push({
      categoryId: item.categoryId,
      kind,
      limitAmount,
      limitPercent: null,
      note,
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
              limitKind: row.kind,
              limitAmount: row.limitAmount,
              limitPercent: row.limitPercent,
              note: row.note,
              createdBy: userId,
              updatedBy: userId,
            },
            update: {
              limitKind: row.kind,
              limitAmount: row.limitAmount,
              limitPercent: row.limitPercent,
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
  computeMonthProfit,
  effectiveLimit,
  HEALTHY_RATE,
  WARNING_RATE,
};
