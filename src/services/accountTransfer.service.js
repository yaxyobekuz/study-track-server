/**
 * To'lov turlari orasida pul o'tkazish — inkassatsiya (naqd puldan bankka),
 * Click hamyonidan hisob-raqamga va h.k.
 *
 * O'tkazma — HUJJAT, postinglari esa ikkita `AccountEntry`. Bu `Payment` →
 * `PaymentAllocation` bilan bir xil munosabat va u to'rtta narsani beradi:
 * juftlik buzilmasligi kafolati, komissiya uchun joy, bekor qilishning
 * bitta amal bo'lishi va "o'tkazmalar ro'yxati" ning oddiy so'rovga aylanishi.
 *
 * KOMISSIYA: manbadan `amount` chiqadi, manzilga `amount − fee` tushadi.
 * Farq — bank ushlab qolgan pul. Ikki simmetrik posting bilan buni
 * ifodalab bo'lmasdi.
 *
 * ⚠️ DEADLOCK. transfer(A→B) va transfer(B→A) bir vaqtda kelsa, har biri
 * o'z manbasini lock qilib, ikkinchisining manzilini kutardi. Shuning uchun
 * to'lov turlari HAR DOIM `id` bo'yicha O'SISH tartibida lock qilinadi —
 * yo'nalishdan qat'i nazar.
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const logger = require("../utils/logger");
const { Decimal, parseAmount, formatAmount } = require("../helpers/money.helpers");
const { postEntry, serializeAccount } = require("./paymentAccount.service");

const serializeTransfer = (row) => ({
  ...row,
  amount: formatAmount(row.amount),
  fee: formatAmount(row.fee),
  receivedAmount: formatAmount(new Decimal(row.amount).minus(row.fee)),
  fromAccount: row.fromAccount ? serializeAccount(row.fromAccount) : null,
  toAccount: row.toAccount ? serializeAccount(row.toAccount) : null,
});

const assertAccount = async (id, label) => {
  if (!id) throw new BadRequestError(`${label} tanlanmagan`);

  const account = await prisma.paymentAccount.findUnique({ where: { id } });
  if (!account) throw new NotFoundError(`${label} topilmadi`);
  if (account.isArchived) throw new BadRequestError(`"${account.name}" arxivlangan`);

  return account;
};

/**
 * Ikki to'lov turi ustidagi amallarni `id` bo'yicha o'sish tartibida bajaradi.
 * Deadlock'ning oldini oladigan yagona qoida — shu funksiya.
 *
 * @param {Array<{accountId: string, run: () => Promise<any>}>} operations
 */
const inLockOrder = async (operations) => {
  const sorted = [...operations].sort((a, b) => a.accountId.localeCompare(b.accountId));
  for (const operation of sorted) {
    await operation.run();
  }
};

/**
 * O'tkazmalar ro'yxati.
 * @param {object} req - query: page, limit, accountId, from, to, includeVoided
 * @returns {Promise<object>}
 */
const getTransfers = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const filter = {};
  if (query.includeVoided !== "true") filter.isVoided = false;
  if (query.accountId) {
    filter.OR = [{ fromAccountId: query.accountId }, { toAccountId: query.accountId }];
  }

  if (query.from || query.to) {
    filter.occurredAt = {};
    if (query.from) {
      const from = new Date(query.from);
      if (Number.isNaN(from.getTime())) throw new BadRequestError("Boshlanish sanasi noto'g'ri");
      filter.occurredAt.gte = from;
    }
    if (query.to) {
      const to = new Date(query.to);
      if (Number.isNaN(to.getTime())) throw new BadRequestError("Tugash sanasi noto'g'ri");
      to.setHours(23, 59, 59, 999);
      filter.occurredAt.lte = to;
    }
  }

  const [rows, total, agg] = await Promise.all([
    prisma.accountTransfer.findMany({
      where: filter,
      orderBy: { occurredAt: "desc" },
      skip,
      take: limit,
      include: { fromAccount: true, toAccount: true },
    }),
    prisma.accountTransfer.count({ where: filter }),
    prisma.accountTransfer.aggregate({ where: filter, _sum: { amount: true, fee: true } }),
  ]);

  return {
    ...formatPaginationResponse(rows.map(serializeTransfer), total, page, limit),
    totals: {
      count: total,
      totalAmount: formatAmount(new Decimal(agg._sum.amount ?? 0)),
      totalFee: formatAmount(new Decimal(agg._sum.fee ?? 0)),
    },
  };
};

/**
 * Pul o'tkazadi.
 *
 * @param {object} data - { fromAccountId, toAccountId, amount, fee, occurredAt, note }
 * @param {string} userId
 * @returns {Promise<object>}
 */
