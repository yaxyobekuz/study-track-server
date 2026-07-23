const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");

/**
 * Barcha lead manbalarini olish.
 * @param {object} query - { active }
 * @returns {Promise<Array>}
 */
async function getAllSources(query = {}) {
  const filter = {};
  if (query.active !== undefined) {
    filter.isActive = query.active === "true";
  }

  return prisma.leadSource.findMany({
    where: filter,
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Yangi lead manba yaratish.
 * @param {object} data - { name, description }
 * @returns {Promise<object>}
 */
async function createSource(data) {
  const { name, description } = data;

  if (!name || !name.trim()) {
    throw new BadRequestError("Manba nomi majburiy");
  }

  const exists = await prisma.leadSource.findFirst({ where: { name: name.trim() } });
  if (exists) {
    throw new BadRequestError("Bu nomdagi manba allaqachon mavjud");
  }

  return prisma.leadSource.create({ data: { name: name.trim(), description } });
}

/**
 * Lead manbani yangilash.
 * @param {string} id - manba ID
 * @param {object} data - { name, description, isActive }
 * @returns {Promise<object>}
 */
async function updateSource(id, data) {
  const source = await prisma.leadSource.findUnique({ where: { id } });
  if (!source) {
    throw new NotFoundError("Manba topilmadi");
  }

  const { name, description, isActive } = data;

  const update = {};

  if (name !== undefined) {
    const duplicate = await prisma.leadSource.findFirst({
      where: { name: name.trim(), id: { not: id } },
    });
    if (duplicate) {
      throw new BadRequestError("Bu nomdagi manba allaqachon mavjud");
    }
    update.name = name.trim();
  }
  if (description !== undefined) update.description = description;
  if (isActive !== undefined) update.isActive = isActive;

  return prisma.leadSource.update({ where: { id }, data: update });
}

/**
 * Lead manbani o'chirish.
 * @param {string} id - manba ID
 * @returns {Promise<void>}
 */
async function deleteSource(id) {
  const source = await prisma.leadSource.findUnique({ where: { id } });
  if (!source) {
    throw new NotFoundError("Manba topilmadi");
  }

  const leadsCount = await prisma.lead.count({ where: { source: id } });
  if (leadsCount > 0) {
    throw new BadRequestError(
      `Bu manbaga ${leadsCount} ta lead biriktirilgan. Avval ularni boshqa manbaga o'tkazing`,
    );
  }

  await prisma.leadSource.delete({ where: { id } });
}

module.exports = {
  getAllSources,
  createSource,
  updateSource,
  deleteSource,
};
