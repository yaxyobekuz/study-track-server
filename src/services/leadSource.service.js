const LeadSource = require("../models/leadSource.model");
const Lead = require("../models/lead.model");
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

  return LeadSource.find(filter).sort({ createdAt: -1 }).lean();
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

  const exists = await LeadSource.findOne({ name: name.trim() });
  if (exists) {
    throw new BadRequestError("Bu nomdagi manba allaqachon mavjud");
  }

  return LeadSource.create({ name: name.trim(), description });
}

/**
 * Lead manbani yangilash.
 * @param {string} id - manba ID
 * @param {object} data - { name, description, isActive }
 * @returns {Promise<object>}
 */
async function updateSource(id, data) {
  const source = await LeadSource.findById(id);
  if (!source) {
    throw new NotFoundError("Manba topilmadi");
  }

  const { name, description, isActive } = data;

  if (name !== undefined) {
    const duplicate = await LeadSource.findOne({ name: name.trim(), _id: { $ne: id } });
    if (duplicate) {
      throw new BadRequestError("Bu nomdagi manba allaqachon mavjud");
    }
    source.name = name.trim();
  }
  if (description !== undefined) source.description = description;
  if (isActive !== undefined) source.isActive = isActive;

  await source.save();
  return source;
}

/**
 * Lead manbani o'chirish.
 * @param {string} id - manba ID
 * @returns {Promise<void>}
 */
async function deleteSource(id) {
  const source = await LeadSource.findById(id);
  if (!source) {
    throw new NotFoundError("Manba topilmadi");
  }

  const leadsCount = await Lead.countDocuments({ source: id });
  if (leadsCount > 0) {
    throw new BadRequestError(
      `Bu manbaga ${leadsCount} ta lead biriktirilgan. Avval ularni boshqa manbaga o'tkazing`,
    );
  }

  await source.deleteOne();
}

module.exports = {
  getAllSources,
  createSource,
  updateSource,
  deleteSource,
};
