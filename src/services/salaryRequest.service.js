/**
 * OYLIK SO'ROVLARI — o'qituvchi/xodim o'z oyligini ko'rib chiqishni so'raydi.
 *
 * Request→review naqshi `attendance.service.js` dagi ExcuseRequest bilan bir
 * xil (ReviewStatus + reviewedBy + rejectionReason + attachments).
 *
 * ⚠️ Tasdiq oylikni AVTOMAT o'zgartirmaydi: `StaffSalary` doktrinasi bo'yicha
 * oylikni admin qo'lda belgilaydi (yangi davr ochib). Bu service faqat
 * SO'ROVni va uning ko'rib chiqilishini qayd etadi — sof additive.
 */

const prisma = require("../config/prisma");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");
const { parseAmount, formatAmount } = require("../helpers/money.helpers");
const { parseMonthKey, formatMonthKey } = require("../helpers/month.helpers");
const { formatDateTimeUz } = require("../helpers/date.helpers");
const { uploadAttachments, deleteAttachments } = require("./file.service");

const TYPES = ["raise", "bonus", "other"];
const STATUSES = ["pending", "approved", "rejected"];

const fullName = (u) =>
  u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || "—" : "—";

// ── Serializatsiya ──────────────────────────
const serialize = (row, { staff, reviewer } = {}) => ({
  id: row.id,
  staffId: row.staffId,
  staffName: fullName(staff),
  type: row.type,
  status: row.status,
  reason: row.reason ?? "",

  proposedAmount: row.proposedAmount != null ? formatAmount(row.proposedAmount) : null,
  proposedHourlyRate:
    row.proposedHourlyRate != null ? formatAmount(row.proposedHourlyRate) : null,
  proposedStartMonth: row.proposedStartMonth ?? null,
  proposedStartMonthLabel: row.proposedStartMonth
    ? formatMonthKey(row.proposedStartMonth)
    : null,

  attachments: Array.isArray(row.attachments) ? row.attachments : [],

  reviewedBy: row.reviewedBy ?? null,
  reviewerName: reviewer ? fullName(reviewer) : null,
  reviewedAt: row.reviewedAt ?? null,
  reviewedAtLabel: row.reviewedAt ? formatDateTimeUz(row.reviewedAt) : null,
  rejectionReason: row.rejectionReason ?? null,

  createdAt: row.createdAt,
  createdAtLabel: formatDateTimeUz(row.createdAt),
});

/** So'rovlarni bog'liq (staff, reviewer) ma'lumot bilan boyitadi. */
const attachRefs = async (rows) => {
  if (rows.length === 0) return [];
  const ids = new Set();
  for (const r of rows) {
    ids.add(r.staffId);
    if (r.reviewedBy) ids.add(r.reviewedBy);
  }
  const users = await prisma.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, firstName: true, lastName: true },
  });
  const map = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) =>
    serialize(r, {
      staff: map.get(r.staffId),
      reviewer: r.reviewedBy ? map.get(r.reviewedBy) : null,
    }),
  );
};

// ─────────────────────────────────────────────
// XODIM TOMONI (teacher/staff panel)
// ─────────────────────────────────────────────

/**
 * Yangi so'rov yaratadi (pending). Fayllar Spaces'ga yuklanadi.
 * @param {string} staffId
 * @param {object} data  — { type, reason, proposedAmount, proposedHourlyRate, proposedStartMonth }
 * @param {Array} files  — Multer fayl massivi (ixtiyoriy)
 */
