const Lead = require("../models/lead.model");
const LeadSource = require("../models/leadSource.model");
const LeadDirection = require("../models/leadDirection.model");
const LeadCategory = require("../models/leadCategory.model");
const LeadActivity = require("../models/leadActivity.model");
const { BadRequestError, NotFoundError } = require("../utils/errors");

/**
 * Barcha leadlarni sahifalangan holda olish.
 * @param {object} query - { status, source, search, startDate, endDate, page, limit }
 * @returns {Promise<{leads: Array, pagination: object}>}
 */
async function getAllLeads(query) {
  const { status, source, direction, category, search, startDate, endDate, page = 1, limit = 24 } = query;

  const filter = {};
  if (status) filter.status = status;
  if (source) filter.source = source;
  if (direction) filter.direction = direction;
  if (category) filter.category = category;

  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = end;
    }
  }

  if (search && search.trim()) {
    const searchRegex = new RegExp(search.trim(), "i");
    filter.$or = [
      { firstName: searchRegex },
      { lastName: searchRegex },
      { phone: searchRegex },
      { parentName: searchRegex },
    ];
  }

  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  const skip = (pageNum - 1) * limitNum;

  const [total, leads] = await Promise.all([
    Lead.countDocuments(filter),
    Lead.find(filter)
      .populate("source", "name")
      .populate("direction", "name")
      .populate("category", "name")
      .populate("createdBy", "firstName lastName")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum),
  ]);

  const totalPages = Math.ceil(total / limitNum);

  return {
    leads,
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
 * Leadni ID bo'yicha olish.
 * @param {string} id - lead ID
 * @returns {Promise<object>}
 */
async function getLeadById(id) {
  const lead = await Lead.findById(id)
    .populate("source", "name")
    .populate("direction", "name")
    .populate("category", "name")
    .populate("createdBy", "firstName lastName");

  if (!lead) {
    throw new NotFoundError("Lead topilmadi");
  }

  const recentActivities = await LeadActivity.find({ lead: id })
    .populate("createdBy", "firstName lastName")
    .sort({ createdAt: -1 })
    .limit(20);

  return { lead, activities: recentActivities };
}

/**
 * Yangi lead yaratish.
 * @param {object} data - lead ma'lumotlari
 * @param {string} userId - yaratuvchi foydalanuvchi ID
 * @returns {Promise<object>}
 */
async function createLead(data, userId) {
  const { firstName, lastName, phone, source, direction, category, createdAt } = data;

  if (!firstName || !lastName || !phone || !source || !direction || !category) {
    throw new BadRequestError("Ism, familiya, telefon, manba, yo'nalish va toifa majburiy");
  }

  const sourceExists = await LeadSource.findById(source);
  if (!sourceExists) {
    throw new NotFoundError("Manba topilmadi");
  }

  const directionExists = await LeadDirection.findById(direction);
  if (!directionExists) {
    throw new NotFoundError("Yo'nalish topilmadi");
  }

  const categoryExists = await LeadCategory.findById(category);
  if (!categoryExists) {
    throw new NotFoundError("Toifa topilmadi");
  }

  const leadData = { ...data, createdBy: userId };
  if (createdAt) leadData.createdAt = new Date(createdAt);

  const lead = await Lead.create(leadData);

  // Auto-create first activity
  await LeadActivity.create({
    lead: lead._id,
    type: "note",
    description: "Yangi lead yaratildi",
    createdBy: userId,
  });

  return Lead.findById(lead._id)
    .populate("source", "name")
    .populate("direction", "name")
    .populate("category", "name")
    .populate("createdBy", "firstName lastName");
}

/**
 * Leadni yangilash.
 * @param {string} id - lead ID
 * @param {object} data - yangilanadigan ma'lumotlar
 * @returns {Promise<object>}
 */
async function updateLead(id, data) {
  const lead = await Lead.findById(id);
  if (!lead) {
    throw new NotFoundError("Lead topilmadi");
  }

  // Don't allow status change through this method
  delete data.status;
  delete data.createdBy;

  if (data.createdAt) data.createdAt = new Date(data.createdAt);

  if (data.source) {
    const sourceExists = await LeadSource.findById(data.source);
    if (!sourceExists) {
      throw new NotFoundError("Manba topilmadi");
    }
  }

  if (data.direction) {
    const directionExists = await LeadDirection.findById(data.direction);
    if (!directionExists) {
      throw new NotFoundError("Yo'nalish topilmadi");
    }
  }

  if (data.category) {
    const categoryExists = await LeadCategory.findById(data.category);
    if (!categoryExists) {
      throw new NotFoundError("Toifa topilmadi");
    }
  }

  Object.assign(lead, data);
  await lead.save();

  return Lead.findById(lead._id)
    .populate("source", "name")
    .populate("direction", "name")
    .populate("category", "name")
    .populate("createdBy", "firstName lastName");
}

/**
 * Lead statusini yangilash.
 * @param {string} id - lead ID
 * @param {string} status - yangi status
 * @param {string} description - izoh
 * @param {string} lostReason - rad/yo'qolish sababi
 * @param {string} userId - o'zgartiruvchi foydalanuvchi ID
 * @returns {Promise<object>}
 */
async function updateLeadStatus(id, status, description, lostReason, userId) {
  const lead = await Lead.findById(id);
  if (!lead) {
    throw new NotFoundError("Lead topilmadi");
  }

  if (!status) {
    throw new BadRequestError("Yangi status majburiy");
  }

  const { LEAD_STATUSES } = require("../models/lead.model");
  if (!LEAD_STATUSES.includes(status)) {
    throw new BadRequestError("Noto'g'ri status");
  }

  const previousStatus = lead.status;
  lead.status = status;

  if ((status === "rejected" || status === "lost") && lostReason) {
    lead.lostReason = lostReason;
  }

  await lead.save();

  // Log status change activity
  await LeadActivity.create({
    lead: lead._id,
    type: "status_change",
    description: description || `Status "${previousStatus}" dan "${status}" ga o'zgartirildi`,
    previousStatus,
    newStatus: status,
    createdBy: userId,
  });

  return Lead.findById(lead._id)
    .populate("source", "name")
    .populate("direction", "name")
    .populate("category", "name")
    .populate("createdBy", "firstName lastName");
}

/**
 * Leadni o'chirish.
 * @param {string} id - lead ID
 * @returns {Promise<void>}
 */
async function deleteLead(id) {
  const lead = await Lead.findById(id);
  if (!lead) {
    throw new NotFoundError("Lead topilmadi");
  }

  await Promise.all([lead.deleteOne(), LeadActivity.deleteMany({ lead: id })]);
}

/**
 * Lead analitikasi - umumiy ko'rinish.
 * @param {object} query - { startDate, endDate }
 * @returns {Promise<object>}
 */
async function getAnalyticsOverview(query) {
  const { startDate, endDate } = query;

  const dateFilter = {};
  if (startDate || endDate) {
    dateFilter.createdAt = {};
    if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      dateFilter.createdAt.$lte = end;
    }
  }

  const [
    totalLeads,
    newLeads,
    enrolledLeads,
    rejectedLeads,
    lostLeads,
    contactedLeads,
    interestedLeads,
    visitedLeads,
    trialLeads,
    negotiationLeads,
    postponedLeads,
  ] = await Promise.all([
    Lead.countDocuments(dateFilter),
    Lead.countDocuments({ ...dateFilter, status: "new" }),
    Lead.countDocuments({ ...dateFilter, status: "enrolled" }),
    Lead.countDocuments({ ...dateFilter, status: "rejected" }),
    Lead.countDocuments({ ...dateFilter, status: "lost" }),
    Lead.countDocuments({ ...dateFilter, status: "contacted" }),
    Lead.countDocuments({ ...dateFilter, status: "interested" }),
    Lead.countDocuments({ ...dateFilter, status: "visited" }),
    Lead.countDocuments({ ...dateFilter, status: "trial" }),
    Lead.countDocuments({ ...dateFilter, status: "negotiation" }),
    Lead.countDocuments({ ...dateFilter, status: "postponed" }),
  ]);

  const conversionRate = totalLeads > 0 ? ((enrolledLeads / totalLeads) * 100).toFixed(1) : 0;
  const lossRate = totalLeads > 0 ? (((rejectedLeads + lostLeads) / totalLeads) * 100).toFixed(1) : 0;

  return {
    totalLeads,
    newLeads,
    enrolledLeads,
    rejectedLeads,
    lostLeads,
    contactedLeads,
    interestedLeads,
    visitedLeads,
    trialLeads,
    negotiationLeads,
    postponedLeads,
    conversionRate: Number(conversionRate),
    lossRate: Number(lossRate),
    byStatus: {
      new: newLeads,
      contacted: contactedLeads,
      interested: interestedLeads,
      visited: visitedLeads,
      trial: trialLeads,
      negotiation: negotiationLeads,
      enrolled: enrolledLeads,
      rejected: rejectedLeads,
      lost: lostLeads,
      postponed: postponedLeads,
    },
  };
}

