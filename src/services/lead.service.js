const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");

// Lead status'lari — Mongoose modelidagi ro'yxat bilan bir xil (validatsiya uchun).
const LEAD_STATUSES = [
  "new",
  "contacted",
  "interested",
  "visited",
  "trial",
  "negotiation",
  "enrolled",
  "rejected",
  "lost",
  "postponed",
];

/**
 * source/direction/category/createdBy — Lead'da scalar ref (FK emas, populate yo'q).
 * Ularni qo'lda yuklab, populate shaklida ({ id, name } yoki { firstName, lastName })
 * lead(lar)ga biriktiradi. Bitta lead yoki lead massivi qabul qiladi.
 */
async function attachLeadRefs(leadsInput) {
  const isArray = Array.isArray(leadsInput);
  const leads = isArray ? leadsInput : [leadsInput];

  const sourceIds = [...new Set(leads.map((l) => l.source).filter(Boolean))];
  const directionIds = [...new Set(leads.map((l) => l.direction).filter(Boolean))];
  const categoryIds = [...new Set(leads.map((l) => l.category).filter(Boolean))];
  const creatorIds = [...new Set(leads.map((l) => l.createdBy).filter(Boolean))];

  const [sources, directions, categories, creators] = await Promise.all([
    prisma.leadSource.findMany({ where: { id: { in: sourceIds } }, select: { id: true, name: true } }),
    prisma.leadDirection.findMany({ where: { id: { in: directionIds } }, select: { id: true, name: true } }),
    prisma.leadCategory.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } }),
    prisma.user.findMany({
      where: { id: { in: creatorIds } },
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);

  const sourceMap = new Map(sources.map((s) => [s.id, s]));
  const directionMap = new Map(directions.map((d) => [d.id, d]));
  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const creatorMap = new Map(creators.map((c) => [c.id, c]));

  const mapped = leads.map((lead) => ({
    ...lead,
    source: sourceMap.get(lead.source) || null,
    direction: directionMap.get(lead.direction) || null,
    category: categoryMap.get(lead.category) || null,
    createdBy: creatorMap.get(lead.createdBy) || null,
  }));

  return isArray ? mapped : mapped[0];
}

/**
 * createdBy'ni ({ firstName, lastName }) aktivliklarga biriktiradi (scalar ref).
 */
