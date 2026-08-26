/**
 * TASHQI KIRIMLAR — o'quvchi to'lovi BO'LMAGAN pul.
 *
 * Ijara, kitob sotuvi, homiylik. Ilgari bunday pulni tizimga kiritishning
 * yagona yo'li "Qo'lda to'g'rilash" edi — sababi erkin matnda qolib ketadigan,
 * kategoriyasiz va hisobotga tushmaydigan yozuv.
 *
 * ⚠️ Bu KIRIM. Chiqim (xarajat, ish haqi, inkassatsiya) hali yo'q.
 *
 * MUNOSABAT: hujjat (`ExternalIncome`) + uning daftardagi izi
 * (`AccountEntry`) — `Payment` va `AccountTransfer` bilan bir xil.
 *
 * ⚠️ LOCK TARTIBI BUZILMAYDI. Tashqi kirim faqat `PaymentAccount` ga tegadi,
 * u esa tartibning OXIRGI bo'g'ini (`StudentAccount → MonthlyInvoice →
 * PaymentAccount`). O'quvchi hisobiga ham, hisob-fakturaga ham tegilmaydi,
 * shuning uchun deadlock imkonsiz.
 *
 * ⚠️ BEKOR QILISH — bayroq EMAS, teskari qator. Daftar append-only:
 * `isVoided` ni qo'yishning o'zi kassa qoldig'ini qaytarmaydi.
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
const { assertActiveCategory } = require("./incomeCategory.service");

const serializeIncome = (row, { category, account } = {}) => ({
  ...row,
  amount: formatAmount(row.amount),
  // Kategoriya nomi hujjatga MUHRLANGAN — katalog keyin qayta nomlansa ham
  // o'tgan yozuv o'z nomini saqlaydi. Katalog qatori bo'lsa, joriy nomi ham
  // beriladi (ular farq qilsa, UI eskisini ko'rsatadi).
  categoryName: row.categoryName || category?.name || "Noma'lum",
  currentCategoryName: category?.name ?? null,
  accountName: account?.name ?? null,
});

/** Sana — kelajakda bo'la olmaydi (`payment.service.js` bilan bir xil qoida). */
const parseOccurredAt = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new BadRequestError("Sana noto'g'ri");

  if (date.getTime() > Date.now()) {
    throw new BadRequestError("Kelajakdagi sana bilan kirim qayd etib bo'lmaydi");
  }

  return date;
};

/**
 * Kirim qayd etadi: hujjat + daftar qatori BITTA tranzaksiyada.
 *
 * @param {object} data - { categoryId, accountId, amount, payer, note, occurredAt }
 * @param {string} userId
 * @returns {Promise<object>}
 */
const createIncome = async (data, userId) => {
  const amount = parseAmount(data.amount, "Summa");
  if (amount.lessThanOrEqualTo(0)) {
    throw new BadRequestError("Summa noldan katta bo'lishi kerak");
  }

  // Arxivlangan kategoriyaga ham, arxivlangan to'lov turiga ham yozib bo'lmaydi
  const [category, account] = await Promise.all([
    assertActiveCategory(data.categoryId),
    assertActiveAccount(data.accountId),
  ]);

  const occurredAt = parseOccurredAt(data.occurredAt);

  const income = await prisma.$transaction(async (tx) => {
    const created = await tx.externalIncome.create({
      data: {
        categoryId: category.id,
        accountId: account.id,
        amount,
        categoryName: category.name,
        payer: data.payer?.trim() || "",
        note: data.note?.trim() || "",
        occurredAt,
        createdBy: userId,
      },
    });

    // Daftarga YAGONA nuqta orqali: `balanceAfter` shu yerda hosil bo'ladi
    await postEntry(tx, {
      accountId: account.id,
      type: "external_income",
      amount,
      occurredAt,
      externalIncomeId: created.id,
      note: [category.name, created.payer].filter(Boolean).join(" — "),
      createdBy: userId,
    });

    return created;
  });

  logger.info(
    `[income] Tashqi kirim: ${formatAmount(amount)} · ${category.name} · ` +
      `${account.name} · actor=${userId}`,
  );

  return serializeIncome(income, { category, account });
};

/**
 * Bekor qilish — teskari daftar qatori bilan.
 *
 * Yozuv o'chirilmaydi va tahrirlanmaydi: daftar append-only, shuning uchun
 * kassa qoldig'i faqat kompensatsiya qatori orqali qaytadi.
 *
 * @param {string} id
 * @param {string} reason
 * @param {string} userId
 */
const voidIncome = async (id, reason, userId) => {
  const income = await prisma.externalIncome.findUnique({ where: { id } });
  if (!income) throw new NotFoundError("Kirim topilmadi");
  if (income.isVoided) throw new BadRequestError("Kirim allaqachon bekor qilingan");

  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError("Bekor qilish sababi majburiy");

  logger.warn(
    `[income] Tashqi kirim bekor qilindi: income=${id} ` +
      `summa=${formatAmount(income.amount)} kategoriya="${income.categoryName}" ` +
      `actor=${userId} sabab="${trimmed}"`,
  );

  const result = await prisma.$transaction(async (tx) => {
    // Ikki marta bekor qilish poygasi — compare-and-swap
    const voided = await tx.externalIncome.updateMany({
      where: { id, isVoided: false },
      data: {
        isVoided: true,
        voidedAt: new Date(),
        voidedBy: userId,
        voidReason: trimmed,
      },
    });

    if (voided.count !== 1) {
      throw new ConflictError("Kirim allaqachon bekor qilingan");
    }

    // Teskari qator — ishorasi manfiy, `assertSignMatchesType` tekshiradi
    await postEntry(tx, {
      accountId: income.accountId,
      type: "external_income_void",
      amount: new Decimal(income.amount).negated(),
      occurredAt: new Date(),
      externalIncomeId: income.id,
      note: `Bekor qilindi: ${trimmed}`,
      createdBy: userId,
    });

    return tx.externalIncome.findUnique({ where: { id } });
  });

  return serializeIncome(result);
};

/**
 * Kirimlar registri (sahifalangan).
 *
 * @param {object} req - { query: { categoryId, accountId, from, to, includeVoided } }
 */
const getIncomes = async (req) => {
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
    prisma.externalIncome.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
      include: {
        category: { select: { name: true } },
        account: { select: { name: true } },
      },
    }),
    prisma.externalIncome.count({ where }),
    // Jami — SAHIFA bo'yicha emas, butun filtr bo'yicha. Aks holda birinchi
    // sahifada bir summa, ikkinchisida boshqa summa ko'rinardi.
    prisma.externalIncome.aggregate({
      where: { ...where, isVoided: false },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  return {
    ...formatPaginationResponse(
      rows.map(({ category, account, ...row }) =>
        serializeIncome(row, { category, account }),
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
  serializeIncome,
  createIncome,
  voidIncome,
  getIncomes,
};