/**
 * Lead analitikasi - manba bo'yicha.
 * @param {object} query - { startDate, endDate }
 * @returns {Promise<Array>}
 */
async function getSourceAnalytics(query) {
  const { startDate, endDate } = query;

  const matchStage = {};
  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      matchStage.createdAt.$lte = end;
    }
  }

  return Lead.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: "$source",
        total: { $sum: 1 },
        enrolled: {
          $sum: { $cond: [{ $eq: ["$status", "enrolled"] }, 1, 0] },
        },
        rejected: {
          $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] },
        },
        lost: {
          $sum: { $cond: [{ $eq: ["$status", "lost"] }, 1, 0] },
        },
        active: {
          $sum: {
            $cond: [
              {
                $in: [
                  "$status",
                  ["new", "contacted", "interested", "visited", "trial", "negotiation", "postponed"],
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    {
      $lookup: {
        from: "leadsources",
        localField: "_id",
        foreignField: "_id",
        as: "source",
      },
    },
    { $unwind: "$source" },
    {
      $project: {
        _id: 1,
        sourceName: "$source.name",
        total: 1,
        enrolled: 1,
        rejected: 1,
        lost: 1,
        active: 1,
        conversionRate: {
          $cond: [
            { $gt: ["$total", 0] },
            { $round: [{ $multiply: [{ $divide: ["$enrolled", "$total"] }, 100] }, 1] },
            0,
          ],
        },
      },
    },
    { $sort: { total: -1 } },
  ]);
}

/**
 * Lead analitikasi - konversiya funnel.
 * Har bir active bosqichda hozir qancha lead turganini ko'rsatadi.
 * Shuningdek rejected/lost/postponed ham alohida ko'rsatiladi.
 * @param {object} query - { startDate, endDate }
 * @returns {Promise<object>}
 */
async function getConversionFunnel(query) {
  const { startDate, endDate } = query;

  const dateFilter = {};
  if (startDate || endDate) {
    dateFilter.createdAt = {};
    if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      dateFilter.createdAt.$lte = end;
    }
  }

  // Get exact count per status
  const statusCounts = await Lead.aggregate([
    { $match: dateFilter },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  const countMap = {};
  statusCounts.forEach((s) => {
    countMap[s._id] = s.count;
  });

  const totalLeads = Object.values(countMap).reduce((sum, c) => sum + c, 0);

  // Active pipeline stages (in order)
  const pipelineStages = ["new", "contacted", "interested", "visited", "trial", "negotiation", "enrolled"];

  const pipeline = pipelineStages.map((stage) => {
    const count = countMap[stage] || 0;
    return {
      stage,
      count,
      percentage: totalLeads > 0 ? Number(((count / totalLeads) * 100).toFixed(1)) : 0,
    };
  });

  // Calculate drop-off between consecutive stages
  for (let i = 1; i < pipeline.length; i++) {
    const prev = pipeline[i - 1].count;
    const curr = pipeline[i].count;
    pipeline[i].dropOff = prev > 0 ? Number((((prev - curr) / prev) * 100).toFixed(1)) : 0;
  }

  // Exit statuses
  const exitStatuses = ["rejected", "lost", "postponed"];
  const exits = exitStatuses.map((stage) => ({
    stage,
    count: countMap[stage] || 0,
    percentage: totalLeads > 0 ? Number((((countMap[stage] || 0) / totalLeads) * 100).toFixed(1)) : 0,
  }));

  return {
    totalLeads,
    pipeline,
    exits,
  };
}

/**
 * Lead analitikasi - vaqt bo'yicha trendlar.
 * @param {object} query - { days, startDate, endDate, groupBy }
 * groupBy: "day" | "week" | "month" (default: auto based on range)
 * @returns {Promise<Array>}
 */
async function getTrendAnalytics(query) {
  const { days, startDate: qStartDate, endDate: qEndDate, groupBy } = query;

  let rangeStart;
  let rangeEnd = new Date();
  rangeEnd.setHours(23, 59, 59, 999);

  if (qStartDate) {
    rangeStart = new Date(qStartDate);
    rangeStart.setHours(0, 0, 0, 0);
  } else {
    const daysNum = parseInt(days, 10) || 30;
    rangeStart = new Date();
    rangeStart.setDate(rangeStart.getDate() - daysNum);
    rangeStart.setHours(0, 0, 0, 0);
  }

  if (qEndDate) {
    rangeEnd = new Date(qEndDate);
    rangeEnd.setHours(23, 59, 59, 999);
  }

  const diffDays = Math.ceil((rangeEnd - rangeStart) / (1000 * 60 * 60 * 24));

  // Auto-select grouping based on range size
  let group = groupBy;
  if (!group) {
    if (diffDays <= 90) group = "day";
    else if (diffDays <= 365) group = "week";
    else group = "month";
  }

  let dateFormat;
  if (group === "month") dateFormat = "%Y-%m";
  else if (group === "week") dateFormat = "%G-W%V"; // ISO week
  else dateFormat = "%Y-%m-%d";

  const trends = await Lead.aggregate([
    { $match: { createdAt: { $gte: rangeStart, $lte: rangeEnd } } },
    {
      $group: {
        _id: {
          $dateToString: { format: dateFormat, date: "$createdAt" },
        },
        total: { $sum: 1 },
        enrolled: {
          $sum: { $cond: [{ $eq: ["$status", "enrolled"] }, 1, 0] },
        },
        lost: {
          $sum: {
            $cond: [{ $in: ["$status", ["rejected", "lost"]] }, 1, 0],
          },
        },
        active: {
          $sum: {
            $cond: [
              { $in: ["$status", ["new", "contacted", "interested", "visited", "trial", "negotiation", "postponed"]] },
              1,
              0,
            ],
          },
        },
      },
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        date: "$_id",
        total: 1,
        enrolled: 1,
        lost: 1,
        active: 1,
      },
    },
  ]);

  return { trends, groupBy: group, diffDays };
}

/**
 * Lead analitikasi - yo'nalish bo'yicha.
 * @param {object} query - { startDate, endDate }
 * @returns {Promise<Array>}
 */
async function getDirectionAnalytics(query) {
  const { startDate, endDate } = query;

  const matchStage = {};
  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      matchStage.createdAt.$lte = end;
    }
  }

  return Lead.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: "$direction",
        total: { $sum: 1 },
        enrolled: { $sum: { $cond: [{ $eq: ["$status", "enrolled"] }, 1, 0] } },
        active: {
          $sum: {
            $cond: [
              { $in: ["$status", ["new", "contacted", "interested", "visited", "trial", "negotiation", "postponed"]] },
              1,
              0,
            ],
          },
        },
        lost: {
          $sum: { $cond: [{ $in: ["$status", ["rejected", "lost"]] }, 1, 0] },
        },
      },
    },
    {
      $lookup: {
        from: "leaddirections",
        localField: "_id",
        foreignField: "_id",
        as: "direction",
      },
    },
    { $unwind: "$direction" },
    {
      $project: {
        _id: 1,
        directionName: "$direction.name",
        total: 1,
        enrolled: 1,
        active: 1,
        lost: 1,
        conversionRate: {
          $cond: [
            { $gt: ["$total", 0] },
            { $round: [{ $multiply: [{ $divide: ["$enrolled", "$total"] }, 100] }, 1] },
            0,
          ],
        },
      },
    },
    { $sort: { total: -1 } },
  ]);
}

