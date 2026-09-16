/**
 * XARAJATLAR — kommunal, ta'mirlash, jihoz, oziq-ovqat.
 *
 * `externalIncome.service.js` ning ko'zgusi. Yagona, lekin MUHIM farq:
 * pul kassadan CHIQADI, ya'ni daftar qatori MANFIY (`expense`).
 * `assertSignMatchesType` buni invariant sifatida tekshiradi.
 *
 * ⚠️ XODIM OYLIGI BU YERDA EMAS. U alohida mexanizm (`payroll.service.js` +
 * `salaryPayment.service.js`): oylik har oy avtomat hisoblanadi va qarz
 * hosil qiladi, xarajat esa bir martalik hodisa. Ikkalasini bitta jadvalga
 * qo'shsak, "kimga qancha qarzdormiz" degan savol javobsiz qolardi.
 *
 * ⚠️ LOCK TARTIBI: xarajat FAQAT `PaymentAccount` ga tegadi — u tartibning
 * OXIRGI bo'g'ini, shuning uchun deadlock imkonsiz.
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError, NotFoundError, ConflictError } = require("../utils/errors");
const logger = require("../utils/logger");
const { Decimal, parseAmount, formatAmount } = require("../helpers/money.helpers");
const {
  parseDayRangeFilter,
  parseRecordedAt,
  monthInstantRange,
  formatMonthKey,
} = require("../helpers/month.helpers");

/**
 * Instant → Toshkent oyi (YYYYMM). `monthInstantRange` bilan izchil: u
 * Toshkent oyini UTC oraliqqa aylantiradi, bu esa teskarisini qiladi
 * (instant + 5 soat, so'ng UTC yil/oy). `currentMonthKey` bilan bir mantiq.
 */
const monthKeyOfInstant = (date) => {
  const t = new Date(date.getTime() + 5 * 3600000);
  return t.getUTCFullYear() * 100 + t.getUTCMonth() + 1;
};
const { postEntry, assertActiveAccount } = require("./paymentAccount.service");
const { assertActiveCategory } = require("./expenseCategory.service");

/**
 * XARAJAT LIMITI TEKSHIRUVI. Kategoriyaga o'sha OY uchun limit qo'yilgan
 * bo'lsa va yangi xarajat bilan birga limitdan OSHSA — rad etiladi.
 *
 * ⚠️ Limit qo'yilmagan kategoriyaga TEKSHIRUV YO'Q (avvalgi xatti-harakat
 * saqlanadi — limit ixtiyoriy). Bekor qilingan xarajatlar hisobga olinmaydi.
 * Bu KASSA qoldig'i tekshiruvidan boshqa narsa: kassa manfiy bo'lishi mumkin,
 * lekin admin qo'ygan kategoriya limiti majburiy.
 *
 * @throws {BadRequestError} limitdan oshsa (so'rov yuborishga chaqiradi)
 */
const assertWithinLimit = async (categoryId, categoryName, amount, occurredAt) => {
  const month = monthKeyOfInstant(occurredAt);
  const budget = await prisma.expenseBudget.findUnique({
    where: { month_categoryId: { month, categoryId } },
    select: { limitKind: true, limitAmount: true, limitPercent: true },
  });
  if (!budget) return; // limit yo'q — cheklov yo'q

  const { from, to } = monthInstantRange(month);
  const spentAgg = await prisma.expense.aggregate({
    where: { categoryId, isVoided: false, occurredAt: { gte: from, lte: to } },
    _sum: { amount: true },
  });

  // Amaldagi limit — foiz rejimida joriy oy sof foydasidan hisoblanadi
  // (`getBudgets` bilan bir manba: bir xil summani ko'rsatib, bir xil rad etadi)
  const {
    effectiveLimit,
    computeMonthProfit,
  } = require("./expenseBudget.service");
  const profit =
    budget.limitKind === "percentProfit" ? await computeMonthProfit(from, to) : null;
  const limit = effectiveLimit(budget, profit);
  const spent = new Decimal(spentAgg._sum.amount ?? 0);
  const afterThis = spent.plus(amount);

  if (afterThis.greaterThan(limit)) {
    const remaining = limit.minus(spent);
    throw new BadRequestError(
      `"${categoryName}" kategoriyasi limiti oshib ketadi. ` +
        `${formatMonthKey(month)}: limit ${formatAmount(limit)} so'm, ` +
        `ishlatilgan ${formatAmount(spent)} so'm, qolgan ${formatAmount(remaining)} so'm. ` +
        `Ushbu xarajat (${formatAmount(amount)} so'm) sig'maydi — limit oshirish so'rovini yuboring.`,
    );
  }
};

const serializeExpense = (row, { category, account } = {}) => ({
  ...row,
  amount: formatAmount(row.amount),
  // Kategoriya nomi hujjatga MUHRLANGAN — katalog qayta nomlansa ham
  // o'tgan yozuv o'z nomini saqlaydi
  categoryName: row.categoryName || category?.name || "Noma'lum",
  currentCategoryName: category?.name ?? null,
  accountName: account?.name ?? null,
});

/** Sana kelajakda bo'la olmaydi — modul bo'ylab bitta qoida. */
const parseOccurredAt = (value) => parseRecordedAt(value, { subject: "xarajat" });

/**
 * Xarajat qayd etadi: hujjat + daftar qatori BITTA tranzaksiyada.
 *
 * @param {object} data - { categoryId, accountId, amount, payee, note, occurredAt }
 * @param {string} userId
 */
