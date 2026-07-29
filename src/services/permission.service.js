const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const {
  PERMISSION_SECTIONS,
  PERMISSION_KEYS,
  expandLegacyKeys,
  normalizePermissions,
} = require("../utils/permissions");

// Ruxsat berilishi mumkin bo'lgan xodimlar: owner ham, o'quvchi ham emas
const STAFF_ROLE_FILTER = { notIn: [ROLES.OWNER, ROLES.STUDENT] };

/**
 * Grant qilinadigan ruxsatlar katalogi (admin UI checkbox'lari uchun):
 * bo'limlar, ularning guruhi va har birining amallari.
 */
function getCatalog() {
  return PERMISSION_SECTIONS;
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
 * Ruxsat kalitlarini tekshirib, saqlashga tayyor ko'rinishga keltiradi.
 *
 * Kalitlar `<bo'lim>.<amal>` ko'rinishida. Eski, amalga bo'linmagan bo'lim
 * kaliti ("users") ham qabul qilinadi — u o'sha bo'limning barcha amallariga
 * yoyiladi. Natijada har bir bo'lim uchun `.view` avtomatik qo'shiladi.
 *
 * @param {string[]} permissions - ruxsat kalitlari
 * @returns {string[]} normallashtirilgan kalitlar (katalog tartibida)
 */
function validatePermissions(permissions) {
  if (!Array.isArray(permissions)) {
    throw new BadRequestError("permissions massiv bo'lishi kerak");
  }

  // Eski bo'lim kalitlarini amallarga yoyamiz, so'ng noma'lumlarini rad etamiz
  const expanded = expandLegacyKeys(permissions);
  const invalid = expanded.filter((p) => !PERMISSION_KEYS.includes(p));
  if (invalid.length > 0) {
    throw new BadRequestError(`Noma'lum ruxsat(lar): ${invalid.join(", ")}`);
  }

  return normalizePermissions(expanded);
}

/**
 * Foydalanuvchining ruxsatlar to'plamini butunlay almashtiradi (grant/revoke).
 *
 * @param {string} userId - foydalanuvchi ID
 * @param {string[]} permissions - yangi ruxsat kalitlari to'plami
 */
async function setUserPermissions(userId, permissions) {
  const unique = validatePermissions(permissions);

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

module.exports = {
  getCatalog,
  getStaff,
  validatePermissions,
  setUserPermissions,
};