async function attachActivityCreators(activities) {
  const creatorIds = [...new Set(activities.map((a) => a.createdBy).filter(Boolean))];
  const creators = await prisma.user.findMany({
    where: { id: { in: creatorIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const creatorMap = new Map(creators.map((c) => [c.id, c]));

  return activities.map((a) => ({ ...a, createdBy: creatorMap.get(a.createdBy) || null }));
}

/**
 * Sana oralig'i filtri qurish (createdAt gte/lte).
 */
function buildDateFilter(startDate, endDate) {
  const createdAt = {};
  if (startDate) createdAt.gte = new Date(startDate);
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    createdAt.lte = end;
  }
  return Object.keys(createdAt).length ? { createdAt } : {};
}

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
    if (startDate) filter.createdAt.gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.createdAt.lte = end;
    }
  }

  if (search && search.trim()) {
    const term = search.trim();
    filter.OR = [
      { firstName: { contains: term, mode: "insensitive" } },
      { lastName: { contains: term, mode: "insensitive" } },
      { phone: { contains: term, mode: "insensitive" } },
      { parentName: { contains: term, mode: "insensitive" } },
    ];
  }

  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  const skip = (pageNum - 1) * limitNum;

  const [total, rawLeads] = await Promise.all([
    prisma.lead.count({ where: filter }),
    prisma.lead.findMany({
      where: filter,
      orderBy: { createdAt: "desc" },
      skip,
      take: limitNum,
    }),
  ]);

  const leads = await attachLeadRefs(rawLeads);

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
  const rawLead = await prisma.lead.findUnique({ where: { id } });

  if (!rawLead) {
    throw new NotFoundError("Lead topilmadi");
  }

  const lead = await attachLeadRefs(rawLead);

  const rawActivities = await prisma.leadActivity.findMany({
    where: { leadId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const recentActivities = await attachActivityCreators(rawActivities);

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

  const sourceExists = await prisma.leadSource.findUnique({ where: { id: source } });
  if (!sourceExists) {
    throw new NotFoundError("Manba topilmadi");
  }

  const directionExists = await prisma.leadDirection.findUnique({ where: { id: direction } });
  if (!directionExists) {
    throw new NotFoundError("Yo'nalish topilmadi");
  }

  const categoryExists = await prisma.leadCategory.findUnique({ where: { id: category } });
  if (!categoryExists) {
    throw new NotFoundError("Toifa topilmadi");
  }

  const leadData = { ...data, createdBy: userId };
  if (createdAt) leadData.createdAt = new Date(createdAt);

  const lead = await prisma.lead.create({ data: leadData });

  // Auto-create first activity
  await prisma.leadActivity.create({
    data: {
      leadId: lead.id,
      type: "note",
      description: "Yangi lead yaratildi",
      createdBy: userId,
    },
  });

  const created = await prisma.lead.findUnique({ where: { id: lead.id } });
  return attachLeadRefs(created);
}

/**
 * Leadni yangilash.
 * @param {string} id - lead ID
 * @param {object} data - yangilanadigan ma'lumotlar
 * @returns {Promise<object>}
 */
async function updateLead(id, data) {
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) {
    throw new NotFoundError("Lead topilmadi");
  }

  // Don't allow status change through this method
  delete data.status;
  delete data.createdBy;

  if (data.createdAt) data.createdAt = new Date(data.createdAt);

  if (data.source) {
    const sourceExists = await prisma.leadSource.findUnique({ where: { id: data.source } });
    if (!sourceExists) {
      throw new NotFoundError("Manba topilmadi");
    }
  }

  if (data.direction) {
    const directionExists = await prisma.leadDirection.findUnique({ where: { id: data.direction } });
    if (!directionExists) {
      throw new NotFoundError("Yo'nalish topilmadi");
    }
  }

  if (data.category) {
    const categoryExists = await prisma.leadCategory.findUnique({ where: { id: data.category } });
    if (!categoryExists) {
      throw new NotFoundError("Toifa topilmadi");
    }
  }

  await prisma.lead.update({ where: { id }, data });

  const updated = await prisma.lead.findUnique({ where: { id } });
  return attachLeadRefs(updated);
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
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) {
    throw new NotFoundError("Lead topilmadi");
  }

  if (!status) {
    throw new BadRequestError("Yangi status majburiy");
  }

  if (!LEAD_STATUSES.includes(status)) {
    throw new BadRequestError("Noto'g'ri status");
  }

  const previousStatus = lead.status;

  const update = { status };

  if ((status === "rejected" || status === "lost") && lostReason) {
    update.lostReason = lostReason;
  }

  await prisma.lead.update({ where: { id }, data: update });

  // Log status change activity
  await prisma.leadActivity.create({
    data: {
      leadId: lead.id,
      type: "status_change",
      description: description || `Status "${previousStatus}" dan "${status}" ga o'zgartirildi`,
      previousStatus,
      newStatus: status,
      createdBy: userId,
    },
  });

  const updated = await prisma.lead.findUnique({ where: { id } });
  return attachLeadRefs(updated);
}

/**
 * Leadni o'chirish.
 * @param {string} id - lead ID
 * @returns {Promise<void>}
 */
async function deleteLead(id) {
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) {
    throw new NotFoundError("Lead topilmadi");
  }

  await Promise.all([
    prisma.lead.delete({ where: { id } }),
    prisma.leadActivity.deleteMany({ where: { leadId: id } }),
  ]);
}

/**
 * Lead analitikasi - umumiy ko'rinish.
 * @param {object} query - { startDate, endDate }
 * @returns {Promise<object>}
 */
