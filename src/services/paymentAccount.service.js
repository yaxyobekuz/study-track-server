/**
 * To'lov turlari — pul qayerga tushadi: "Naqd", "Uzcard terminal", "Ipoteka bank".
 *
 * Dinamik katalog: `PaymentMethod` enumi shu bilan almashtirildi.
 *
 * HARAKATLAR DAFTARI QAT'IY APPEND-ONLY. Qator tahrirlanmaydi ham, o'chirilmaydi
 * ham; xato yozuv teskari (kompensatsiya) qatori bilan yopiladi. Shuning
 * uchun daftarga yozadigan YAGONA nuqta — `postEntry()`.
 *
 * `postEntry` ning ikki operatorli shakli MAJBURIY:
 *   1) `update({ balance: { increment } })` — qator lock'ini oladi VA
 *      yangilangan qoldiqni qaytaradi,
 *   2) shu qaytgan qiymat `balanceAfter` bo'lib yoziladi.
 * "O'qi → hisobla → yoz" aynan yo'qolgan yangilanish shakli va bu yerda
 * pul yo'qolishiga olib kelardi.
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const logger = require("../utils/logger");
const {
  Decimal,
  parseAmount,
  parseSignedAmount,
  formatAmount,
  assertSignMatchesType,
} = require("../helpers/money.helpers");

const ENTRY_TYPE_LABELS = {
  payment: "To'lov",
  payment_void: "To'lov bekor qilindi",
  transfer_in: "O'tkazma (kirim)",
  transfer_out: "O'tkazma (chiqim)",
  refund: "Qaytarildi",
  refund_void: "Qaytarish bekor qilindi",
  adjustment: "Qo'lda to'g'rilash",
  external_income: "Tashqi kirim",
  external_income_void: "Tashqi kirim bekor qilindi",
};

const serializeAccount = (row, extra = {}) => ({
  ...row,
  openingBalance: formatAmount(row.openingBalance),
  balance: formatAmount(row.balance),
  ...extra,
});

const serializeEntry = (row, { account } = {}) => ({
  ...row,
  // BigInt JSON'ga tushmaydi — string sifatida chiqadi
  seq: row.seq != null ? String(row.seq) : null,
  amount: formatAmount(row.amount),
  balanceAfter: formatAmount(row.balanceAfter),
  typeLabel: ENTRY_TYPE_LABELS[row.type] ?? row.type,
  isIncome: new Decimal(row.amount).greaterThan(0),
  account: account ? { id: account.id, name: account.name } : null,
});

// ─────────────────────────────────────────────
// Daftarga yozishning YAGONA nuqtasi
// ─────────────────────────────────────────────

/**
 * Harakatlar daftariga bitta qator yozadi va qoldiqni yangilaydi.
 *
 * HAR DOIM tranzaksiya ichida chaqiriladi va LOCK TARTIBIDA OXIRGI bo'ladi
 * (StudentAccount → MonthlyInvoice → PaymentAccount).
 *
 * @param {object} tx - Prisma tranzaksiya klienti
 * @param {object} params
 * @param {string} params.accountId
 * @param {string} params.type - AccountEntryType
 * @param {Prisma.Decimal} params.amount - ISHORALI (+ kirim, − chiqim)
 * @param {Date} params.occurredAt - BIZNES sanasi
 * @param {string} params.createdBy
 * @param {string} [params.paymentId]
 * @param {string} [params.transferId]
 * @param {string} [params.refundId]
 * @param {string} [params.note]
 * @returns {Promise<object>} yozilgan qator (xom)
 */
const postEntry = async (tx, params) => {
  const { accountId, type, amount, occurredAt, createdBy } = params;

  // Ishora turga mos kelishi — INVARIANT, kelishuv emas
  assertSignMatchesType(type, amount);

  // 1) increment BIRINCHI: qator lock'ini oladi va post-image qaytaradi
  const account = await tx.paymentAccount.update({
    where: { id: accountId },
    data: { balance: { increment: amount } },
  });

  // 2) balanceAfter — AYNAN shu qaytgan qiymat
  return tx.accountEntry.create({
    data: {
      accountId,
      type,
      amount,
      balanceAfter: account.balance,
      occurredAt,
      paymentId: params.paymentId ?? null,
      transferId: params.transferId ?? null,
      refundId: params.refundId ?? null,
      externalIncomeId: params.externalIncomeId ?? null,
      note: params.note?.trim() || "",
      createdBy,
    },
  });
};

