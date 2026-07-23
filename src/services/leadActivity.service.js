const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");

/**
 * createdBy — soft ref (FK emas), qo'lda yuklaymiz.
 * Berilgan aktivliklarga createdBy foydalanuvchisini { firstName, lastName } shaklida biriktiradi.
 */
async function attachCreators(activities) {
  const creatorIds = [...new Set(activities.map((a) => a.createdBy).filter(Boolean))];
  const creators = await prisma.user.findMany({
    where: { id: { in: creatorIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const creatorMap = new Map(creators.map((c) => [c.id, c]));

  return activities.map((a) => ({ ...a, createdBy: creatorMap.get(a.createdBy) || null }));
}

/**
 * Lead bo'yicha barcha harakatlarni olish.
 * @param {string} leadId - lead ID
 * @param {object} query - { page, limit }
 * @returns {Promise<{activities: Array, pagination: object}>}
 */
async function getActivitiesByLead(leadId, query) {
  const { page = 1, limit = 30 } = query;

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) {
    throw new NotFoundError("Lead topilmadi");
  }

  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  const skip = (pageNum - 1) * limitNum;

  const [total, rawActivities] = await Promise.all([
    prisma.leadActivity.count({ where: { leadId } }),
    prisma.leadActivity.findMany({
      where: { leadId },
      orderBy: { createdAt: "desc" },
      skip,
      take: limitNum,
    }),
  ]);

  const activities = await attachCreators(rawActivities);

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

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) {
    throw new NotFoundError("Lead topilmadi");
  }

  const activity = await prisma.leadActivity.create({
    data: {
      leadId,
      type,
      description,
      createdBy: userId,
    },
  });

  const [withCreator] = await attachCreators([activity]);
  return withCreator;
}

module.exports = {
  getActivitiesByLead,
  createActivity,
};
