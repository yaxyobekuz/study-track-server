/**
 * To'lovlarni qayd etish.
 *
 * `paidAmount` va `status` HAR DOIM bitta tranzaksiya ichida yangilanadi:
 * `increment` bilan yozib, keyin yangilangan qiymatdan status hisoblanadi.
 * Birinchi `update` olgan qator lock'i parallel to'lovlarni ketma-ketlashtiradi,
 * shuning uchun ikkita kassir bir vaqtda to'lov kiritsa ham pul yo'qolmaydi.
 *
 * To'lov — APPEND-ONLY log: summa va sana o'zgarmas. Xato yozuv `isVoided`
 * bilan bekor qilinadi, hech qachon o'chirilmaydi.
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const logger = require("../utils/logger");
const { Decimal, parseAmount, formatAmount } = require("../helpers/money.helpers");
const { serializePayment, METHOD_LABELS } = require("./invoice.service");

const METHODS = ["cash", "card", "transfer", "other"];

const STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
};

const parseMethod = (value) => {
  const method = String(value || "cash").trim();
  if (!METHODS.includes(method)) {
    throw new BadRequestError(
      `To'lov usuli noto'g'ri. Mumkin: ${METHODS.map((m) => METHOD_LABELS[m]).join(", ")}`,
    );
  }
  return method;
};

const parsePaidAt = (value) => {
  if (value == null || value === "") return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError("To'lov sanasi noto'g'ri");
  }
  return date;
};

/**
 * Status — `paidAmount` dan KELIB CHIQADI, hech qachon qo'lda qo'yilmaydi.
 * Yagona manba shu funksiya.
 */
const deriveStatus = (amount, paidAmount) => {
  if (paidAmount.lessThanOrEqualTo(0)) return "unpaid";
  if (paidAmount.greaterThanOrEqualTo(amount)) return "paid";
  return "partial";
};

/**
 * To'lov qabul qiladi.
 *
 * @param {string} invoiceId
 * @param {object} data - { amount, paidAt, method, note }
 * @param {string} userId
 * @returns {Promise<{payment: object, invoice: object}>}
 */
const createPayment = async (invoiceId, data, userId) => {
  const invoice = await prisma.monthlyInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new NotFoundError("Hisob-faktura topilmadi");

  if (invoice.status === "cancelled") {
    throw new BadRequestError(
      "Bekor qilingan hisob-fakturaga to'lov qabul qilib bo'lmaydi",
    );
  }

  const amount = parseAmount(data.amount, "To'lov summasi");
  if (amount.lessThanOrEqualTo(0)) {
    throw new BadRequestError("To'lov summasi noldan katta bo'lishi kerak");
  }

  const method = parseMethod(data.method);
  const paidAt = parsePaidAt(data.paidAt);

  const remaining = new Decimal(invoice.amount).minus(invoice.paidAmount);
  if (amount.greaterThan(remaining)) {
    throw new BadRequestError(
      `To'lov qoldiqdan oshib ketdi. Qolgan summa: ${formatAmount(remaining)}`,
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.invoicePayment.create({
      data: {
        invoiceId,
        studentId: invoice.studentId,
        amount,
        paidAt,
        method,
        note: data.note?.trim() || "",
        createdBy: userId,
      },
    });

    // increment — qator lock'i ostida; qiymat hech qachon yo'qolmaydi
    const updated = await tx.monthlyInvoice.update({
      where: { id: invoiceId },
      data: { paidAmount: { increment: amount } },
    });

    const status = deriveStatus(
      new Decimal(updated.amount),
      new Decimal(updated.paidAmount),
    );

    const final = await tx.monthlyInvoice.update({
      where: { id: invoiceId },
      data: {
        status,
        paidAt: status === "paid" ? (updated.paidAt ?? new Date()) : null,
      },
    });

    return { payment, invoice: final };
  });

  return {
    payment: serializePayment(result.payment),
    invoice: {
      id: result.invoice.id,
      amount: formatAmount(result.invoice.amount),
      paidAmount: formatAmount(result.invoice.paidAmount),
      debt: formatAmount(
        new Decimal(result.invoice.amount).minus(result.invoice.paidAmount),
      ),
      status: result.invoice.status,
      paidAt: result.invoice.paidAt,
    },
  };
};

/**
 * To'lovni bekor qiladi (soft void) va hisob-faktura holatini qayta hisoblaydi.
 * Yozuv DB'dan hech qachon chiqmaydi — moliyaviy log yo'qolmasligi kerak.
 *
 * @param {string} id
 * @param {string} reason
 * @param {string} userId
 * @returns {Promise<{payment: object, invoice: object}>}
 */
