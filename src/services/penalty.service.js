const prisma = require("../config/prisma");
const { getPenaltySettings } = require("./settings.service");
const penaltyNotificationQueueService = require("./penaltyNotificationQueue.service");
const {
  uploadPenaltyAttachments,
  deletePenaltyAttachments,
} = require("./file.service");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const logger = require("../utils/logger");
const { BadRequestError, NotFoundError } = require("../utils/errors");

// ─── SOFT-REF POPULATE HELPERLARI ──────────────────────────────────
// user/givenBy/category/reviewedBy — FK emas (scalar String). Populate
// o'rniga qo'lda findMany({ id: { in } }) + JS xarita bilan biriktiramiz.

// Berilgan jarimalar massiviga user/givenBy/reviewedBy/category ni biriktiradi
async function attachRefs(penalties, { user, givenBy, reviewedBy, category } = {}) {
  const list = Array.isArray(penalties) ? penalties : [penalties];

  const userIds = new Set();
  const categoryIds = new Set();
  for (const p of list) {
    if (!p) continue;
    if (user && p.userId) userIds.add(p.userId);
    if (givenBy && p.givenBy) userIds.add(p.givenBy);
    if (reviewedBy && p.reviewedBy) userIds.add(p.reviewedBy);
    if (category && p.category) categoryIds.add(p.category);
  }

  const [users, categories] = await Promise.all([
    userIds.size > 0
      ? prisma.user.findMany({
          where: { id: { in: [...userIds] } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            role: true,
            username: true,
            penaltyPoints: true,
          },
        })
      : [],
    categoryIds.size > 0
      ? prisma.penaltyCategory.findMany({
          where: { id: { in: [...categoryIds] } },
          select: { id: true, title: true, description: true, points: true },
        })
      : [],
  ]);

  const userMap = new Map(users.map((u) => [u.id, u]));
  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  return list.map((p) => {
    if (!p) return p;
    const out = { ...p };
    if (user) out.user = userMap.get(p.userId) || null;
    if (givenBy) out.givenBy = userMap.get(p.givenBy) || null;
    if (reviewedBy) out.reviewedBy = userMap.get(p.reviewedBy) || null;
    if (category) out.category = p.category ? categoryMap.get(p.category) || null : null;
    return out;
  });
}

// ─── KATEGORIYA CRUD ───────────────────────────────────────────────

/**
 * Yangi jarima kategoriyasi yaratadi
 * @param {object} data - Kategoriya ma'lumotlari
 * @param {string} createdBy - Yaratuvchi foydalanuvchi IDsi
 * @returns {Promise<Document>} Yaratilgan kategoriya
 */
const createPenaltyCategory = async (data, createdBy) => {
  const category = await prisma.penaltyCategory.create({
    data: {
      title: data.title,
      description: data.description,
      points: data.points,
      targetRole: data.targetRole,
      createdBy,
    },
  });
  return category;
};

/**
 * Rolga qarab kategoriyalar ro'yxatini qaytaradi
 * @param {string} targetRole - "teacher" yoki "student"
 * @returns {Promise<Array>} Kategoriyalar ro'yxati
 */
const getCategories = async (targetRole) => {
  const filter = { isActive: true };
  if (targetRole) {
    filter.targetRole = targetRole;
  }
  return prisma.penaltyCategory.findMany({
    where: filter,
    orderBy: { createdAt: "desc" },
  });
};

/**
 * Kategoriyani yangilaydi (avvalgi jarimalar ta'sirlanmaydi)
 * @param {string} id - Kategoriya IDsi
 * @param {object} data - Yangilanadigan maydonlar
 * @returns {Promise<Document>} Yangilangan kategoriya
 */
const updateCategory = async (id, data) => {
  const existing = await prisma.penaltyCategory.findUnique({ where: { id } });
  if (!existing) {
    throw new Error("Kategoriya topilmadi");
  }
  const category = await prisma.penaltyCategory.update({
    where: { id },
    data: {
      title: data.title,
      description: data.description,
      points: data.points,
    },
  });
  return category;
};

/**
 * Kategoriyani soft delete qiladi (isActive: false)
 * @param {string} id - Kategoriya IDsi
 * @returns {Promise<Document>} O'chirilgan kategoriya
 */
