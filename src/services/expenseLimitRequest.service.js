/**
 * XARAJAT LIMITI OSHIRISH SO'ROVI.
 *
 * Xodim kategoriya limitidan oshmoqchi bo'lsa (xarajat rad etilgan), bu yerda
 * yangi limit so'rab so'rov yuboradi. Admin ko'radi va tasdiqlasa limit
 * yangi qiymatga OSHADI (ExpenseBudget upsert). PayrollRequest naqshi.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { parseAmount, formatAmount, Decimal } = require("../helpers/money.helpers");
const {
  parseMonthKey,
  currentMonthKey,
  formatMonthKey,
  monthInstantRange,
} = require("../helpers/month.helpers");
const { formatDateTimeUz } = require("../helpers/date.helpers");
const logger = require("../utils/logger");

const fullName = (u) => (u ? `${u.firstName} ${u.lastName ?? ""}`.trim() : null);

const serialize = (row, { category, requester, reviewer } = {}) => ({
  id: row.id,
  month: row.month,
  monthLabel: formatMonthKey(row.month),
  categoryId: row.categoryId,
  categoryName: category?.name ?? null,
  requestedLimit: formatAmount(row.requestedLimit),
  currentLimit: formatAmount(row.currentLimit),
  spentAtRequest: formatAmount(row.spentAtRequest),
  reason: row.reason ?? "",
  status: row.status,
  requestedBy: row.requestedBy,
  requesterName: fullName(requester),
  reviewedBy: row.reviewedBy ?? null,
  reviewerName: fullName(reviewer),
  reviewedAt: row.reviewedAt ?? null,
  reviewedAtLabel: row.reviewedAt ? formatDateTimeUz(row.reviewedAt) : null,
  rejectionReason: row.rejectionReason ?? null,
  createdAt: row.createdAt,
  createdAtLabel: formatDateTimeUz(row.createdAt),
});

/** Bir necha so'rovni bog'liq (kategoriya, so'rovchi, reviewer) bilan boyitadi. */
const attachRefs = async (rows) => {
  if (rows.length === 0) return [];
  const catIds = [...new Set(rows.map((r) => r.categoryId))];
  const userIds = [
    ...new Set(rows.flatMap((r) => [r.requestedBy, r.reviewedBy]).filter(Boolean)),
  ];
  const [cats, users] = await Promise.all([
    prisma.expenseCategory.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } }),
  ]);
  const catMap = new Map(cats.map((c) => [c.id, c]));
  const userMap = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) =>
    serialize(r, {
      category: catMap.get(r.categoryId),
      requester: userMap.get(r.requestedBy),
      reviewer: r.reviewedBy ? userMap.get(r.reviewedBy) : null,
    }),
  );
};

/** Kategoriya-oy uchun joriy limit va ishlatilganni o'qiydi. */
const readLimitState = async (month, categoryId) => {
  const { from, to } = monthInstantRange(month);
  const [budget, spentAgg] = await Promise.all([
    prisma.expenseBudget.findUnique({
      where: { month_categoryId: { month, categoryId } },
      select: { limitAmount: true },
    }),
    prisma.expense.aggregate({
      where: { categoryId, isVoided: false, occurredAt: { gte: from, lte: to } },
      _sum: { amount: true },
    }),
  ]);
  return {
    currentLimit: new Decimal(budget?.limitAmount ?? 0),
    hasLimit: Boolean(budget),
    spent: new Decimal(spentAgg._sum.amount ?? 0),
  };
};

// ─────────────────────────────────────────────
// XODIM TOMONI
// ─────────────────────────────────────────────

/**
 * Limit oshirish so'rovi yuboradi.
 * @param {object} data - { month?, categoryId, requestedLimit, reason }
 * @param {string} userId
 */