const voidPayment = async (id, reason, userId) => {
  const payment = await prisma.invoicePayment.findUnique({ where: { id } });
  if (!payment) throw new NotFoundError("To'lov topilmadi");

  if (payment.isVoided) throw new BadRequestError("To'lov allaqachon bekor qilingan");

  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError("Bekor qilish sababi majburiy");

  logger.warn(
    `[payments] To'lov bekor qilindi: payment=${id} invoice=${payment.invoiceId} ` +
      `student=${payment.studentId} summa=${payment.amount.toFixed(2)} ` +
      `actor=${userId} sabab="${trimmed}"`,
  );

  const result = await prisma.$transaction(async (tx) => {
    const voided = await tx.invoicePayment.update({
      where: { id },
      data: {
        isVoided: true,
        voidedAt: new Date(),
        voidedBy: userId,
        voidReason: trimmed,
      },
    });

    const updated = await tx.monthlyInvoice.update({
      where: { id: payment.invoiceId },
      data: { paidAmount: { decrement: payment.amount } },
    });

    // Bekor qilingan hisob-faktura holati o'zgarmaydi — u alohida qaror
    if (updated.status === "cancelled") return { payment: voided, invoice: updated };

    const status = deriveStatus(
      new Decimal(updated.amount),
      new Decimal(updated.paidAmount),
    );

    const final = await tx.monthlyInvoice.update({
      where: { id: payment.invoiceId },
      data: { status, paidAt: status === "paid" ? updated.paidAt : null },
    });

    return { payment: voided, invoice: final };
  });

  return {
    payment: serializePayment(result.payment),
    invoice: {
      id: result.invoice.id,
      amount: formatAmount(result.invoice.amount),
      paidAmount: formatAmount(result.invoice.paidAmount),
      status: result.invoice.status,
    },
  };
};

/**
 * To'lov izohini yangilaydi — o'zgartirish mumkin bo'lgan yagona maydon.
 * @param {string} id
 * @param {string} note
 * @returns {Promise<object>}
 */
const updatePaymentNote = async (id, note) => {
  const payment = await prisma.invoicePayment.findUnique({ where: { id } });
  if (!payment) throw new NotFoundError("To'lov topilmadi");

  const updated = await prisma.invoicePayment.update({
    where: { id },
    data: { note: note?.trim() || "" },
  });

  return serializePayment(updated);
};

/**
 * To'lovlar registri — kassaning kunlik/oylik hisoboti.
 *
 * @param {object} req - query: page, limit, studentId, invoiceId, from, to, method, includeVoided
 * @returns {Promise<object>}
 */
const getPayments = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const filter = {};
  if (query.studentId) filter.studentId = query.studentId;
  if (query.invoiceId) filter.invoiceId = query.invoiceId;
  if (query.method) filter.method = parseMethod(query.method);
  if (query.includeVoided !== "true") filter.isVoided = false;

  if (query.from || query.to) {
    filter.paidAt = {};
    if (query.from) {
      const from = new Date(query.from);
      if (Number.isNaN(from.getTime())) throw new BadRequestError("Boshlanish sanasi noto'g'ri");
      filter.paidAt.gte = from;
    }
    if (query.to) {
      const to = new Date(query.to);
      if (Number.isNaN(to.getTime())) throw new BadRequestError("Tugash sanasi noto'g'ri");
      to.setHours(23, 59, 59, 999);
      filter.paidAt.lte = to;
    }
  }

  const [rows, total, agg] = await Promise.all([
    prisma.invoicePayment.findMany({
      where: filter,
      orderBy: { paidAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.invoicePayment.count({ where: filter }),
    prisma.invoicePayment.aggregate({ where: filter, _sum: { amount: true } }),
  ]);

  const studentIds = [...new Set(rows.map((r) => r.studentId))];
  const students = studentIds.length
    ? await prisma.user.findMany({
        where: { id: { in: studentIds } },
        select: STUDENT_SELECT,
      })
    : [];
  const studentMap = new Map(students.map((s) => [s.id, s]));

  const items = rows.map((row) => ({
    ...serializePayment(row),
    student: studentMap.get(row.studentId) ?? null,
  }));

  return {
    ...formatPaginationResponse(items, total, page, limit),
    totals: {
      count: total,
      totalAmount: formatAmount(new Decimal(agg._sum.amount ?? 0)),
    },
  };
};

/**
 * Bitta hisob-fakturaning to'lovlari.
 * @param {string} invoiceId
 * @param {{includeVoided?: boolean}} options
 * @returns {Promise<object[]>}
 */
const getInvoicePayments = async (invoiceId, { includeVoided = false } = {}) => {
  const invoice = await prisma.monthlyInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new NotFoundError("Hisob-faktura topilmadi");

  const rows = await prisma.invoicePayment.findMany({
    where: { invoiceId, ...(includeVoided ? {} : { isVoided: false }) },
    orderBy: { paidAt: "desc" },
  });

  return rows.map(serializePayment);
};

module.exports = {
  METHODS,
  deriveStatus,
  createPayment,
  voidPayment,
  updatePaymentNote,
  getPayments,
  getInvoicePayments,
};