async function getAnalyticsOverview(query) {
  const { startDate, endDate } = query;

  const dateFilter = buildDateFilter(startDate, endDate);

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
    prisma.lead.count({ where: dateFilter }),
    prisma.lead.count({ where: { ...dateFilter, status: "new" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "enrolled" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "rejected" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "lost" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "contacted" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "interested" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "visited" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "trial" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "negotiation" } }),
    prisma.lead.count({ where: { ...dateFilter, status: "postponed" } }),
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

  const conditions = [];
  const params = [];
  if (startDate) {
    params.push(new Date(startDate));
    conditions.push(`l.created_at >= $${params.length}`);
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    params.push(end);
    conditions.push(`l.created_at <= $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT
      l.source AS id,
      s.name AS "sourceName",
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE l.status = 'enrolled')::int AS enrolled,
      COUNT(*) FILTER (WHERE l.status = 'rejected')::int AS rejected,
      COUNT(*) FILTER (WHERE l.status = 'lost')::int AS lost,
      COUNT(*) FILTER (WHERE l.status IN ('new','contacted','interested','visited','trial','negotiation','postponed'))::int AS active,
      CASE WHEN COUNT(*) > 0
        THEN ROUND(COUNT(*) FILTER (WHERE l.status = 'enrolled')::numeric / COUNT(*) * 100, 1)
        ELSE 0 END AS "conversionRate"
    FROM leads l
    JOIN lead_sources s ON s.id = l.source
    ${whereClause}
    GROUP BY l.source, s.name
    ORDER BY total DESC
    `,
    ...params,
  );

  return rows.map((r) => ({ ...r, conversionRate: Number(r.conversionRate) }));
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

  const dateFilter = buildDateFilter(startDate, endDate);

  // Get exact count per status
  const statusCounts = await prisma.lead.groupBy({
    by: ["status"],
    where: dateFilter,
    _count: { _all: true },
  });

  const countMap = {};
  statusCounts.forEach((s) => {
    countMap[s.status] = s._count._all;
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
  if (group === "month") dateFormat = "YYYY-MM";
  else if (group === "week") dateFormat = 'IYYY-"W"IW'; // ISO week (e.g. 2026-W03)
  else dateFormat = "YYYY-MM-DD";

  const trends = await prisma.$queryRawUnsafe(
    `
    SELECT
      TO_CHAR(l.created_at, $1) AS date,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE l.status = 'enrolled')::int AS enrolled,
      COUNT(*) FILTER (WHERE l.status IN ('rejected','lost'))::int AS lost,
      COUNT(*) FILTER (WHERE l.status IN ('new','contacted','interested','visited','trial','negotiation','postponed'))::int AS active
    FROM leads l
    WHERE l.created_at >= $2 AND l.created_at <= $3
    GROUP BY date
    ORDER BY date ASC
    `,
    dateFormat,
    rangeStart,
    rangeEnd,
  );

  return { trends, groupBy: group, diffDays };
}

/**
 * Lead analitikasi - yo'nalish bo'yicha.
 * @param {object} query - { startDate, endDate }
 * @returns {Promise<Array>}
 */
async function getDirectionAnalytics(query) {
  const { startDate, endDate } = query;

  const conditions = [];
  const params = [];
  if (startDate) {
    params.push(new Date(startDate));
    conditions.push(`l.created_at >= $${params.length}`);
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    params.push(end);
    conditions.push(`l.created_at <= $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT
      l.direction AS id,
      d.name AS "directionName",
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE l.status = 'enrolled')::int AS enrolled,
      COUNT(*) FILTER (WHERE l.status IN ('new','contacted','interested','visited','trial','negotiation','postponed'))::int AS active,
      COUNT(*) FILTER (WHERE l.status IN ('rejected','lost'))::int AS lost,
      CASE WHEN COUNT(*) > 0
        THEN ROUND(COUNT(*) FILTER (WHERE l.status = 'enrolled')::numeric / COUNT(*) * 100, 1)
        ELSE 0 END AS "conversionRate"
    FROM leads l
    JOIN lead_directions d ON d.id = l.direction
    ${whereClause}
    GROUP BY l.direction, d.name
    ORDER BY total DESC
    `,
    ...params,
  );

  return rows.map((r) => ({ ...r, conversionRate: Number(r.conversionRate) }));
}

/**
 * Lead analitikasi - toifa bo'yicha.
 * @param {object} query - { startDate, endDate }
 * @returns {Promise<Array>}
 */
async function getCategoryAnalytics(query) {
  const { startDate, endDate } = query;

  const conditions = [];
  const params = [];
  if (startDate) {
    params.push(new Date(startDate));
    conditions.push(`l.created_at >= $${params.length}`);
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    params.push(end);
    conditions.push(`l.created_at <= $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT
      l.category AS id,
      c.name AS "categoryName",
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE l.status = 'enrolled')::int AS enrolled,
      COUNT(*) FILTER (WHERE l.status IN ('new','contacted','interested','visited','trial','negotiation','postponed'))::int AS active,
      COUNT(*) FILTER (WHERE l.status IN ('rejected','lost'))::int AS lost,
      CASE WHEN COUNT(*) > 0
        THEN ROUND(COUNT(*) FILTER (WHERE l.status = 'enrolled')::numeric / COUNT(*) * 100, 1)
        ELSE 0 END AS "conversionRate"
    FROM leads l
    JOIN lead_categories c ON c.id = l.category
    ${whereClause}
    GROUP BY l.category, c.name
    ORDER BY total DESC
    `,
    ...params,
  );

  return rows.map((r) => ({ ...r, conversionRate: Number(r.conversionRate) }));
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