const createExpense = async (data, userId) => {
  const amount = parseAmount(data.amount, "Summa");
  if (amount.lessThanOrEqualTo(0)) {
    throw new BadRequestError("Summa noldan katta bo'lishi kerak");
  }

  const [category, account] = await Promise.all([
    assertActiveCategory(data.categoryId),
    assertActiveAccount(data.accountId),
  ]);

  const occurredAt = parseOccurredAt(data.occurredAt);

  // ⚠️ KATEGORIYA LIMITI majburiy (admin qo'ygan bo'lsa). Kassa qoldig'idan
  // farqli — u tekshirilmaydi (pastdagi izoh), lekin limit oshsa xarajat
  // rad etiladi va foydalanuvchi limit oshirish so'rovi yuboradi.
  await assertWithinLimit(category.id, category.name, amount, occurredAt);

  // ⚠️ Kassada yetarli pul bormi — TEKSHIRILMAYDI va bu ATAYLAB.
  // Qoldiq manfiy bo'lishi mumkin: kassa daftari haqiqatni yozadi, uni
  // to'g'rilash esa "Qo'lda to'g'rilash" yoki o'tkazma bilan qilinadi.
  // Bloklab qo'ysak, xodim haqiqiy xarajatni tizimga kirita olmay qolardi.
  const expense = await prisma.$transaction(async (tx) => {
    const created = await tx.expense.create({
      data: {
        categoryId: category.id,
        accountId: account.id,
        amount,
        categoryName: category.name,
        payee: data.payee?.trim() || "",
        note: data.note?.trim() || "",
        occurredAt,
        createdBy: userId,
      },
    });

    await postEntry(tx, {
      accountId: account.id,
      type: "expense",
      amount: amount.negated(), // pul CHIQADI
      occurredAt,
      expenseId: created.id,
      note: [category.name, created.payee].filter(Boolean).join(" — "),
      createdBy: userId,
    });

    return created;
  });

  logger.info(
    `[expense] Xarajat: ${formatAmount(amount)} · ${category.name} · ` +
      `${account.name} · actor=${userId}`,
  );

  return serializeExpense(expense, { category, account });
};

/**
 * Bekor qilish — teskari daftar qatori bilan.
 * Yozuv o'chirilmaydi: daftar append-only.
 */
const voidExpense = async (id, reason, userId) => {
  const expense = await prisma.expense.findUnique({ where: { id } });
  if (!expense) throw new NotFoundError("Xarajat topilmadi");
  if (expense.isVoided) throw new BadRequestError("Xarajat allaqachon bekor qilingan");

  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError("Bekor qilish sababi majburiy");

  const result = await prisma.$transaction(async (tx) => {
    const voided = await tx.expense.updateMany({
      where: { id, isVoided: false },
      data: {
        isVoided: true,
        voidedAt: new Date(),
        voidedBy: userId,
        voidReason: trimmed,
      },
    });

    if (voided.count !== 1) {
      throw new ConflictError("Xarajat allaqachon bekor qilingan");
    }

    // Teskari qator — pul kassaga QAYTADI, ya'ni musbat
    await postEntry(tx, {
      accountId: expense.accountId,
      type: "expense_void",
      amount: new Decimal(expense.amount),
      occurredAt: new Date(),
      expenseId: expense.id,
      note: `Bekor qilindi: ${trimmed}`,
      createdBy: userId,
    });

    return tx.expense.findUnique({ where: { id } });
  });

  // ⚠️ AUDIT YOZUVI TRANZAKSIYADAN KEYIN — modul bo'ylab bitta tartib
  // (`payment.voidPayment` dagi izohga qarang). `createExpense` allaqachon
  // shunday ishlaydi: yozuv muvaffaqiyatli bo'lgandan keyin logga tushadi.
  logger.warn(
    `[expense] Xarajat bekor qilindi: expense=${id} ` +
      `summa=${formatAmount(expense.amount)} kategoriya="${expense.categoryName}" ` +
      `actor=${userId} sabab="${trimmed}"`,
  );

  return serializeExpense(result);
};

/** Xarajatlar registri (sahifalangan). */
const getExpenses = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const where = {};
  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.accountId) where.accountId = query.accountId;
  if (query.includeVoided !== "true") where.isVoided = false;

  // Kun chegarasi TOSHKENT bo'yicha — modul bo'ylab bitta manbadan
  // (yaroqsiz sana ham shu yerda rad etiladi, Prisma'ga tushmaydi)
  const range = parseDayRangeFilter(query);
  if (range) where.occurredAt = range;

  const [rows, total, agg] = await Promise.all([
    prisma.expense.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
      include: {
        category: { select: { name: true } },
        account: { select: { name: true } },
      },
    }),
    prisma.expense.count({ where }),
    // Jami — SAHIFA bo'yicha emas, butun filtr bo'yicha
    prisma.expense.aggregate({
      where: { ...where, isVoided: false },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  return {
    ...formatPaginationResponse(
      rows.map(({ category, account, ...row }) =>
        serializeExpense(row, { category, account }),
      ),
      total,
      page,
      limit,
    ),
    totals: {
      amount: formatAmount(new Decimal(agg._sum.amount ?? 0)),
      count: agg._count._all,
    },
  };
};

module.exports = {
  serializeExpense,
  createExpense,
  voidExpense,
  getExpenses,
};
