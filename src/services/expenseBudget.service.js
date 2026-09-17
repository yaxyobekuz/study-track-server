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

/** Limitning "sog'lomligi" — chegaralar biznes qarori. */
const HEALTHY_RATE = 90; // shu foizgacha — yashil
const WARNING_RATE = 100; // 100% gacha — sariq, undan yuqorisi qizil

/** Foiz rejimi cheklovi — 0 dan katta, 1000% gacha (majburiyatning 10 barobari). */
const MAX_LIMIT_PERCENT = 1000;

// Foiz rejimi. ⚠️ Baza — oyning JAMI HISOBLANGAN MAJBURIYATI (barcha
// o'quvchining tarifi + qo'shimcha xizmatlari, `MonthlyInvoice.amount`
// yig'indisi), o'quvchilar TO'LAGAN puli emas. Saqlanadigan kalit
// tarixiy sabablarga ko'ra "percentIncome" (eski "percentProfit" ham qabul
// qilinadi) — foydalanuvchi buni ko'rmaydi, ekranda "majburiyat foizi".
const PERCENT_KINDS = new Set(["percentIncome", "percentProfit"]);
const isPercentKind = (kind) => PERCENT_KINDS.has(kind);

/**
 * Bir oyning JAMI HISOBLANGAN MAJBURIYATI — "% majburiyat" limiti uchun baza.
 *
 * ⚠️ Baza o'quvchilar TO'LAGAN puli (tushum) EMAS, balki ular berishi kerak
 * bo'lgan JAMI MAJBURIYAT: barcha o'quvchining tarifi + qo'shimcha xizmatlari
 * hisoblanganda chiqadigan summa. Bu — "Umumiy" tabidagi HISOBLANGAN raqami
 * (`financeReport.sumRange().invoiced` bilan bir manba: `MonthlyInvoice.amount`,
 * bekor qilinganlarsiz).
 *
 * @param {number} month - YYYYMM
 * @returns {Promise<Decimal>}
 */
const computeMonthAccrued = async (month) => {
  const agg = await prisma.monthlyInvoice.aggregate({
    where: { month, status: { not: "cancelled" } },
    _sum: { amount: true },
  });
  return new Decimal(agg._sum.amount ?? 0);
};

/**
 * Budjet qatorining AMALDAGI limiti (so'mda).
 *   money         → limitAmount.
 *   percentIncome → max(0, majburiyat) × foiz / 100. Majburiyat 0 bo'lsa limit 0.
 *
 * @param {{limitKind: string, limitAmount: *, limitPercent: *}} budget
 * @param {Decimal|null} base - oyning jami hisoblangan majburiyati (foiz rejimida)
 * @returns {Decimal}
 */
