const LeadDirection = require("../models/leadDirection.model");
const Lead = require("../models/lead.model");
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

  return LeadDirection.find(filter).sort({ createdAt: -1 }).lean();
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

  const exists = await LeadDirection.findOne({ name: name.trim() });
  if (exists) {
    throw new BadRequestError("Bu nomdagi yo'nalish allaqachon mavjud");
  }

  return LeadDirection.create({ name: name.trim(), description });
}

/**
 * Lead yo'nalishni yangilash.
 * @param {string} id - yo'nalish ID
 * @param {object} data - { name, description, isActive }
 * @returns {Promise<object>}
 */
async function updateDirection(id, data) {
  const direction = await LeadDirection.findById(id);
  if (!direction) {
    throw new NotFoundError("Yo'nalish topilmadi");
  }

  const { name, description, isActive } = data;

  if (name !== undefined) {
    const duplicate = await LeadDirection.findOne({ name: name.trim(), _id: { $ne: id } });
    if (duplicate) {
      throw new BadRequestError("Bu nomdagi yo'nalish allaqachon mavjud");
    }
    direction.name = name.trim();
  }
  if (description !== undefined) direction.description = description;
  if (isActive !== undefined) direction.isActive = isActive;

  await direction.save();
  return direction;
}

/**
 * Lead yo'nalishni o'chirish.
 * @param {string} id - yo'nalish ID
 * @returns {Promise<void>}
 */
async function deleteDirection(id) {
  const direction = await LeadDirection.findById(id);
  if (!direction) {
    throw new NotFoundError("Yo'nalish topilmadi");
  }

  const leadsCount = await Lead.countDocuments({ direction: id });
  if (leadsCount > 0) {
    throw new BadRequestError(
      `Bu yo'nalishga ${leadsCount} ta lead biriktirilgan. Avval ularni boshqa yo'nalishga o'tkazing`,
    );
  }

  await direction.deleteOne();
}

module.exports = {
  getAllDirections,
  createDirection,
  updateDirection,
  deleteDirection,
};