const submitRequest = async (data, userId) => {
  const month = data.month ? parseMonthKey(data.month, "Oy") : currentMonthKey();

  const category = await prisma.expenseCategory.findFirst({
    where: { id: data.categoryId, isArchived: false },
    select: { id: true, name: true },
  });
  if (!category) throw new NotFoundError("Xarajat kategoriyasi topilmadi");

  const requestedLimit = parseAmount(data.requestedLimit, "So'ralayotgan limit");
  const { currentLimit, spent } = await readLimitState(month, category.id);

  if (requestedLimit.lessThanOrEqualTo(currentLimit)) {
    throw new BadRequestError(
      `So'ralayotgan limit joriy limitdan (${formatAmount(currentLimit)} so'm) katta bo'lishi kerak`,
    );
  }

  // Bir kategoriya-oy uchun ochiq (pending) so'rov bittadan ko'p bo'lmasin
  const existing = await prisma.expenseLimitRequest.findFirst({
    where: { month, categoryId: category.id, status: "pending" },
    select: { id: true },
  });
  if (existing) {
    throw new BadRequestError(
      "Bu kategoriya uchun kutilayotgan so'rov allaqachon bor — admin ko'rib chiqishini kuting",
    );
  }

  const row = await prisma.expenseLimitRequest.create({
    data: {
      month,
      categoryId: category.id,
      requestedLimit,
      currentLimit,
      spentAtRequest: spent,
      reason: data.reason ? String(data.reason).trim() : "",
      status: "pending",
      requestedBy: userId,
    },
  });

  logger.info(
    `[limit-request] So'rov: "${category.name}" ${formatMonthKey(month)} ` +
      `${formatAmount(currentLimit)} -> ${formatAmount(requestedLimit)} so'm actor=${userId}`,
  );

  const [result] = await attachRefs([row]);
  return result;
};

/** Xodimning o'z so'rovlari. */
const getMyRequests = async (userId, query = {}) => {
  const rows = await prisma.expenseLimitRequest.findMany({
    where: { requestedBy: userId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return attachRefs(rows);
};

// ─────────────────────────────────────────────
// ADMIN TOMONI
// ─────────────────────────────────────────────

/** Barcha so'rovlar (filtr: status) + pagination. */
const getAllRequests = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { status } = req.query;

  const where = status ? { status } : {};
  const [rows, total] = await Promise.all([
    prisma.expenseLimitRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.expenseLimitRequest.count({ where }),
  ]);

  const pendingCount = await prisma.expenseLimitRequest.count({ where: { status: "pending" } });
  const items = await attachRefs(rows);
  return { ...formatPaginationResponse(items, total, page, limit), pendingCount };
};

/**
 * So'rovni ko'rib chiqadi. Tasdiqlansa — ExpenseBudget limiti so'ralgan
 * qiymatga OSHADI (yangi bo'lsa yaratiladi).
 * @param {string} id
 * @param {{status: 'approved'|'rejected', rejectionReason?: string}} decision
 * @param {string} reviewerId
 */
const reviewRequest = async (id, decision, reviewerId) => {
  const status = decision.status;
  if (!["approved", "rejected"].includes(status)) {
    throw new BadRequestError("Holat 'approved' yoki 'rejected' bo'lishi kerak");
  }

  const row = await prisma.expenseLimitRequest.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("So'rov topilmadi");
  if (row.status !== "pending") {
    throw new BadRequestError("So'rov allaqachon ko'rib chiqilgan");
  }

  const now = new Date();

  if (status === "rejected") {
    const updated = await prisma.expenseLimitRequest.update({
      where: { id },
      data: {
        status: "rejected",
        reviewedBy: reviewerId,
        reviewedAt: now,
        rejectionReason: decision.rejectionReason ? String(decision.rejectionReason).trim() : null,
      },
    });
    const [result] = await attachRefs([updated]);
    return result;
  }

  // TASDIQLASH — limit oshadi (upsert)
  const updated = await prisma.$transaction(async (tx) => {
    await tx.expenseBudget.upsert({
      where: { month_categoryId: { month: row.month, categoryId: row.categoryId } },
      create: {
        month: row.month,
        categoryId: row.categoryId,
        limitAmount: row.requestedLimit,
        note: "Limit oshirish so'rovi bilan",
        createdBy: reviewerId,
        updatedBy: reviewerId,
      },
      update: { limitAmount: row.requestedLimit, updatedBy: reviewerId },
    });

    return tx.expenseLimitRequest.update({
      where: { id },
      data: { status: "approved", reviewedBy: reviewerId, reviewedAt: now },
    });
  });

  logger.info(
    `[limit-request] TASDIQLANDI: request=${id} limit -> ${formatAmount(row.requestedLimit)} so'm ` +
      `reviewer=${reviewerId}`,
  );

  const [result] = await attachRefs([updated]);
  return result;
};

module.exports = {
  submitRequest,
  getMyRequests,
  getAllRequests,
  reviewRequest,
};
