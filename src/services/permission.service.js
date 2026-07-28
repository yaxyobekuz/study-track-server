const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const { PERMISSION_CATALOG, PERMISSION_KEYS } = require("../utils/permissions");

// Ruxsat berilishi mumkin bo'lgan xodimlar: owner ham, o'quvchi ham emas
const STAFF_ROLE_FILTER = { notIn: [ROLES.OWNER, ROLES.STUDENT] };

/**
 * Grant qilinadigan ruxsatlar katalogi (admin UI checkbox'lari uchun).
 */
function getCatalog() {
  return PERMISSION_CATALOG;
}

/**
 * Owner'dan tashqari xodimlarni joriy ruxsatlari bilan qaytaradi.
 * `select` ishlatilmaydi — `fullName` virtuali saqlanishi uchun `omit` qo'llanadi.
 */
async function getStaff() {
  return prisma.user.findMany({
    where: { role: STAFF_ROLE_FILTER, isArchived: false },
    omit: { password: true, plainPassword: true },
    orderBy: { firstName: "asc" },
  });
}

/**
 * Foydalanuvchining ruxsatlar to'plamini butunlay almashtiradi (grant/revoke).
 * @param {string} userId - foydalanuvchi ID
 * @param {string[]} permissions - yangi ruxsat kalitlari to'plami
 */
async function setUserPermissions(userId, permissions) {
  if (!Array.isArray(permissions)) {
    throw new BadRequestError("permissions massiv bo'lishi kerak");
  }

  // Noma'lum kalitlarni rad etamiz
  const unique = [...new Set(permissions)];
  const invalid = unique.filter((p) => !PERMISSION_KEYS.includes(p));
  if (invalid.length > 0) {
    throw new BadRequestError(`Noma'lum ruxsat(lar): ${invalid.join(", ")}`);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });

  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (user.role === ROLES.OWNER) {
    throw new BadRequestError("Owner allaqachon barcha ruxsatlarga ega");
  }

  if (user.role === ROLES.STUDENT) {
    throw new BadRequestError("O'quvchilarga ruxsat berib bo'lmaydi");
  }

  return prisma.user.update({
    where: { id: userId },
    data: { permissions: unique },
    omit: { password: true, plainPassword: true },
  });
}

module.exports = { getCatalog, getStaff, setUserPermissions };
