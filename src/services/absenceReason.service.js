const AbsenceReason = require("../models/absenceReason.model");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");
const { NotFoundError } = require("../utils/errors");

// Kiruvchi ma'lumotdan xavfsiz maydonlarni ajratadi
function pickReasonFields(data = {}) {
  const fields = {};
  if (data.title !== undefined) fields.title = data.title;
  if (data.description !== undefined) fields.description = data.description || "";
  if (data.appliesToAll !== undefined) fields.appliesToAll = !!data.appliesToAll;
  if (data.roles !== undefined) {
    fields.roles = Array.isArray(data.roles)
      ? data.roles.filter((r) => typeof r === "string" && r.trim())
      : [];
  }
  // "Barchasi" tanlansa aniq rollar saqlanmaydi
  if (fields.appliesToAll) fields.roles = [];
  return fields;
}

async function createReason(data, createdBy) {
  const reason = await AbsenceReason.create({
    ...pickReasonFields(data),
    createdBy,
  });
  return reason;
}

// Boshqaruv ro'yxati (sahifalangan, faqat aktiv)
async function getReasons(req) {
  const { page, limit, skip } = getPaginationParams(req);

  const filter = { isActive: true };

  const [data, total] = await Promise.all([
    AbsenceReason.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AbsenceReason.countDocuments(filter),
  ]);

  return formatPaginationResponse(data, total, page, limit);
}

// Barcha aktiv sabablar (admin belgilash sahifasida rol bo'yicha filtrlash uchun)
async function getActiveReasons() {
  return AbsenceReason.find({ isActive: true }).sort({ title: 1 }).lean();
}

// Berilgan rolga tegishli aktiv sabablar (o'zini belgilash panellari uchun)
async function getApplicableForRole(role) {
  return AbsenceReason.find({
    isActive: true,
    $or: [{ appliesToAll: true }, { roles: role }],
  })
    .sort({ title: 1 })
    .lean();
}

async function updateReason(id, data) {
  const reason = await AbsenceReason.findByIdAndUpdate(id, pickReasonFields(data), {
    new: true,
    runValidators: true,
  });
  if (!reason) throw new NotFoundError("Sabab topilmadi");
  return reason;
}

// Yumshoq o'chirish (yozuvlar bilan bog'liqlikni saqlash uchun)
async function deleteReason(id) {
  const reason = await AbsenceReason.findByIdAndUpdate(
    id,
    { isActive: false },
    { new: true }
  );
  if (!reason) throw new NotFoundError("Sabab topilmadi");
  return reason;
}

module.exports = {
  createReason,
  getReasons,
  getActiveReasons,
  getApplicableForRole,
  updateReason,
  deleteReason,
};