const createTransfer = async (data, userId) => {
  if (data.fromAccountId === data.toAccountId) {
    throw new BadRequestError("Bitta turning o'ziga o'tkazma qilib bo'lmaydi");
  }

  const amount = parseAmount(data.amount, "O'tkazma summasi");
  if (amount.lessThanOrEqualTo(0)) {
    throw new BadRequestError("O'tkazma summasi noldan katta bo'lishi kerak");
  }

  const fee = data.fee ? parseAmount(data.fee, "Komissiya") : new Decimal(0);
  if (fee.greaterThanOrEqualTo(amount)) {
    throw new BadRequestError("Komissiya o'tkazma summasidan kichik bo'lishi kerak");
  }

  const [from, to] = await Promise.all([
    assertAccount(data.fromAccountId, "Manba to'lov turi"),
    assertAccount(data.toAccountId, "Manzil to'lov turi"),
  ]);

  const occurredAt = data.occurredAt ? new Date(data.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw new BadRequestError("Sana noto'g'ri");

  const received = amount.minus(fee);

  const transfer = await prisma.$transaction(async (tx) => {
    const created = await tx.accountTransfer.create({
      data: {
        fromAccountId: from.id,
        toAccountId: to.id,
        amount,
        fee,
        occurredAt,
        note: data.note?.trim() || "",
        createdBy: userId,
      },
    });

    // Qoldiq tekshiruvi lock ostida: chiqim qilinadigan turda pul
    // yetarlimi. Lock'dan oldin o'qilgan qiymat ishonchsiz.
    await inLockOrder([
      {
        accountId: from.id,
        run: async () => {
          const fresh = await tx.paymentAccount.findUnique({ where: { id: from.id } });
          if (new Decimal(fresh.balance).lessThan(amount)) {
            throw new BadRequestError(
              `"${from.name}" turida ${formatAmount(fresh.balance)} so'm bor — ` +
                `${formatAmount(amount)} so'm o'tkazib bo'lmaydi`,
            );
          }

          await postEntry(tx, {
            accountId: from.id,
            type: "transfer_out",
            amount: amount.negated(),
            occurredAt,
            transferId: created.id,
            note: data.note?.trim() || `→ ${to.name}`,
            createdBy: userId,
          });
        },
      },
      {
        accountId: to.id,
        run: () =>
          postEntry(tx, {
            accountId: to.id,
            type: "transfer_in",
            amount: received,
            occurredAt,
            transferId: created.id,
            note: data.note?.trim() || `← ${from.name}`,
            createdBy: userId,
          }),
      },
    ]);

    return created;
  });

  const fresh = await prisma.accountTransfer.findUnique({
    where: { id: transfer.id },
    include: { fromAccount: true, toAccount: true },
  });

  return serializeTransfer(fresh);
};

/**
 * O'tkazmani bekor qiladi — KOMPENSATSIYA yozuvlari bilan.
 *
 * Daftar qat'iy append-only, shuning uchun eski qatorlar o'chirilmaydi:
 * teskari yo'nalishdagi ikkita yangi qator yoziladi. Ularning
 * `occurredAt` i — HOZIR, chunki pul bugun qaytdi.
 *
 * @param {string} id
 * @param {string} reason
 * @param {string} userId
 * @returns {Promise<object>}
 */
const voidTransfer = async (id, reason, userId) => {
  const transfer = await prisma.accountTransfer.findUnique({
    where: { id },
    include: { fromAccount: true, toAccount: true },
  });
  if (!transfer) throw new NotFoundError("O'tkazma topilmadi");
  if (transfer.isVoided) throw new BadRequestError("O'tkazma allaqachon bekor qilingan");

  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError("Bekor qilish sababi majburiy");

  const amount = new Decimal(transfer.amount);
  const received = amount.minus(transfer.fee);
  const occurredAt = new Date();

  logger.warn(
    `[accounts] O'tkazma bekor qilindi: transfer=${id} ` +
      `${transfer.fromAccount.name} → ${transfer.toAccount.name} ` +
      `summa=${amount.toFixed(2)} actor=${userId} sabab="${trimmed}"`,
  );

  await prisma.$transaction(async (tx) => {
    await tx.accountTransfer.update({
      where: { id },
      data: {
        isVoided: true,
        voidedAt: occurredAt,
        voidedBy: userId,
        voidReason: trimmed,
      },
    });

    await inLockOrder([
      {
        accountId: transfer.toAccountId,
        run: async () => {
          const fresh = await tx.paymentAccount.findUnique({
            where: { id: transfer.toAccountId },
          });
          if (new Decimal(fresh.balance).lessThan(received)) {
            throw new BadRequestError(
              `"${transfer.toAccount.name}" turida ${formatAmount(fresh.balance)} so'm bor — ` +
                "o'tkazmani qaytarish uchun yetarli emas",
            );
          }

          await postEntry(tx, {
            accountId: transfer.toAccountId,
            type: "transfer_out",
            amount: received.negated(),
            occurredAt,
            transferId: id,
            note: `Bekor qilindi: ${trimmed}`,
            createdBy: userId,
          });
        },
      },
      {
        accountId: transfer.fromAccountId,
        run: () =>
          postEntry(tx, {
            accountId: transfer.fromAccountId,
            type: "transfer_in",
            amount,
            occurredAt,
            transferId: id,
            note: `Bekor qilindi: ${trimmed}`,
            createdBy: userId,
          }),
      },
    ]);
  });

  return { message: "O'tkazma bekor qilindi" };
};

module.exports = {
  serializeTransfer,
  getTransfers,
  createTransfer,
  voidTransfer,
};