const deleteCategory = async (id) => {
  const existing = await prisma.penaltyCategory.findUnique({ where: { id } });
  if (!existing) {
    throw new Error("Kategoriya topilmadi");
  }
  const category = await prisma.penaltyCategory.update({
    where: { id },
    data: { isActive: false },
  });
  return category;
};

// ─── JARIMA YOZISH ─────────────────────────────────────────────────

/**
 * O'quvchiga bot orqali jarima xabarnomasini yuboradi (background job orqali)
 * @param {Document} user - Jarimaga uchragan foydalanuvchi
 * @param {Document} penalty - Jarima hujjati (title, points, description, attachments)
 * @param {number} totalPoints - Foydalanuvchining jami jarima bali
 */
const sendPenaltyNotification = async (user, penalty, totalPoints) => {
  try {
    if (
      user.role !== "student" ||
      !user.telegramIds ||
      user.telegramIds.length === 0
    ) {
      return;
    }

    const tgUsers = await prisma.tgUser.findMany({
      where: {
        student: user.id,
        isActive: true,
        notificationsEnabled: true,
      },
    });

    if (tgUsers.length === 0) return;

    const studentName = user.lastName
      ? `${user.firstName} ${user.lastName}`
      : user.firstName;

    let text = `⚠️ <b>Jarima xabarnomasi</b>\n\n`;
    text += `👤 O'quvchi: <b>${studentName}</b>\n`;
    text += `📋 Sabab: <b>${penalty.title}</b>\n`;
    text += `🔴 Ball: <b>${penalty.points}</b>\n`;
    if (penalty.description) {
      text += `📝 Izoh: ${penalty.description}\n`;
    }
    text += `\n📊 Jami jarima bali: <b>${totalPoints}</b>`;

    if (totalPoints >= 12) {
      text += `\n\n🚫 <b>Diqqat!</b> Jarima bali 12 ga yetdi. Profil bloklandi.`;
    } else if (totalPoints > 3) {
      text += `\n\n⚠️ Do'kondan foydalanish cheklangan (jarima bali 3 dan yuqori).`;
    }

    const attachments = (penalty.attachments || []).map((att) => ({
      url: att.url,
      type: att.type,
      originalName: att.originalName,
    }));

    const queueItems = tgUsers.map((tgUser) => ({
      penaltyId: penalty.id,
      telegramId: tgUser.chatId,
      userId: user.id,
      messageText: text,
      attachments,
    }));

    await penaltyNotificationQueueService.addBulkToQueue(queueItems);
  } catch (error) {
    logger.error(`Jarima xabarnomasi yuborishda xato: ${error.message}`);
  }
};

/**
 * Yangi jarima yaratadi
 * @param {object} params - Jarima parametrlari
 * @param {string} params.userId - Jarima oluvchi foydalanuvchi IDsi
 * @param {string} params.categoryId - Kategoriya IDsi (ixtiyoriy)
 * @param {string} params.title - Sarlavha
 * @param {string} params.description - Izoh
 * @param {number} params.points - Ball
 * @param {string} params.givenBy - Jarima yozuvchi IDsi
 * @param {string} params.givenByRole - Jarima yozuvchi roli
 * @param {boolean} params.isCustom - Custom jarima yoki yo'q
 * @param {Array} params.files - Multer fayl massivi (ixtiyoriy)
 * @returns {Promise<Document>} Yaratilgan jarima
 */
