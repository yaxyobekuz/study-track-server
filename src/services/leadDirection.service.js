const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");

/**
 * Barcha lead yo'nalishlarini olish.
 * @param {object} query - { active }
 * @returns {Promise<Array>}
 */
async function getAllDirections(query = {}) {
  const filter = {};
  if (query.active !== undefined) {
    filter.isActive = query.active === "true";
  }

  return prisma.leadDirection.findMany({
    where: filter,
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Yangi lead yo'nalish yaratish.
 * @param {object} data - { name, description }
 * @returns {Promise<object>}
 */
async function createDirection(data) {
  const { name, description } = data;

  if (!name || !name.trim()) {
    throw new BadRequestError("Yo'nalish nomi majburiy");
  }

  const exists = await prisma.leadDirection.findFirst({ where: { name: name.trim() } });
  if (exists) {
    throw new BadRequestError("Bu nomdagi yo'nalish allaqachon mavjud");
  }

  return prisma.leadDirection.create({ data: { name: name.trim(), description } });
}

/**
 * Lead yo'nalishni yangilash.
 * @param {string} id - yo'nalish ID
 * @param {object} data - { name, description, isActive }
 * @returns {Promise<object>}
 */
async function updateDirection(id, data) {
  const direction = await prisma.leadDirection.findUnique({ where: { id } });
  if (!direction) {
    throw new NotFoundError("Yo'nalish topilmadi");
  }

  const { name, description, isActive } = data;

  const update = {};

  if (name !== undefined) {
    const duplicate = await prisma.leadDirection.findFirst({
      where: { name: name.trim(), id: { not: id } },
    });
    if (duplicate) {
      throw new BadRequestError("Bu nomdagi yo'nalish allaqachon mavjud");
    }
    update.name = name.trim();
  }
  if (description !== undefined) update.description = description;
  if (isActive !== undefined) update.isActive = isActive;

  return prisma.leadDirection.update({ where: { id }, data: update });
}

/**
 * Lead yo'nalishni o'chirish.
 * @param {string} id - yo'nalish ID
 * @returns {Promise<void>}
 */
async function deleteDirection(id) {
  const direction = await prisma.leadDirection.findUnique({ where: { id } });
  if (!direction) {
    throw new NotFoundError("Yo'nalish topilmadi");
  }

  const leadsCount = await prisma.lead.count({ where: { direction: id } });
  if (leadsCount > 0) {
    throw new BadRequestError(
      `Bu yo'nalishga ${leadsCount} ta lead biriktirilgan. Avval ularni boshqa yo'nalishga o'tkazing`,
    );
  }

  await prisma.leadDirection.delete({ where: { id } });
}

module.exports = {
  getAllDirections,
  createDirection,
  updateDirection,
  deleteDirection,
};
