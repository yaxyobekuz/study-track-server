const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");

/**
 * Barcha lead toifalarini olish.
 * @param {object} query - { active }
 * @returns {Promise<Array>}
 */
async function getAllCategories(query = {}) {
  const filter = {};
  if (query.active !== undefined) {
    filter.isActive = query.active === "true";
  }

  return prisma.leadCategory.findMany({
    where: filter,
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Yangi lead toifa yaratish.
 * @param {object} data - { name, description }
 * @returns {Promise<object>}
 */
async function createCategory(data) {
  const { name, description } = data;

  if (!name || !name.trim()) {
    throw new BadRequestError("Toifa nomi majburiy");
  }

  const exists = await prisma.leadCategory.findFirst({ where: { name: name.trim() } });
  if (exists) {
    throw new BadRequestError("Bu nomdagi toifa allaqachon mavjud");
  }

  return prisma.leadCategory.create({ data: { name: name.trim(), description } });
}

/**
 * Lead toifani yangilash.
 * @param {string} id - toifa ID
 * @param {object} data - { name, description, isActive }
 * @returns {Promise<object>}
 */
async function updateCategory(id, data) {
  const category = await prisma.leadCategory.findUnique({ where: { id } });
  if (!category) {
    throw new NotFoundError("Toifa topilmadi");
  }

  const { name, description, isActive } = data;

  const update = {};

  if (name !== undefined) {
    const duplicate = await prisma.leadCategory.findFirst({
      where: { name: name.trim(), id: { not: id } },
    });
    if (duplicate) {
      throw new BadRequestError("Bu nomdagi toifa allaqachon mavjud");
    }
    update.name = name.trim();
  }
  if (description !== undefined) update.description = description;
  if (isActive !== undefined) update.isActive = isActive;

  return prisma.leadCategory.update({ where: { id }, data: update });
}

/**
 * Lead toifani o'chirish.
 * @param {string} id - toifa ID
 * @returns {Promise<void>}
 */
async function deleteCategory(id) {
  const category = await prisma.leadCategory.findUnique({ where: { id } });
  if (!category) {
    throw new NotFoundError("Toifa topilmadi");
  }

  const leadsCount = await prisma.lead.count({ where: { category: id } });
  if (leadsCount > 0) {
    throw new BadRequestError(
      `Bu toifaga ${leadsCount} ta lead biriktirilgan. Avval ularni boshqa toifaga o'tkazing`,
    );
  }

  await prisma.leadCategory.delete({ where: { id } });
}

module.exports = {
  getAllCategories,
  createCategory,
  updateCategory,
  deleteCategory,
};