const createPenalty = async ({
  userId,
  categoryId,
  title,
  description,
  points,
  givenBy,
  givenByRole,
  isCustom,
  files,
}) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error("Foydalanuvchi topilmadi");
  }

  // O'qituvchi faqat o'quvchiga jarima yozishi mumkin
  if (givenByRole === "teacher" && user.role !== "student") {
    throw new Error("O'qituvchi faqat o'quvchiga jarima yozishi mumkin");
  }

  // Owner o'qituvchi va o'quvchiga jarima yozishi mumkin
  if (givenByRole === "owner" && user.role === "owner") {
    throw new Error("Ownerga jarima yozib bo'lmaydi");
  }

  // Reception ownerdan boshqa hamma rollarga jarima yozishi mumkin
  if (givenByRole === "reception" && user.role === "owner") {
    throw new Error("Ownerga jarima yozib bo'lmaydi");
  }

  // O'qituvchi faqat kategoriya bo'yicha jarima yoza oladi
  if (givenByRole === "teacher" && isCustom) {
    throw new Error("O'qituvchi faqat kategoriya bo'yicha jarima yoza oladi");
  }

  // Reception faqat kategoriya bo'yicha jarima yoza oladi
  if (givenByRole === "reception" && isCustom) {
    throw new Error("Reception faqat kategoriya bo'yicha jarima yoza oladi");
  }

  // Kategoriya bo'lsa, undan ma'lumot olish
  let categoryData = null;
  if (categoryId && !isCustom) {
    categoryData = await prisma.penaltyCategory.findUnique({
      where: { id: categoryId },
    });
    if (!categoryData) {
      throw new Error("Kategoriya topilmadi");
    }
  }

  // PenaltySettings dan joriy jarima miqdorini olish (snapshot)
  const settings = await getPenaltySettings();
  const fineAmount = settings.fineAmounts?.[user.role] || 0;

  // Fayllarni yuklash
  const attachments = await uploadPenaltyAttachments(files);

  // Owner va reception yozgan jarima darhol approved
  const status =
    givenByRole === "owner" || givenByRole === "reception" ? "approved" : "pending";

  const penalty = await prisma.penalty.create({
    data: {
      userId,
      givenBy,
      category: categoryId || null,
      title: isCustom ? title : categoryData?.title || title,
      description: description || categoryData?.description,
      points: isCustom ? points : categoryData?.points || points,
      status,
      isCustom: !!isCustom,
      fineAmount,
      attachments,
      reviewedBy: status === "approved" ? givenBy : null,
      reviewedAt: status === "approved" ? new Date() : null,
    },
  });

  // Agar darhol approved bo'lsa - penaltyPoints oshirish
  if (status === "approved") {
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { penaltyPoints: { increment: penalty.points } },
    });

    // Bot xabarnoma yuborish (background job orqali)
    sendPenaltyNotification(updatedUser, penalty, updatedUser.penaltyPoints);
  }

  return penalty;
};

// ─── JARIMA TASDIQLASH / RAD ETISH ─────────────────────────────────

/**
 * Jarimani tasdiqlash yoki rad etish (faqat owner)
 * @param {string} penaltyId - Jarima IDsi
 * @param {object} params - Tasdiqlash parametrlari
 * @param {string} params.status - "approved" yoki "rejected"
 * @param {string} params.rejectionReason - Rad etish sababi (rejected uchun)
 * @param {string} params.reviewedBy - Tasdiqlagan owner IDsi
 * @returns {Promise<Document>} Yangilangan jarima
 */
const reviewPenalty = async (
  penaltyId,
  { status, rejectionReason, reviewedBy },
) => {
  const penalty = await prisma.penalty.findUnique({ where: { id: penaltyId } });
  if (!penalty) {
    throw new Error("Jarima topilmadi");
  }

  if (penalty.status !== "pending") {
    throw new Error(
      "Faqat kutilayotgan holatdagi jarimani tasdiqlash yoki rad etish mumkin",
    );
  }

  if (status === "rejected" && !rejectionReason) {
    throw new Error("Rad etish sababi majburiy");
  }

  const update = {
    status,
    reviewedBy,
    reviewedAt: new Date(),
  };

  if (status === "rejected") {
    update.rejectionReason = rejectionReason;
  }

  const updatedPenalty = await prisma.penalty.update({
    where: { id: penaltyId },
    data: update,
  });

  // Approved bo'lsa - penaltyPoints o'zgartirish (tur bo'yicha)
  if (status === "approved") {
    const inc =
      updatedPenalty.type === "reduction"
        ? -updatedPenalty.points
        : updatedPenalty.points;
    const updatedUser = await prisma.user.update({
      where: { id: updatedPenalty.userId },
      data: { penaltyPoints: { increment: inc } },
    });

    // Bot xabarnoma faqat oddiy jarima uchun (background job orqali)
    if (updatedPenalty.type === "penalty") {
      sendPenaltyNotification(
        updatedUser,
        updatedPenalty,
        updatedUser.penaltyPoints,
      );
    }
  }

  return updatedPenalty;
};