/**
 * Lead analitikasi - toifa bo'yicha.
 * @param {object} query - { startDate, endDate }
 * @returns {Promise<Array>}
 */
async function getCategoryAnalytics(query) {
  const { startDate, endDate } = query;

  const matchStage = {};
  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      matchStage.createdAt.$lte = end;
    }
  }

  return Lead.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: "$category",
        total: { $sum: 1 },
        enrolled: { $sum: { $cond: [{ $eq: ["$status", "enrolled"] }, 1, 0] } },
        active: {
          $sum: {
            $cond: [
              { $in: ["$status", ["new", "contacted", "interested", "visited", "trial", "negotiation", "postponed"]] },
              1,
              0,
            ],
          },
        },
        lost: {
          $sum: { $cond: [{ $in: ["$status", ["rejected", "lost"]] }, 1, 0] },
        },
      },
    },
    {
      $lookup: {
        from: "leadcategories",
        localField: "_id",
        foreignField: "_id",
        as: "category",
      },
    },
    { $unwind: "$category" },
    {
      $project: {
        _id: 1,
        categoryName: "$category.name",
        total: 1,
        enrolled: 1,
        active: 1,
        lost: 1,
        conversionRate: {
          $cond: [
            { $gt: ["$total", 0] },
            { $round: [{ $multiply: [{ $divide: ["$enrolled", "$total"] }, 100] }, 1] },
            0,
          ],
        },
      },
    },
    { $sort: { total: -1 } },
  ]);
}

module.exports = {
  getAllLeads,
  getLeadById,
  createLead,
  updateLead,
  updateLeadStatus,
  deleteLead,
  getAnalyticsOverview,
  getSourceAnalytics,
  getConversionFunnel,
  getTrendAnalytics,
  getDirectionAnalytics,
  getCategoryAnalytics,
};
