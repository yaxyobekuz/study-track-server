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
const { postEntry, assertActiveAccount } = require("./paymentAccount.service");
const { assertActiveCategory } = require("./expenseCategory.service");

const serializeExpense = (row, { category, account } = {}) => ({
  ...row,
  amount: formatAmount(row.amount),
  // Kategoriya nomi hujjatga MUHRLANGAN — katalog qayta nomlansa ham
  // o'tgan yozuv o'z nomini saqlaydi
  categoryName: row.categoryName || category?.name || "Noma'lum",
  currentCategoryName: category?.name ?? null,
  accountName: account?.name ?? null,
});

/** Sana kelajakda bo'la olmaydi. */
const parseOccurredAt = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new BadRequestError("Sana noto'g'ri");
  if (date.getTime() > Date.now()) {
    throw new BadRequestError("Kelajakdagi sana bilan xarajat qayd etib bo'lmaydi");
  }
  return date;
};

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

  logger.warn(
    `[expense] Xarajat bekor qilindi: expense=${id} ` +
      `summa=${formatAmount(expense.amount)} kategoriya="${expense.categoryName}" ` +
      `actor=${userId} sabab="${trimmed}"`,
  );

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

  if (query.from || query.to) {
    where.occurredAt = {};
    if (query.from) where.occurredAt.gte = new Date(`${query.from}T00:00:00+05:00`);
    if (query.to) where.occurredAt.lte = new Date(`${query.to}T23:59:59.999+05:00`);
  }

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