const effectiveLimit = (budget, base) => {
  if (isPercentKind(budget.limitKind)) {
    const pct = new Decimal(budget.limitPercent ?? 0);
    const b = base && base.greaterThan(0) ? base : new Decimal(0);
    return b.times(pct).div(100).toDecimalPlaces(2);
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

  const [categories, budgets, spentRows, salaryAgg] = await Promise.all([
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
    // ⚠️ XODIMLAR OYLIGI (SalaryPayment) — "Oylik" kategoriyasining ISHLATILGANI
    // shu jadvaldan chiqadi. Oylik to'lovi Expense yozuvi YARATMAYDI (u yoqdan
    // ham, "Oylik" xarajat kategoriyasidan ham SalaryPayment yoziladi), shuning
    // uchun budjet "ishlatilgan" i SalaryPayment'ni qo'shmasa 0 bo'lib qolardi.
    // Payroll "Tarqatildi" bilan AYNAN bir manba → ikki joyda bir xil summa.
    prisma.salaryPayment.aggregate({
      where: { isVoided: false, paidAt: { gte: from, lte: to } },
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

  // "Oylik" kategoriyasi (nomi bilan aniqlanadi — `ExpenseModals.isSalaryName`
  // bilan bir xil qoida) ishlatilganiga oylik to'lovlarini qo'shamiz.
  const salaryTotal = new Decimal(salaryAgg._sum.amount ?? 0);
  if (salaryTotal.greaterThan(0)) {
    const salaryCat = categories.find(
      (c) => String(c.name ?? "").trim().toLowerCase() === "oylik",
    );
    if (salaryCat) {
      const prev = spentByCategory.get(salaryCat.id) ?? {
        amount: new Decimal(0),
        count: 0,
        name: salaryCat.name,
      };
      prev.amount = prev.amount.plus(salaryTotal);
      prev.count += salaryAgg._count._all;
      spentByCategory.set(salaryCat.id, prev);
    }
  }

  // Jami hisoblangan majburiyat — "% majburiyat" limitining bazasi. DOIM
  // hisoblanadi: modal foiz rejimiga o'tkazganda amaldagi summani darhol
  // ko'rsatishi kerak va kartada "Hisoblangan: X" hint chiqadi.
  const accrued = await computeMonthAccrued(month);

  let totalLimit = new Decimal(0);
  let totalSpent = new Decimal(0);

  // ⚠️ "Foyda" kategoriyasi ALOHIDA: uning limiti admin tomonidan
  // qo'yilmaydi, balki FORMULA bilan hisoblanadi — jami kutilayotgan kirim
  // (accrued) MINUS boshqa barcha kategoriyalar limiti. Shu tufayli pastdagi
  // JAMI limit aynan kirimga teng bo'ladi (foyda — "qolgan" ulush). U doim
  // JAMI'dan bitta yuqorida (eng oxirgi qator) turadi.
  const isFoydaCat = (c) => String(c.name ?? "").trim().toLowerCase() === "foyda";

  const buildItem = (category, limit, spentRow) => {
    const budget = limitByCategory.get(category.id);
    const spent = spentRow?.amount ?? new Decimal(0);
    const rate = limit ? rateOf(spent, limit) : null;
    // Manfiy qoldiq — limitdan oshgani. Nolga qisib qo'ymaymiz.
    const remaining = limit ? limit.minus(spent) : null;
    const kind = isPercentKind(budget?.limitKind) ? "percentIncome" : "money";
    return {
      categoryId: category.id,
      name: category.name,
      isActive: category.isActive,
      excludeFromEbitda: category.excludeFromEbitda,
      limit: limit ? formatAmount(limit) : null,
      limitKind: kind,
      limitPercent:
        kind === "percentIncome" && budget?.limitPercent != null
          ? Number(budget.limitPercent)
          : null,
      spent: formatAmount(spent),
      remaining: remaining ? formatAmount(remaining) : null,
      rate,
      status: statusOf(rate),
      expenseCount: spentRow?.count ?? 0,
      note: budget?.note ?? "",
      isFoyda: isFoydaCat(category),
    };
  };

  // 1 ── Foyda'DAN TASHQARI barcha kategoriyalar (katalog tartibida)
  const foydaCat = categories.find(isFoydaCat) ?? null;
  const items = [];
  for (const category of categories) {
    if (foydaCat && category.id === foydaCat.id) continue; // Foyda — oxirida
    const budget = limitByCategory.get(category.id);
    const limit = budget ? effectiveLimit(budget, accrued) : null;
    if (limit) totalLimit = totalLimit.plus(limit);
    const spentRow = spentByCategory.get(category.id);
    totalSpent = totalSpent.plus(spentRow?.amount ?? new Decimal(0));
    items.push(buildItem(category, limit, spentRow));
    spentByCategory.delete(category.id);
  }

  // 2 ── FOYDA limiti = kirim − boshqa limitlar (manfiy bo'lmaydi)
  const gap = accrued.minus(totalLimit);
  const foydaLimit = gap.isNegative() ? new Decimal(0) : gap;
  const foydaSpentRow = foydaCat ? spentByCategory.get(foydaCat.id) : null;
  if (foydaCat) spentByCategory.delete(foydaCat.id); // unbudgeted'ga tushmasin

  // 3 ── Arxivlangan kategoriyaga tushgan xarajat (Foyda emas)
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

  // 4 ── FOYDA qatori — eng oxirida (JAMI'dan bitta yuqorida). Uni qo'shgach
  //      JAMI limit = accrued (kirim) bo'ladi.
  let foydaItem = null;
  if (foydaCat) {
    totalLimit = totalLimit.plus(foydaLimit);
    totalSpent = totalSpent.plus(foydaSpentRow?.amount ?? new Decimal(0));
    foydaItem = buildItem(foydaCat, foydaLimit, foydaSpentRow);
  }

  const all = [...items, ...unbudgeted, ...(foydaItem ? [foydaItem] : [])];
  const totalRate = rateOf(totalSpent, totalLimit);

  return {
    month,
    monthLabel: formatMonthKey(month),
    // "% majburiyat" limiti bazasi — UI "majburiyatning 20% i = X so'm" ni
    // ko'rsatadi. Bu — "Umumiy" tabidagi HISOBLANGAN raqami.
    accrued: formatAmount(accrued),
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
      // FOYDA endi "Foyda" kategoriyasi limiti sifatida jadvalda ko'rinadi
      // (JAMI'dan bitta yuqorida). Bu maydonlar mavjud iste'molchilar uchun
      // saqlanadi: expectedProfit = foyda ulushi (kirim − boshqa limitlar).
      expectedProfit: formatAmount(foydaLimit),
      limitPercent: accrued.greaterThan(0)
        ? Number(totalLimit.minus(foydaLimit).div(accrued).times(100).toFixed(1))
        : null,
      profitPercent: accrued.greaterThan(0)
        ? Number(foydaLimit.div(accrued).times(100).toFixed(1))
        : null,
      rate: totalRate,
      status: statusOf(totalRate),
      withLimit: all.filter((row) => row.limit != null).length,
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

    const kind = item.limitKind === "percentIncome" ? "percentIncome" : "money";
    const note = String(item.note ?? "").trim().slice(0, 300);

    if (kind === "percentIncome") {
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
  computeMonthAccrued,
  effectiveLimit,
  HEALTHY_RATE,
  WARNING_RATE,
};