/**
 * To'lov turi mavjud va faolligini tekshiradi (to'lov qabul qilishdan oldin).
 * @param {string} accountId
 * @returns {Promise<object>}
 */
const assertActiveAccount = async (accountId) => {
  if (!accountId) throw new BadRequestError("To'lov turi tanlanmagan");

  const account = await prisma.paymentAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new NotFoundError("To'lov turi topilmadi");

  if (account.isArchived || !account.isActive) {
    throw new BadRequestError(`"${account.name}" faol emas`);
  }

  return account;
};

// ─────────────────────────────────────────────
// Katalog
// ─────────────────────────────────────────────

/**
 * To'lov turlari ro'yxati (sahifalanmaydi — ular o'nlab, yuzlab emas).
 * @param {object} query - { status }
 * @returns {Promise<{items: object[], totals: object}>}
 */
const getAccounts = async (query = {}) => {
  const filter = {};
  if (query.status === "archived") filter.isArchived = true;
  else {
    filter.isArchived = false;
    if (query.status === "active") filter.isActive = true;
    if (query.status === "inactive") filter.isActive = false;
  }

  const rows = await prisma.paymentAccount.findMany({
    where: filter,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  const total = rows.reduce((acc, row) => acc.plus(row.balance), new Decimal(0));

  return {
    items: rows.map((row) => serializeAccount(row)),
    totals: { count: rows.length, totalBalance: formatAmount(total) },
  };
};

const getAccountById = async (id) => {
  const row = await prisma.paymentAccount.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("To'lov turi topilmadi");

  return serializeAccount(row);
};

const rethrowDuplicate = (error, message) => {
  if (error?.code === "P2002") throw new BadRequestError(message);
  throw error;
};

/**
 * Yangi to'lov turi.
 *
 * `openingBalance` yozilganda daftarga `adjustment` qatori YOZILMAYDI:
 * u boshlang'ich holat, harakat emas. Qoldiq = openingBalance + Σ entries,
 * shuning uchun `balance` boshidanoq `openingBalance` ga tenglashtiriladi.
 *
 * @param {object} data - { name, openingBalance, sortOrder }
 * @param {string} userId
 * @returns {Promise<object>}
 */
const createAccount = async (data, userId) => {
  const name = data.name?.trim();
  if (!name) throw new BadRequestError("To'lov turi nomi kiritilmagan");

  const opening = data.openingBalance
    ? parseAmount(data.openingBalance, "Boshlang'ich qoldiq")
    : new Decimal(0);

  try {
    const row = await prisma.paymentAccount.create({
      data: {
        name,
        openingBalance: opening,
        balance: opening,
        sortOrder: Number.isInteger(Number(data.sortOrder)) ? Number(data.sortOrder) : 0,
        isActive: data.isActive === undefined ? true : Boolean(data.isActive),
        createdBy: userId,
      },
    });

    return serializeAccount(row);
  } catch (error) {
    return rethrowDuplicate(error, "Bu nomdagi to'lov turi allaqachon mavjud");
  }
};

/**
 * To'lov turini tahrirlaydi.
 *
 * `openingBalance` HARAKAT BO'LGANDAN KEYIN o'zgarmaydi — u butun daftarni
 * qayta hisoblashga majbur qilardi. Farqni to'g'rilash uchun `adjustment`
 * yozuvi bor (`adjustBalance`).
 *
 * @param {string} id
 * @param {object} data
 * @returns {Promise<object>}
 */
const updateAccount = async (id, data) => {
  const row = await prisma.paymentAccount.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("To'lov turi topilmadi");

  const payload = {};

  if (data.name !== undefined) {
    const name = data.name?.trim();
    if (!name) throw new BadRequestError("To'lov turi nomi kiritilmagan");
    payload.name = name;
  }
  if (data.isActive !== undefined) payload.isActive = Boolean(data.isActive);
  if (data.sortOrder !== undefined) payload.sortOrder = Number(data.sortOrder) || 0;

  if (data.openingBalance !== undefined) {
    const entryCount = await prisma.accountEntry.count({ where: { accountId: id } });
    if (entryCount > 0) {
      throw new BadRequestError(
        "Harakatlar boshlangan to'lov turining boshlang'ich qoldig'ini o'zgartirib bo'lmaydi. " +
          "Farqni to'g'rilash yozuvi bilan kiriting.",
      );
    }

    const opening = parseAmount(data.openingBalance, "Boshlang'ich qoldiq");
    payload.openingBalance = opening;
    payload.balance = opening;
  }

  if (Object.keys(payload).length === 0) return serializeAccount(row);

  try {
    const updated = await prisma.paymentAccount.update({ where: { id }, data: payload });
    return serializeAccount(updated);
  } catch (error) {
    return rethrowDuplicate(error, "Bu nomdagi to'lov turi allaqachon mavjud");
  }
};

/**
 * Arxivlaydi/tiklaydi. To'lov turi HECH QACHON o'chirilmaydi — unga to'lovlar
 * va daftar qatorlari FK bilan bog'langan (Restrict).
 *
 * Qoldig'i bor turni arxivlash rad etiladi: "yopilgan turda pul qoldi"
 * hisobotni jimgina buzardi.
 *
 * @param {string} id
 * @param {boolean} isArchived
 * @returns {Promise<object>}
 */
const setAccountArchived = async (id, isArchived) => {
  const row = await prisma.paymentAccount.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("To'lov turi topilmadi");

  if (isArchived && !new Decimal(row.balance).isZero()) {
    throw new BadRequestError(
      `Bu turda ${formatAmount(row.balance)} so'm qoldiq bor. ` +
        "Avval pulni boshqa turga o'tkazing yoki to'g'rilash yozuvi kiriting.",
    );
  }

  const updated = await prisma.paymentAccount.update({
    where: { id },
    data: { isArchived, ...(isArchived ? { isActive: false } : {}) },
  });

  return serializeAccount(updated);
};

/**
 * Qo'lda to'g'rilash — smena yopilishida jismoniy pul daftar bilan mos
 * kelmasa. Sabab MAJBURIY va `logger.warn` ga tushadi: bu pulni sababsiz
 * yaratadigan/yo'q qiladigan yagona amal.
 *
 * @param {string} id
 * @param {object} data - { amount (ishorali), reason, occurredAt }
 * @param {string} userId
 * @returns {Promise<object>}
 */
const adjustBalance = async (id, data, userId) => {
  const account = await prisma.paymentAccount.findUnique({ where: { id } });
  if (!account) throw new NotFoundError("To'lov turi topilmadi");

  const amount = parseSignedAmount(data.amount, "To'g'rilash summasi");
  if (amount.isZero()) {
    throw new BadRequestError("To'g'rilash summasi nol bo'lishi mumkin emas");
  }

  const reason = data.reason?.trim();
  if (!reason) throw new BadRequestError("To'g'rilash sababi majburiy");

  const occurredAt = data.occurredAt ? new Date(data.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new BadRequestError("Sana noto'g'ri");
  }

  logger.warn(
    `[accounts] Qo'lda to'g'rilash: account=${id} (${account.name}) ` +
      `summa=${amount.toFixed(2)} actor=${userId} sabab="${reason}"`,
  );

  const entry = await prisma.$transaction(async (tx) =>
    postEntry(tx, {
      accountId: id,
      type: "adjustment",
      amount,
      occurredAt,
      note: reason,
      createdBy: userId,
    }),
  );

  const updated = await prisma.paymentAccount.findUnique({ where: { id } });

  return { entry: serializeEntry(entry), account: serializeAccount(updated) };
};

// ─────────────────────────────────────────────
// Daftar va hisobot
// ─────────────────────────────────────────────

const parseDateRange = (query) => {
  const range = {};

  if (query.from) {
    const from = new Date(query.from);
    if (Number.isNaN(from.getTime())) throw new BadRequestError("Boshlanish sanasi noto'g'ri");
    range.gte = from;
  }
  if (query.to) {
    const to = new Date(query.to);
    if (Number.isNaN(to.getTime())) throw new BadRequestError("Tugash sanasi noto'g'ri");
    to.setHours(23, 59, 59, 999);
    range.lte = to;
  }

  return Object.keys(range).length ? range : null;
};

/**
 * Bitta to'lov turining daftari.
 *
 * `seq` bo'yicha tartiblanadi, `occurredAt` bo'yicha EMAS: `balanceAfter`
 * ustuni qo'shilish tartibiga bog'liq va orqaga sanalgan to'lov ro'yxat
 * o'rtasiga tushsa, running balance ustuni ma'nosiz ko'rinardi.
 *
 * @param {string} accountId
 * @param {object} req - query: page, limit, from, to, type
 * @returns {Promise<object>}
 */
const getAccountEntries = async (accountId, req) => {
  const account = await prisma.paymentAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new NotFoundError("To'lov turi topilmadi");

  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const filter = { accountId };
  if (query.type) filter.type = query.type;

  const range = parseDateRange(query);
  if (range) filter.occurredAt = range;

  const [rows, total, income, expense] = await Promise.all([
    prisma.accountEntry.findMany({
      where: filter,
      orderBy: { seq: "desc" },
      skip,
      take: limit,
    }),
    prisma.accountEntry.count({ where: filter }),
    prisma.accountEntry.aggregate({
      where: { ...filter, amount: { gt: 0 } },
      _sum: { amount: true },
    }),
    prisma.accountEntry.aggregate({
      where: { ...filter, amount: { lt: 0 } },
      _sum: { amount: true },
    }),
  ]);

  return {
    ...formatPaginationResponse(
      rows.map((row) => serializeEntry(row, { account })),
      total,
      page,
      limit,
    ),
    account: serializeAccount(account),
    totals: {
      count: total,
      income: formatAmount(new Decimal(income._sum.amount ?? 0)),
      // Chiqim musbat son sifatida ko'rsatiladi — UI da "−" belgisi bor
      expense: formatAmount(new Decimal(expense._sum.amount ?? 0).abs()),
    },
  };
};

/**
 * Tushum hisoboti — "qaysi to'lov turiga qancha tushdi" (sana oralig'ida).
 *
 * Kassir smena yopishda naqd pulni shu bilan solishtiradi.
 *
 * @param {object} query - { from, to }
 * @returns {Promise<object>}
 */
const getAccountsReport = async (query = {}) => {
  const range = parseDateRange(query);
  const where = range ? { occurredAt: range } : {};

  const [accounts, grouped] = await Promise.all([
    prisma.paymentAccount.findMany({
      where: { isArchived: false },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.accountEntry.groupBy({
      by: ["accountId", "type"],
      where,
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const byAccount = new Map();
  for (const row of grouped) {
    if (!byAccount.has(row.accountId)) byAccount.set(row.accountId, []);
    byAccount.get(row.accountId).push(row);
  }

  let totalIncome = new Decimal(0);
  let totalExpense = new Decimal(0);
  let totalBalance = new Decimal(0);

  const items = accounts.map((account) => {
    const rows = byAccount.get(account.id) ?? [];

    let income = new Decimal(0);
    let expense = new Decimal(0);
    const breakdown = {};

    for (const row of rows) {
      const sum = new Decimal(row._sum.amount ?? 0);
      if (sum.greaterThan(0)) income = income.plus(sum);
      else expense = expense.plus(sum.abs());
      breakdown[row.type] = {
        amount: formatAmount(sum),
        count: row._count._all,
        label: ENTRY_TYPE_LABELS[row.type] ?? row.type,
      };
    }

    totalIncome = totalIncome.plus(income);
    totalExpense = totalExpense.plus(expense);
    totalBalance = totalBalance.plus(account.balance);

    return {
      ...serializeAccount(account),
      income: formatAmount(income),
      expense: formatAmount(expense),
      net: formatAmount(income.minus(expense)),
      breakdown,
    };
  });

  return {
    items,
    totals: {
      income: formatAmount(totalIncome),
      expense: formatAmount(totalExpense),
      net: formatAmount(totalIncome.minus(totalExpense)),
      balance: formatAmount(totalBalance),
    },
  };
};

module.exports = {
  ENTRY_TYPE_LABELS,
  serializeAccount,
  serializeEntry,
  postEntry,
  assertActiveAccount,
  getAccounts,
  getAccountById,
  createAccount,
  updateAccount,
  setAccountArchived,
  adjustBalance,
  getAccountEntries,
  getAccountsReport,
};