const submitRequest = async (staffId, data, files = []) => {
  const staff = await prisma.user.findUnique({
    where: { id: staffId },
    select: { id: true, role: true },
  });
  if (!staff) throw new NotFoundError("Xodim topilmadi");
  if (staff.role === "student") {
    throw new BadRequestError("O'quvchi oylik so'rovi yubora olmaydi");
  }

  const type = TYPES.includes(data.type) ? data.type : "raise";

  const payload = {
    staffId,
    type,
    status: "pending",
    reason: data.reason ? String(data.reason).trim() : null,
  };

  // Ixtiyoriy takliflar
  if (data.proposedAmount != null && String(data.proposedAmount).trim() !== "") {
    payload.proposedAmount = parseAmount(data.proposedAmount, "Taklif summasi");
  }
  if (
    data.proposedHourlyRate != null &&
    String(data.proposedHourlyRate).trim() !== ""
  ) {
    payload.proposedHourlyRate = parseAmount(
      data.proposedHourlyRate,
      "Taklif stavkasi",
    );
  }
  if (
    data.proposedStartMonth != null &&
    String(data.proposedStartMonth).trim() !== ""
  ) {
    payload.proposedStartMonth = parseMonthKey(
      data.proposedStartMonth,
      "Boshlanish oyi",
    );
  }

  const attachments = await uploadAttachments(files);
  payload.attachments = attachments;

  try {
    const row = await prisma.salaryRequest.create({ data: payload });
    const [result] = await attachRefs([row]);
    return result;
  } catch (error) {
    await deleteAttachments(attachments);
    throw error;
  }
};

/** Xodimning o'z so'rovlari (eng yangisi birinchi). */
const getMyRequests = async (staffId, query = {}) => {
  const where = { staffId };
  if (query.status && STATUSES.includes(query.status)) where.status = query.status;
  const rows = await prisma.salaryRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
  return attachRefs(rows);
};

/** Xodim o'z pending so'rovini bekor qiladi (o'chiradi). */
const cancelRequest = async (id, staffId) => {
  const row = await prisma.salaryRequest.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("So'rov topilmadi");
  if (row.staffId !== staffId) throw new ForbiddenError("Bu so'rov sizga tegishli emas");
  if (row.status !== "pending") {
    throw new BadRequestError("Ko'rib chiqilgan so'rovni bekor qilib bo'lmaydi");
  }
  await deleteAttachments(Array.isArray(row.attachments) ? row.attachments : []);
  await prisma.salaryRequest.delete({ where: { id } });
  return { message: "So'rov bekor qilindi" };
};

// ─────────────────────────────────────────────
// ADMIN TOMONI
// ─────────────────────────────────────────────

/** Barcha so'rovlar (filtr: status, type, staffId) + pagination. */
const getAllRequests = async (query = {}) => {
  const where = {};
  if (query.status && STATUSES.includes(query.status)) where.status = query.status;
  if (query.type && TYPES.includes(query.type)) where.type = query.type;
  if (query.staffId) where.staffId = query.staffId;

  const page = parseInt(query.page, 10) || 1;
  const limit = Math.min(parseInt(query.limit, 10) || 20, 100);
  const skip = (page - 1) * limit;

  const [rows, total, pendingCount] = await Promise.all([
    prisma.salaryRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.salaryRequest.count({ where }),
    prisma.salaryRequest.count({ where: { status: "pending" } }),
  ]);

  const data = await attachRefs(rows);
  return {
    data,
    pendingCount,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPrevPage: page > 1,
    },
  };
};

/**
 * So'rovni tasdiqlaydi yoki rad etadi.
 * ⚠️ Oylikni O'ZGARTIRMAYDI — faqat holatni qayd etadi. Admin tasdiqlangan
 * so'rov asosida StaffSalary'ni o'zi belgilaydi.
 * @param {string} id
 * @param {{ status: 'approved'|'rejected', rejectionReason?: string }} decision
 * @param {string} reviewerId
 */
const reviewRequest = async (id, decision, reviewerId) => {
  const status = decision.status;
  if (!["approved", "rejected"].includes(status)) {
    throw new BadRequestError("Holat 'approved' yoki 'rejected' bo'lishi kerak");
  }

  const row = await prisma.salaryRequest.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("So'rov topilmadi");
  if (row.status !== "pending") {
    throw new BadRequestError("So'rov allaqachon ko'rib chiqilgan");
  }

  const updated = await prisma.salaryRequest.update({
    where: { id },
    data: {
      status,
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
      rejectionReason:
        status === "rejected" && decision.rejectionReason
          ? String(decision.rejectionReason).trim()
          : null,
    },
  });
  const [result] = await attachRefs([updated]);
  return result;
};

module.exports = {
  TYPES,
  submitRequest,
  getMyRequests,
  cancelRequest,
  getAllRequests,
  reviewRequest,
};
