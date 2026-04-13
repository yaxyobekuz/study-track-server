const LeadActivity = require("../models/leadActivity.model");
const Lead = require("../models/lead.model");
const { BadRequestError, NotFoundError } = require("../utils/errors");

/**
 * Lead bo'yicha barcha harakatlarni olish.
 * @param {string} leadId - lead ID
 * @param {object} query - { page, limit }
 * @returns {Promise<{activities: Array, pagination: object}>}
 */
async function getActivitiesByLead(leadId, query) {
  const { page = 1, limit = 30 } = query;

  const lead = await Lead.findById(leadId);
  if (!lead) {
    throw new NotFoundError("Lead topilmadi");
  }

  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  const skip = (pageNum - 1) * limitNum;

  const [total, activities] = await Promise.all([
    LeadActivity.countDocuments({ lead: leadId }),
    LeadActivity.find({ lead: leadId })
      .populate("createdBy", "firstName lastName")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum),
  ]);

  const totalPages = Math.ceil(total / limitNum);

  return {
    activities,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1,
    },
  };
}

/**
 * Yangi harakat qo'shish.
 * @param {string} leadId - lead ID
 * @param {object} data - { type, description }
 * @param {string} userId - yaratuvchi foydalanuvchi ID
 * @returns {Promise<object>}
 */
async function createActivity(leadId, data, userId) {
  const { type, description } = data;

  if (!type || !description) {
    throw new BadRequestError("Harakat turi va izoh majburiy");
  }

  const lead = await Lead.findById(leadId);
  if (!lead) {
    throw new NotFoundError("Lead topilmadi");
  }

  const activity = await LeadActivity.create({
    lead: leadId,
    type,
    description,
    createdBy: userId,
  });

  return LeadActivity.findById(activity._id).populate("createdBy", "firstName lastName");
}

module.exports = {
  getActivitiesByLead,
  createActivity,
};