// ─── JARIMA KAMAYTIRISH ────────────────────────────────────────────

/**
 * Jarima balini kamaytirish so'rovini yaratadi (owner tasdiqlashini kutadi)
 * @param {object} params - Kamaytirish parametrlari
 * @param {string} params.userId - Foydalanuvchi IDsi
 * @param {number} params.points - Kamaytirilayotgan ball
 * @param {string} params.reason - Kamaytirish sababi
 * @param {string} params.reducedBy - So'rov yuborgan owner IDsi
 * @returns {Promise<Document>} Yaratilgan Penalty (type: "reduction")
 */
const reducePenalty = async ({
  userId,
  points,
  reason,
  reducedBy,
  reducedByRole,
}) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error("Foydalanuvchi topilmadi");
  }

  if (points < 1) {
    throw new Error("Kamaytirilayotgan ball kamida 1 bo'lishi kerak");
  }

  if (points > user.penaltyPoints) {
    throw new Error(
      `Kamaytirilayotgan ball foydalanuvchida mavjud balldan (${user.penaltyPoints}) ko'p bo'lishi mumkin emas`,
    );
  }

  const settings = await getPenaltySettings();
  const fineAmount = settings.fineAmounts?.[user.role] || 0;

  // Owner tomonidan yaratilgan kamaytirish darhol tasdiqlanadi
  const status = reducedByRole === "owner" ? "approved" : "pending";

  const reduction = await prisma.penalty.create({
    data: {
      type: "reduction",
      userId,
      givenBy: reducedBy,
      description: reason,
      points,
      status,
      isCustom: false,
      fineAmount,
      reviewedBy: status === "approved" ? reducedBy : null,
      reviewedAt: status === "approved" ? new Date() : null,
    },
  });

  // Agar darhol approved bo'lsa - penaltyPoints kamaytirish
  if (status === "approved") {
    await prisma.user.update({
      where: { id: userId },
      data: { penaltyPoints: { decrement: points } },
    });
  }

  return reduction;
};

// ─── RO'YXATLAR ────────────────────────────────────────────────────

/**
 * Barcha jarimalar ro'yxatini qaytaradi (filtrlash bilan)
 * @param {object} req - Express request (query: status, startDate, endDate, page, limit)
 * @returns {Promise<object>} Formatlanganpaginated response
 */
