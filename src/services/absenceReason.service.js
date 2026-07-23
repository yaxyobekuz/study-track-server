const prisma = require("../config/prisma");
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
  const reason = await prisma.absenceReason.create({
    data: {
      ...pickReasonFields(data),
      createdBy,
    },
  });
  return reason;
}

// Boshqaruv ro'yxati (sahifalangan, faqat aktiv)
async function getReasons(req) {
  const { page, limit, skip } = getPaginationParams(req);

  const filter = { isActive: true };

  const [data, total] = await Promise.all([
    prisma.absenceReason.findMany({
      where: filter,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.absenceReason.count({ where: filter }),
  ]);

  return formatPaginationResponse(data, total, page, limit);
}

// Barcha aktiv sabablar (admin belgilash sahifasida rol bo'yicha filtrlash uchun)
async function getActiveReasons() {
  return prisma.absenceReason.findMany({
    where: { isActive: true },
    orderBy: { title: "asc" },
  });
}

// Berilgan rolga tegishli aktiv sabablar (o'zini belgilash panellari uchun)
async function getApplicableForRole(role) {
  return prisma.absenceReason.findMany({
    where: {
      isActive: true,
      OR: [{ appliesToAll: true }, { roles: { has: role } }],
    },
    orderBy: { title: "asc" },
  });
}

async function updateReason(id, data) {
  const existing = await prisma.absenceReason.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Sabab topilmadi");

  const reason = await prisma.absenceReason.update({
    where: { id },
    data: pickReasonFields(data),
  });
  return reason;
}

// Yumshoq o'chirish (yozuvlar bilan bog'liqlikni saqlash uchun)
async function deleteReason(id) {
  const existing = await prisma.absenceReason.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Sabab topilmadi");

  const reason = await prisma.absenceReason.update({
    where: { id },
    data: { isActive: false },
  });
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
