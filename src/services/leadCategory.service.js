const LeadCategory = require("../models/leadCategory.model");
const Lead = require("../models/lead.model");
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

  return LeadCategory.find(filter).sort({ createdAt: -1 }).lean();
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

  const exists = await LeadCategory.findOne({ name: name.trim() });
  if (exists) {
    throw new BadRequestError("Bu nomdagi toifa allaqachon mavjud");
  }

  return LeadCategory.create({ name: name.trim(), description });
}

/**
 * Lead toifani yangilash.
 * @param {string} id - toifa ID
 * @param {object} data - { name, description, isActive }
 * @returns {Promise<object>}
 */
async function updateCategory(id, data) {
  const category = await LeadCategory.findById(id);
  if (!category) {
    throw new NotFoundError("Toifa topilmadi");
  }

  const { name, description, isActive } = data;

  if (name !== undefined) {
    const duplicate = await LeadCategory.findOne({ name: name.trim(), _id: { $ne: id } });
    if (duplicate) {
      throw new BadRequestError("Bu nomdagi toifa allaqachon mavjud");
    }
    category.name = name.trim();
  }
  if (description !== undefined) category.description = description;
  if (isActive !== undefined) category.isActive = isActive;

  await category.save();
  return category;
}

/**
 * Lead toifani o'chirish.
 * @param {string} id - toifa ID
 * @returns {Promise<void>}
 */
async function deleteCategory(id) {
  const category = await LeadCategory.findById(id);
  if (!category) {
    throw new NotFoundError("Toifa topilmadi");
  }

  const leadsCount = await Lead.countDocuments({ category: id });
  if (leadsCount > 0) {
    throw new BadRequestError(
      `Bu toifaga ${leadsCount} ta lead biriktirilgan. Avval ularni boshqa toifaga o'tkazing`,
    );
  }

  await category.deleteOne();
}

module.exports = {
  getAllCategories,
  createCategory,
  updateCategory,
  deleteCategory,
};