const getPenalties = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { status, startDate, endDate, search } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.createdAt.lte = end;
    }
  }

  if (search) {
    const matchedUsers = await prisma.user.findMany({
      where: {
        OR: [
          { firstName: { contains: search, mode: "insensitive" } },
          { lastName: { contains: search, mode: "insensitive" } },
          { username: { contains: search, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });
    const userIds = matchedUsers.map((u) => u.id);
    filter.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
      { userId: { in: userIds } },
    ];
  }

  const [rawPenalties, total] = await Promise.all([
    prisma.penalty.findMany({
      where: filter,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.penalty.count({ where: filter }),
  ]);

  const penalties = await attachRefs(rawPenalties, {
    user: true,
    givenBy: true,
    reviewedBy: true,
    category: true,
  });

  return formatPaginationResponse(penalties, total, page, limit);
};

/**
 * Pending holatdagi jarimalar ro'yxati
 * @param {object} req - Express request
 * @returns {Promise<object>} Formatlanganpaginated response
 */
const getPendingPenalties = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);

  const filter = { status: "pending" };

  const [rawPenalties, total] = await Promise.all([
    prisma.penalty.findMany({
      where: filter,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.penalty.count({ where: filter }),
  ]);

  const penalties = await attachRefs(rawPenalties, {
    user: true,
    givenBy: true,
    category: true,
  });

  return formatPaginationResponse(penalties, total, page, limit);
};

/**
 * Bitta foydalanuvchining jarimalari
 * @param {string} userId - Foydalanuvchi IDsi
 * @param {object} req - Express request
 * @returns {Promise<object>} Formatlanganpaginated response
 */
const getUserPenalties = async (userId, req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { status } = req.query;

  const filter = { userId, type: "penalty" };
  if (status) filter.status = status;

  const [rawPenalties, total] = await Promise.all([
    prisma.penalty.findMany({
      where: filter,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.penalty.count({ where: filter }),
  ]);

  const penalties = await attachRefs(rawPenalties, {
    givenBy: true,
    reviewedBy: true,
    category: true,
  });

  return formatPaginationResponse(penalties, total, page, limit);
};

/**
 * O'z jarimalari (student/teacher panel uchun)
 * @param {string} userId - Foydalanuvchi IDsi
 * @param {object} req - Express request
 * @returns {Promise<object>} Formatlanganpaginated response
 */
const getMyPenalties = async (userId, req) => {
  const { page, limit, skip } = getPaginationParams(req);

  const filter = { userId };

  const [rawPenalties, total] = await Promise.all([
    prisma.penalty.findMany({
      where: filter,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.penalty.count({ where: filter }),
  ]);

  const penalties = await attachRefs(rawPenalties, {
    givenBy: true,
    category: true,
  });

  return formatPaginationResponse(penalties, total, page, limit);
};

/**
 * Ustoz bergan jarimalar ro'yxati (teacher panel uchun)
 * @param {string} givenById - Ustoz IDsi
 * @param {object} req - Express request
 * @returns {Promise<object>} Formatlanganpaginated response
 */
const getGivenPenalties = async (givenById, req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { status } = req.query;

  const filter = { givenBy: givenById, type: { not: "reduction" } };
  if (status) filter.status = status;

  const [rawPenalties, total] = await Promise.all([
    prisma.penalty.findMany({
      where: filter,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.penalty.count({ where: filter }),
  ]);

  const penalties = await attachRefs(rawPenalties, {
    user: true,
    category: true,
  });

  return formatPaginationResponse(penalties, total, page, limit);
};

/**
 * Bitta jarima tafsiloti
 * @param {string} id - Jarima IDsi
 * @returns {Promise<Document>} Jarima hujjati
 */
const getPenaltyById = async (id) => {
  const rawPenalty = await prisma.penalty.findUnique({ where: { id } });

  if (!rawPenalty) {
    throw new Error("Jarima topilmadi");
  }

  const [penalty] = await attachRefs(rawPenalty, {
    user: true,
    givenBy: true,
    reviewedBy: true,
    category: true,
  });

  return penalty;
};

/**
 * Kamaytirish tarixi
 * @param {object} req - Express request (query: userId)
 * @returns {Promise<object>} Formatlanganpaginated response
 */
const getReductions = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { userId } = req.query;

  const filter = { type: "reduction" };
  if (userId) filter.userId = userId;

  const [rawReductions, total] = await Promise.all([
    prisma.penalty.findMany({
      where: filter,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.penalty.count({ where: filter }),
  ]);

  const reductions = await attachRefs(rawReductions, {
    user: true,
    givenBy: true,
  });

  return formatPaginationResponse(reductions, total, page, limit);
};

// ─── STATISTIKA ────────────────────────────────────────────────────

/**
 * Jarima statistikasi: umumiy ball, kamaytirilgan ball, top 10 o'quvchi, top 10 o'qituvchi
 * @returns {Promise<object>} Statistika ob'yekti
 */
const getPenaltyStats = async () => {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
  thirtyDaysAgo.setHours(0, 0, 0, 0);

  const [
    totalApprovedPoints,
    totalReducedPoints,
    topUsers,
    topStudents,
    pendingCount,
    dailyPenalties,
    dailyReductions,
  ] = await Promise.all([
    prisma.penalty.aggregate({
      where: { type: "penalty", status: "approved" },
      _sum: { points: true },
    }),
    prisma.penalty.aggregate({
      where: { type: "reduction", status: "approved" },
      _sum: { points: true },
    }),
    prisma.user.findMany({
      where: {
        role: { notIn: ["owner", "student"] },
        penaltyPoints: { gt: 0 },
      },
      select: {
        firstName: true,
        lastName: true,
        username: true,
        penaltyPoints: true,
        role: true,
      },
      orderBy: { penaltyPoints: "desc" },
      take: 10,
    }),
    prisma.user.findMany({
      where: { role: "student", penaltyPoints: { gt: 0 } },
      select: {
        firstName: true,
        lastName: true,
        username: true,
        penaltyPoints: true,
        role: true,
      },
      orderBy: { penaltyPoints: "desc" },
      take: 10,
    }),
    prisma.penalty.count({ where: { status: "pending" } }),
    prisma.$queryRawUnsafe(
      `
      SELECT
        EXTRACT(YEAR FROM created_at)::int AS year,
        EXTRACT(MONTH FROM created_at)::int AS month,
        EXTRACT(DAY FROM created_at)::int AS day,
        SUM(points)::int AS points
      FROM penalties
      WHERE type = 'penalty' AND status = 'approved' AND created_at >= $1
      GROUP BY year, month, day
      ORDER BY year ASC, month ASC, day ASC
      `,
      thirtyDaysAgo,
    ),
    prisma.$queryRawUnsafe(
      `
      SELECT
        EXTRACT(YEAR FROM created_at)::int AS year,
        EXTRACT(MONTH FROM created_at)::int AS month,
        EXTRACT(DAY FROM created_at)::int AS day,
        SUM(points)::int AS points
      FROM penalties
      WHERE type = 'reduction' AND status = 'approved' AND created_at >= $1
      GROUP BY year, month, day
      ORDER BY year ASC, month ASC, day ASC
      `,
      thirtyDaysAgo,
    ),
  ]);

  // So'nggi 30 kun uchun to'liq kunlik massiv hosil qilish
  const dailyTrend = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(thirtyDaysAgo);
    d.setDate(d.getDate() + i);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const day = d.getDate();

    const penaltyEntry = dailyPenalties.find(
      (e) => e.year === year && e.month === month && e.day === day,
    );
    const reductionEntry = dailyReductions.find(
      (e) => e.year === year && e.month === month && e.day === day,
    );

    dailyTrend.push({
      date: d.toISOString().split("T")[0],
      penaltyPoints: penaltyEntry?.points || 0,
      reductionPoints: reductionEntry?.points || 0,
    });
  }

  return {
    totalApprovedPoints: totalApprovedPoints._sum.points || 0,
    totalReducedPoints: totalReducedPoints._sum.points || 0,
    topUsers,
    topStudents,
    pendingCount,
    dailyTrend,
  };
};

// ─── SOZLAMALAR ────────────────────────────────────────────────────

/**
 * Jarima sozlamalarini olish
 * @returns {Promise<Document>} PenaltySettings
 */
const getSettings = async () => {
  return getPenaltySettings();
};

/**
 * Jarima sozlamalarini yangilash
 * @param {object} data - Yangilanadigan maydonlar
 * @param {object} data.fineAmounts - Har bir rol uchun jarima miqdori ({ student: N, teacher: N, ... })
 * @param {string} updatedBy - Yangilovchi foydalanuvchi IDsi
 * @returns {Promise<Document>} Yangilangan PenaltySettings
 */
const updateSettings = async (data, updatedBy) => {
  const settings = await getPenaltySettings();

  const fineAmounts = { ...(settings.fineAmounts || {}) };
  const update = {};

  // Yangi format: fineAmounts object
  if (data.fineAmounts && typeof data.fineAmounts === "object") {
    for (const [role, amount] of Object.entries(data.fineAmounts)) {
      fineAmounts[role] = Number(amount);
    }
  }

  // Backward compat: eski format ham qabul qilinadi
  if (data.studentFineAmount !== undefined) {
    update.studentFineAmount = data.studentFineAmount;
    fineAmounts.student = data.studentFineAmount;
  }
  if (data.teacherFineAmount !== undefined) {
    update.teacherFineAmount = data.teacherFineAmount;
    fineAmounts.teacher = data.teacherFineAmount;
  }

  if (data.premiumReductionDiscountPercent !== undefined) {
    update.premiumReductionDiscountPercent =
      data.premiumReductionDiscountPercent;
  }

  update.fineAmounts = fineAmounts;
  update.updatedBy = updatedBy;

  return prisma.penaltySettings.update({
    where: { id: settings.id },
    data: update,
  });
};

// ─── KAMAYTIRISH PAKETLARI CRUD ────────────────────────────────────

/**
 * Yangi kamaytirish paketi yaratadi
 * @param {object} data - { title, points, coinCost, order }
 * @param {string} createdBy - Owner user IDsi
 * @returns {Promise<Document>}
 */
const createReductionPackage = async (data, createdBy) => {
  return prisma.fineReductionPackage.create({
    data: {
      title: data.title,
      points: data.points,
      coinCost: data.coinCost,
      order: data.order ?? 0,
      createdBy,
    },
  });
};

/**
 * Kamaytirish paketlari ro'yxatini qaytaradi
 * @param {boolean} onlyActive - Faqat faol paketlarmi
 * @returns {Promise<Array>}
 */
const getReductionPackages = async (onlyActive = false) => {
  const filter = onlyActive ? { isActive: true } : {};
  return prisma.fineReductionPackage.findMany({
    where: filter,
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
};

/**
 * Kamaytirish paketini yangilaydi
 * @param {string} id - Paket IDsi
 * @param {object} data - Yangilanadigan maydonlar
 * @returns {Promise<Document>}
 */
const updateReductionPackage = async (id, data) => {
  const existing = await prisma.fineReductionPackage.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Paket topilmadi");
  const pkg = await prisma.fineReductionPackage.update({
    where: { id },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.points !== undefined && { points: data.points }),
      ...(data.coinCost !== undefined && { coinCost: data.coinCost }),
      ...(data.order !== undefined && { order: data.order }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    },
  });
  return pkg;
};

/**
 * Kamaytirish paketini soft delete qiladi
 * @param {string} id - Paket IDsi
 * @returns {Promise<Document>}
 */
const deleteReductionPackage = async (id) => {
  const existing = await prisma.fineReductionPackage.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Paket topilmadi");
  const pkg = await prisma.fineReductionPackage.update({
    where: { id },
    data: { isActive: false },
  });
  return pkg;
};

/**
 * O'quvchi tanga evaziga jarima balini kamaytiradi (atomic)
 * @param {string} studentId - O'quvchi IDsi
 * @param {string} packageId - FineReductionPackage IDsi
 * @returns {Promise<{ penalty: Document, transaction: Document }>}
 */
const purchaseReductionPackage = async (studentId, packageId) => {
  const pkg = await prisma.fineReductionPackage.findUnique({
    where: { id: packageId },
  });
  if (!pkg || !pkg.isActive) throw new NotFoundError("Paket topilmadi");

  const settings = await getPenaltySettings();
  const student = await prisma.user.findUnique({ where: { id: studentId } });
  if (!student) throw new NotFoundError("Foydalanuvchi topilmadi");

  if (student.role !== "student") {
    throw new BadRequestError("Faqat o'quvchilar paket sotib ola oladi");
  }

  if (student.penaltyPoints < 1) {
    throw new BadRequestError(
      "Jarima balingiz nolga teng, kamaytirish kerak emas",
    );
  }

  const discountPercent = student.premiumIsActive
    ? (settings.premiumReductionDiscountPercent ?? 0)
    : 0;
  const finalCoinCost = Math.ceil(pkg.coinCost * (1 - discountPercent / 100));

  if (student.coinBalance < finalCoinCost) {
    throw new BadRequestError(
      `Tangalar yetarli emas. Kerak: ${finalCoinCost}, balans: ${student.coinBalance}`,
    );
  }

  const pointsReduced = Math.min(pkg.points, student.penaltyPoints);

  // Atomic updateMany - race condition himoyasi (shart guard bilan)
  const updateResult = await prisma.user.updateMany({
    where: {
      id: studentId,
      coinBalance: { gte: finalCoinCost },
      penaltyPoints: { gte: 1 },
    },
    data: {
      coinBalance: { decrement: finalCoinCost },
      penaltyPoints: { decrement: pointsReduced },
    },
  });

  if (updateResult.count === 0) {
    throw new BadRequestError(
      "Tangalar yetarli emas yoki jarima balingiz o'zgardi",
    );
  }

  const updatedUser = await prisma.user.findUnique({ where: { id: studentId } });

  const penalty = await prisma.penalty.create({
    data: {
      type: "reduction",
      userId: studentId,
      givenBy: studentId,
      title: `Jarima paketi xaridi`,
      description: `"${pkg.title}" jarima paketi xarid qilindi`,
      points: pointsReduced,
      status: "approved",
      isCustom: false,
      fineAmount: 0,
      reviewedBy: studentId,
      reviewedAt: new Date(),
    },
  });

  const transaction = await prisma.coinTransaction.create({
    data: {
      studentId,
      amount: finalCoinCost,
      type: "fine_reduction_purchase",
      description: `Jarima kamaytirishga sarflandi: ${pkg.title} (-${pointsReduced} ball)`,
      balanceAfter: updatedUser.coinBalance,
      date: new Date(),
      meta: {
        packageId: pkg.id,
        pointsReduced,
        originalCoinCost: pkg.coinCost,
        discountPercent,
        finalCoinCost,
        penaltyRecordId: penalty.id,
      },
    },
  });

  return { penalty, transaction };
};

// ─── JARIMA O'CHIRISH ──────────────────────────────────────────────

/**
 * Jarimani o'chiradi va bog'liq ma'lumotlarni tiklaydi
 * @param {string} penaltyId - Jarima IDsi
 * @returns {Promise<Document>} O'chirilgan jarima
 */
const deletePenalty = async (penaltyId) => {
  const penalty = await prisma.penalty.findUnique({ where: { id: penaltyId } });
  if (!penalty) throw new NotFoundError("Jarima topilmadi");

  // Approved jarimaning ta'sirini bekor qilish
  if (penalty.status === "approved") {
    const inc = penalty.type === "reduction" ? penalty.points : -penalty.points;
    await prisma.user.update({
      where: { id: penalty.userId },
      data: { penaltyPoints: { increment: inc } },
    });
  }

  // S3 dan fayllarni o'chirish
  if (penalty.attachments?.length > 0) {
    await deletePenaltyAttachments(penalty.attachments);
  }

  await prisma.penalty.delete({ where: { id: penaltyId } });
  return penalty;
};

// ============================================================
// Baho qo'ymaslik jarima sozlamalari
// ============================================================

const { getGradePenaltySettings: getGradePenaltySettingsSingleton } = require(
  "./settings.service",
);

// exemptTeachers — soft ref (scalar String[]). Populate o'rniga qo'lda yuklab
// biriktiramiz (firstName lastName).
async function populateExemptTeachers(settings) {
  const ids = settings.exemptTeachers || [];
  if (ids.length === 0) {
    return { ...settings, exemptTeachers: [] };
  }
  const teachers = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true },
  });
  const map = new Map(teachers.map((t) => [t.id, t]));
  return {
    ...settings,
    exemptTeachers: ids.map((id) => map.get(id)).filter(Boolean),
  };
}

const getGradePenaltySettings = async () => {
  const settings = await getGradePenaltySettingsSingleton();
  return populateExemptTeachers(settings);
};

const updateGradePenaltySettings = async (data, userId) => {
  const settings = await getGradePenaltySettingsSingleton();

  const update = {};
  if (data.isEnabled !== undefined) update.isEnabled = data.isEnabled;
  if (data.penaltyPoints !== undefined) update.penaltyPoints = data.penaltyPoints;
  if (data.missingThresholdPercent !== undefined)
    update.missingThresholdPercent = data.missingThresholdPercent;
  if (data.exemptTeachers !== undefined) update.exemptTeachers = data.exemptTeachers;

  update.updatedBy = userId;

  const updated = await prisma.gradePenaltySettings.update({
    where: { id: settings.id },
    data: update,
  });

  return populateExemptTeachers(updated);
};

module.exports = {
  createPenaltyCategory,
  getCategories,
  updateCategory,
  deleteCategory,
  createPenalty,
  deletePenalty,
  reviewPenalty,
  reducePenalty,
  getPenalties,
  getPendingPenalties,
  getUserPenalties,
  getMyPenalties,
  getGivenPenalties,
  getPenaltyById,
  getReductions,
  getPenaltyStats,
  getSettings,
  updateSettings,
  createReductionPackage,
  getReductionPackages,
  updateReductionPackage,
  deleteReductionPackage,
  purchaseReductionPackage,
  getGradePenaltySettings,
  updateGradePenaltySettings,
};
