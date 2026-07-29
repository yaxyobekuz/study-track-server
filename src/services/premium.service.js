const crypto = require("crypto");
const prisma = require("../config/prisma");
const { uploadImageWithVariants, deleteImageVariants } = require("./image.service");
const fileStorageService = require("./fileStorage.service");
const { notifyPremiumEvent } = require("./premiumNotification.service");
const { getPremiumSettings } = require("./settings.service");
const { ValidationError, NotFoundError, BadRequestError } = require("../utils/errors");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");
const logger = require("../utils/logger");

/**
 * Buys premium for a student using current settings (cost/duration).
 * If already active, extends from current expiresAt.
 * @param {string} studentId
 * @returns {Promise<object>} Updated user
 */
const purchasePremium = async (studentId) => {
  const settings = await getPremiumSettings();

  if (!settings.isEnabled) {
    throw new BadRequestError("MBSI Premium hozircha mavjud emas");
  }

  const cost = settings.coinCost;
  const durationDays = settings.durationDays;

  // Atomik: faqat balans yetarli bo'lsa yechamiz
  const decremented = await prisma.user.updateMany({
    where: { id: studentId, coinBalance: { gte: cost } },
    data: { coinBalance: { decrement: cost } },
  });

  if (decremented.count === 0) {
    const exists = await prisma.user.findUnique({ where: { id: studentId }, select: { id: true } });
    if (!exists) throw new NotFoundError("Foydalanuvchi topilmadi");
    throw new BadRequestError(`Tangalar yetarli emas. Premium uchun kamida ${cost} tanga kerak`);
  }

  const user = await prisma.user.findUnique({ where: { id: studentId } });

  const now = new Date();
  const baseDate = user.premiumIsActive && user.premiumExpiresAt > now
    ? new Date(user.premiumExpiresAt)
    : now;

  const endDate = new Date(baseDate);
  endDate.setDate(endDate.getDate() + durationDays);

  const premium = await prisma.premium.create({
    data: {
      student: studentId,
      durationDays,
      coinCost: cost,
      startDate: now,
      endDate,
      status: "active",
      coinBalanceAfter: user.coinBalance,
      source: "purchase",
    },
  });

  await prisma.user.update({
    where: { id: studentId },
    data: {
      premiumIsActive: true,
      premiumExpiresAt: endDate,
    },
  });

  await prisma.coinTransaction.create({
    data: {
      studentId,
      amount: cost,
      type: "premium_purchase",
      description: `MBSI Premium - ${durationDays} kunlik obuna`,
      balanceAfter: user.coinBalance,
      date: now,
      meta: { premiumId: premium.id },
    },
  });

  logger.info(`Premium sotib olindi: student=${studentId}, endDate=${endDate}`);

  const updatedUser = await prisma.user.findUnique({
    where: { id: studentId },
    include: { profileImage: true },
  });

  // Bot orqali xabar (asosiy oqimni bloklamaydi)
  notifyPremiumEvent(updatedUser, "purchased", {
    durationDays,
    expiresAt: endDate,
  });

  return updatedUser;
};

/**
 * Returns current premium status and latest subscription for a student.
 * @param {string} studentId
 * @returns {Promise<object>}
 */
const getPremiumStatus = async (studentId) => {
  const user = await prisma.user.findUnique({
    where: { id: studentId },
    select: {
      premiumIsActive: true,
      premiumExpiresAt: true,
      emojiBadgeId: true,
      displayName: true,
      nameColor: true,
      profileImage: true,
      coinBalance: true,
    },
  });
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");

  const latestPremium = await prisma.premium.findFirst({
    where: { student: studentId },
    orderBy: { createdAt: "desc" },
  });

  return { user, latestPremium };
};

/**
 * Returns available emojis for the emoji selector.
 * @returns {Promise<object[]>}
 */
const getAvailableEmojis = async () => {
  return prisma.emojiConfig.findMany({ orderBy: { createdAt: "desc" } });
};

/**
 * Uploads and sets profile picture for a premium student.
 * Replaces existing picture if any.
 * @param {string} studentId
 * @param {object} file - Multer file object with buffer and mimetype
 * @returns {Promise<object>} Updated user
 */
const uploadProfilePicture = async (studentId, file) => {
  const user = await prisma.user.findUnique({
    where: { id: studentId },
    include: { profileImage: true },
  });
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");
  if (!user.premiumIsActive) {
    throw new BadRequestError("Bu funksiya faqat MBSI Premium foydalanuvchilar uchun mavjud");
  }

  if (!file || !file.buffer) throw new ValidationError("Rasm fayli talab qilinadi");

  const { mimeType, extension, variants } = await uploadImageWithVariants({
    buffer: file.buffer,
    mimeType: file.mimetype,
  });

  // Delete old profile picture from S3 and DB
  if (user.profileImage) {
    try {
      await deleteImageVariants(user.profileImage.variants);
      await prisma.image.delete({ where: { id: user.profileImage.id } });
    } catch (err) {
      logger.warn(`Eski profil rasm o'chirishda xato: ${err.message}`);
    }
  }

  const image = await prisma.image.create({
    data: {
      originalName: file.originalname || `profile.${extension}`,
      mimeType,
      extension,
      originalSizeBytes: file.size || file.buffer.length,
      variants,
      uploadedBy: studentId,
    },
  });

  await prisma.user.update({
    where: { id: studentId },
    data: { profilePicture: image.id },
  });

  logger.info(`Profil rasm yuklandi: student=${studentId}, image=${image.id}`);

  return image;
};

/**
 * Deletes profile picture for a student.
 * @param {string} studentId
 * @returns {Promise<void>}
 */
const deleteProfilePicture = async (studentId) => {
  const user = await prisma.user.findUnique({
    where: { id: studentId },
    include: { profileImage: true },
  });
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");
  if (!user.premiumIsActive) {
    throw new BadRequestError("Bu funksiya faqat MBSI Premium foydalanuvchilar uchun mavjud");
  }
  if (!user.profileImage) throw new NotFoundError("Profil rasm mavjud emas");

  await deleteImageVariants(user.profileImage.variants);
  await prisma.image.delete({ where: { id: user.profileImage.id } });
  await prisma.user.update({
    where: { id: studentId },
    data: { profilePicture: null },
  });

  logger.info(`Profil rasm o'chirildi: student=${studentId}`);
};

/**
 * Sets the emoji badge for a premium student.
 * @param {string} studentId
 * @param {string} emojiId - EmojiConfig id
 * @returns {Promise<object>} Updated user
 */
const setEmojiBadge = async (studentId, emojiId) => {
  const user = await prisma.user.findUnique({ where: { id: studentId } });
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");
  if (!user.premiumIsActive) {
    throw new BadRequestError("Bu funksiya faqat MBSI Premium foydalanuvchilar uchun mavjud");
  }

  const emoji = emojiId
    ? await prisma.emojiConfig.findUnique({ where: { id: emojiId } })
    : null;
  if (!emoji) throw new NotFoundError("Emoji topilmadi");

  await prisma.user.update({
    where: { id: studentId },
    data: { emojiBadgeId: String(emoji.id) },
  });

  return prisma.user.findUnique({
    where: { id: studentId },
    include: { profileImage: true },
  });
};

/**
 * Sets a custom display name for a premium student.
 * @param {string} studentId
 * @param {string} displayName
 * @returns {Promise<object>} Updated user
 */
const setDisplayName = async (studentId, displayName) => {
  const user = await prisma.user.findUnique({ where: { id: studentId } });
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");
  if (!user.premiumIsActive) {
    throw new BadRequestError("Bu funksiya faqat MBSI Premium foydalanuvchilar uchun mavjud");
  }

  const trimmed = (displayName || "").trim();
  if (trimmed.length > 48) throw new ValidationError("Ko'rsatma ismi maksimal 48 ta belgidan iborat bo'lishi kerak");

  await prisma.user.update({
    where: { id: studentId },
    data: { displayName: trimmed || null },
  });

  return prisma.user.findUnique({
    where: { id: studentId },
    include: { profileImage: true },
  });
};

/**
 * Sets a name color for a premium student.
 * @param {string} studentId
 * @param {string|null} nameColor
 * @returns {Promise<object>} Updated user
 */
const setNameColor = async (studentId, nameColor) => {
  const user = await prisma.user.findUnique({ where: { id: studentId } });
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");
  if (!user.premiumIsActive) {
    throw new BadRequestError("Bu funksiya faqat MBSI Premium foydalanuvchilar uchun mavjud");
  }

  if (nameColor !== null && nameColor !== undefined && nameColor !== "") {
    const settings = await getPremiumSettings();
    const allowedKeys = settings.allowedNameColors
      .filter((c) => c.isActive)
      .map((c) => c.key);
    if (!allowedKeys.includes(nameColor)) {
      throw new ValidationError(`Noto'g'ri rang. Ruxsat etilganlar: ${allowedKeys.join(", ")}`);
    }
  }

  await prisma.user.update({
    where: { id: studentId },
    data: { nameColor: nameColor || null },
  });

  return prisma.user.findUnique({
    where: { id: studentId },
    include: { profileImage: true },
  });
};

// ─────────────────────────────────────────────────────────────────
// PUBLIC CONFIG
// ─────────────────────────────────────────────────────────────────

/**
 * Returns public premium config used by the student app
 * (price, duration, allowed name colors, whether premium is enabled).
 * @returns {Promise<object>}
 */
const getPremiumConfig = async () => {
  const settings = await getPremiumSettings();
  return {
    isEnabled: settings.isEnabled,
    coinCost: settings.coinCost,
    durationDays: settings.durationDays,
    allowedNameColors: settings.allowedNameColors.filter((c) => c.isActive),
  };
};

// ─────────────────────────────────────────────────────────────────
// ADMIN: SOZLAMALAR
// ─────────────────────────────────────────────────────────────────

/**
 * Returns the full premium settings (admin).
 * @returns {Promise<object>}
 */
const getSettings = async () => {
  return getPremiumSettings();
};

/**
 * Updates premium settings (admin).
 * @param {object} data - { isEnabled, coinCost, durationDays, allowedNameColors }
 * @param {string} updatedBy - admin user id
 * @returns {Promise<object>}
 */
const updateSettings = async (data, updatedBy) => {
  const current = await getPremiumSettings();

  const update = {};

  if (data.isEnabled !== undefined) update.isEnabled = !!data.isEnabled;
  if (data.coinCost !== undefined) update.coinCost = data.coinCost;
  if (data.durationDays !== undefined) update.durationDays = data.durationDays;

  if (Array.isArray(data.allowedNameColors)) {
    update.allowedNameColors = data.allowedNameColors.map((c) => ({
      key: String(c.key || "").trim(),
      label: String(c.label || "").trim(),
      hex: String(c.hex || "").trim(),
      isActive: c.isActive !== false,
    }));
  }

  update.updatedBy = updatedBy;

  const settings = await prisma.premiumSettings.update({
    where: { id: current.id },
    data: update,
  });

  logger.info(`Premium sozlamalari yangilandi: by=${updatedBy}`);
  return settings;
};

// ─────────────────────────────────────────────────────────────────
// ADMIN: OBUNALAR RO'YXATI VA HISOBOT
// ─────────────────────────────────────────────────────────────────

/**
 * Builds a Prisma filter for premium subscriptions from request query.
 * @param {object} query - { status, source, studentId }
 * @returns {object}
 */
const buildSubscriptionFilter = (query = {}) => {
  const filter = {};
  if (query.status && ["active", "expired", "revoked"].includes(query.status)) {
    filter.status = query.status;
  }
  if (query.source && ["purchase", "admin_grant"].includes(query.source)) {
    // Eski hujjatlarda source maydoni yo'q - ularni "purchase" deb hisoblaymiz
    filter.source =
      query.source === "purchase"
        ? { in: ["purchase", null] }
        : "admin_grant";
  }
  if (query.studentId) filter.student = query.studentId;
  return filter;
};

/**
 * scalar student/grantedBy ref'larni qo'lda yuklab, hujjatlarga biriktiradi.
 * @param {object[]} items
 * @returns {Promise<object[]>}
 */
const attachRefs = async (items) => {
  const studentIds = [...new Set(items.map((p) => p.student).filter(Boolean))];
  const granterIds = [...new Set(items.map((p) => p.grantedBy).filter(Boolean))];

  const [students, granters] = await Promise.all([
    studentIds.length
      ? prisma.user.findMany({
          where: { id: { in: studentIds } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            username: true,
            premiumIsActive: true,
            premiumExpiresAt: true,
          },
        })
      : [],
    granterIds.length
      ? prisma.user.findMany({
          where: { id: { in: granterIds } },
          select: { id: true, firstName: true, lastName: true, username: true },
        })
      : [],
  ]);

  const studentMap = new Map(students.map((s) => [s.id, s]));
  const granterMap = new Map(granters.map((g) => [g.id, g]));

  return items.map((p) => ({
    ...p,
    student: p.student ? studentMap.get(p.student) || null : null,
    grantedBy: p.grantedBy ? granterMap.get(p.grantedBy) || null : null,
  }));
};

/**
 * Paginated list of premium subscriptions (admin).
 * @param {object} req - Express request
 * @returns {Promise<object>} paginated response
 */
const getSubscriptions = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const filter = buildSubscriptionFilter(req.query);

  const [rows, total] = await Promise.all([
    prisma.premium.findMany({
      where: filter,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.premium.count({ where: filter }),
  ]);

  const items = await attachRefs(rows);

  return formatPaginationResponse(items, total, page, limit);
};

/**
 * Premium statistics for the admin report dashboard.
 * @returns {Promise<object>}
 */
const getStats = async () => {
  const now = new Date();
  const sevenDaysLater = new Date(now);
  sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
  thirtyDaysAgo.setHours(0, 0, 0, 0);

  const [
    activeCount,
    expiringSoon,
    totalSubscriptions,
    revenueAgg,
    bySource,
    dailyRaw,
  ] = await Promise.all([
    prisma.user.count({
      where: {
        premiumIsActive: true,
        premiumExpiresAt: { gt: now },
      },
    }),
    prisma.user.count({
      where: {
        premiumIsActive: true,
        premiumExpiresAt: { gt: now, lte: sevenDaysLater },
      },
    }),
    prisma.premium.count(),
    // Admin grantlar coinCost=0 bo'lgani uchun barcha coinCost yig'indisi =
    // o'quvchilar sotib olishga sarflagan jami tanga (eski hujjatlarga ham mos)
    prisma.premium.aggregate({ _sum: { coinCost: true } }),
    prisma.premium.groupBy({
      by: ["source"],
      _count: { _all: true },
    }),
    // Kunlik trend (time-series) — raw SQL bilan sana bo'yicha guruhlash
    prisma.$queryRaw`
      SELECT
        EXTRACT(YEAR FROM created_at)::int  AS year,
        EXTRACT(MONTH FROM created_at)::int AS month,
        EXTRACT(DAY FROM created_at)::int   AS day,
        COUNT(*)::int                       AS count,
        COALESCE(SUM(coin_cost), 0)::int    AS revenue
      FROM premiums
      WHERE created_at >= ${thirtyDaysAgo}
      GROUP BY year, month, day
      ORDER BY year, month, day
    `,
  ]);

  // So'nggi 30 kun uchun to'liq kunlik massiv
  const dailyTrend = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(thirtyDaysAgo);
    d.setDate(d.getDate() + i);
    const entry = dailyRaw.find(
      (e) =>
        e.year === d.getFullYear() &&
        e.month === d.getMonth() + 1 &&
        e.day === d.getDate(),
    );
    dailyTrend.push({
      date: d.toISOString().split("T")[0],
      count: entry?.count || 0,
      revenue: entry?.revenue || 0,
    });
  }

  // source NULL bo'lgan eski hujjatlarni "purchase" deb hisoblaymiz
  const purchaseCount = bySource
    .filter((s) => s.source === "purchase" || s.source == null)
    .reduce((sum, s) => sum + s._count._all, 0);
  const grantCount =
    bySource.find((s) => s.source === "admin_grant")?._count._all || 0;

  return {
    activeCount,
    expiringSoon,
    totalSubscriptions,
    totalRevenue: revenueAgg._sum.coinCost || 0,
    purchaseCount,
    grantCount,
    dailyTrend,
  };
};

/**
 * Returns flat rows for the subscriptions Excel export (admin).
 * @param {object} req - Express request (uses query for filtering)
 * @returns {Promise<object[]>}
 */
const getSubscriptionsForExport = async (req) => {
  const filter = buildSubscriptionFilter(req.query);
  const rows = await prisma.premium.findMany({
    where: filter,
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  const items = await attachRefs(rows);

  return items.map((p) => {
    const student = p.student;
    const fullName = student
      ? `${student.firstName || ""} ${student.lastName || ""}`.trim()
      : "-";
    const grantedBy = p.grantedBy
      ? `${p.grantedBy.firstName || ""} ${p.grantedBy.lastName || ""}`.trim()
      : "-";
    const statusLabel =
      p.status === "active" ? "Faol" : p.status === "revoked" ? "Bekor qilingan" : "Tugagan";
    return {
      fullName,
      username: student?.username || "-",
      source: p.source === "admin_grant" ? "Admin bergan" : "Sotib olgan",
      coinCost: p.coinCost,
      durationDays: p.durationDays,
      startDate: p.startDate,
      endDate: p.endDate,
      status: statusLabel,
      grantedBy,
    };
  });
};

// ─────────────────────────────────────────────────────────────────
// ADMIN: QO'LDA BERISH / BEKOR QILISH
// ─────────────────────────────────────────────────────────────────

/**
 * Manually grants premium to a student without charging coins (admin).
 * Extends from current expiry if already active.
 * @param {string} studentId
 * @param {number} durationDays
 * @param {string} adminId
 * @returns {Promise<object>} updated user
 */
const grantPremium = async (studentId, durationDays, adminId) => {
  const settings = await getPremiumSettings();
  const days = Number(durationDays) > 0 ? Number(durationDays) : settings.durationDays;

  const user = await prisma.user.findUnique({ where: { id: studentId } });
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");

  const now = new Date();
  const baseDate =
    user.premiumIsActive && user.premiumExpiresAt > now
      ? new Date(user.premiumExpiresAt)
      : now;

  const endDate = new Date(baseDate);
  endDate.setDate(endDate.getDate() + days);

  await prisma.premium.create({
    data: {
      student: studentId,
      durationDays: days,
      coinCost: 0,
      startDate: now,
      endDate,
      status: "active",
      coinBalanceAfter: user.coinBalance ?? 0,
      source: "admin_grant",
      grantedBy: adminId,
    },
  });

  await prisma.user.update({
    where: { id: studentId },
    data: {
      premiumIsActive: true,
      premiumExpiresAt: endDate,
    },
  });

  logger.info(`Premium qo'lda berildi: student=${studentId}, by=${adminId}, endDate=${endDate}`);

  const updatedUser = await prisma.user.findUnique({
    where: { id: studentId },
    include: { profileImage: true },
  });

  // Bot orqali xabar
  notifyPremiumEvent(updatedUser, "granted", { durationDays: days, expiresAt: endDate });

  return updatedUser;
};

/**
 * Revokes a student's premium immediately (admin).
 * @param {string} studentId
 * @param {string} adminId
 * @returns {Promise<object>} updated user
 */
const revokePremium = async (studentId, adminId) => {
  const user = await prisma.user.findUnique({ where: { id: studentId } });
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");
  if (!user.premiumIsActive) {
    throw new BadRequestError("Foydalanuvchida faol premium mavjud emas");
  }

  await prisma.user.update({
    where: { id: studentId },
    data: {
      premiumIsActive: false,
      premiumExpiresAt: null,
    },
  });

  await prisma.premium.updateMany({
    where: { student: studentId, status: "active" },
    data: { status: "revoked", grantedBy: adminId },
  });

  logger.info(`Premium bekor qilindi: student=${studentId}, by=${adminId}`);

  const updatedUser = await prisma.user.findUnique({
    where: { id: studentId },
    include: { profileImage: true },
  });

  // Bot orqali xabar
  notifyPremiumEvent(updatedUser, "revoked");

  return updatedUser;
};

// ─────────────────────────────────────────────────────────────────
// ADMIN: EMOJI BADGE BOSHQARUVI
// ─────────────────────────────────────────────────────────────────

/**
 * Returns all emoji configs (admin).
 * @returns {Promise<object[]>}
 */
const getAllEmojis = async () => {
  return prisma.emojiConfig.findMany({ orderBy: { createdAt: "desc" } });
};

/**
 * Validates and uploads a lottie .json file to S3.
 * @param {object} file - Multer file object (buffer, originalname)
 * @returns {Promise<{url:string,key:string}>}
 */
const uploadEmojiFile = async (file) => {
  if (!file || !file.buffer) throw new ValidationError("Lottie (.json) fayl talab qilinadi");

  // Lottie JSON tekshiruvi
  let parsed;
  try {
    parsed = JSON.parse(file.buffer.toString("utf-8"));
  } catch {
    throw new ValidationError("Fayl yaroqli JSON emas");
  }
  if (!parsed || typeof parsed !== "object" || (!parsed.layers && parsed.v === undefined)) {
    throw new ValidationError("Fayl yaroqli lottie animatsiyasi emas");
  }

  const objectId = crypto.randomUUID();
  const rootPath = `lottie/${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  const key = `${rootPath}/${objectId}.json`;

  const { url } = await fileStorageService.uploadBuffer({
    key,
    buffer: file.buffer,
    contentType: "application/json",
  });

  return { url, key };
};

/**
 * Creates an emoji config from an uploaded lottie file (admin).
 * @param {object} data - { name }
 * @param {object} file - Multer file (lottie .json)
 * @returns {Promise<object>}
 */
const createEmoji = async (data, file) => {
  const name = String(data.name || "").trim();
  if (!name) throw new ValidationError("Emoji nomi majburiy");

  const { url, key } = await uploadEmojiFile(file);

  return prisma.emojiConfig.create({
    data: { name, animationUrl: url, fileKey: key },
  });
};

/**
 * Updates an emoji config (admin). Optionally replaces the lottie file.
 * @param {string} id
 * @param {object} data - { name }
 * @param {object} [file] - New lottie .json file (optional)
 * @returns {Promise<object>}
 */
const updateEmoji = async (id, data, file) => {
  const emoji = await prisma.emojiConfig.findUnique({ where: { id } });
  if (!emoji) throw new NotFoundError("Emoji topilmadi");

  const update = {};

  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw new ValidationError("Emoji nomi bo'sh bo'lishi mumkin emas");
    update.name = name;
  }

  if (file && file.buffer) {
    const oldKey = emoji.fileKey;
    const { url, key } = await uploadEmojiFile(file);
    update.animationUrl = url;
    update.fileKey = key;
    // Eski faylni o'chirish (xatosi jarayonni to'xtatmaydi)
    try {
      await fileStorageService.deleteObject(oldKey);
    } catch (err) {
      logger.warn(`Eski emoji fayl o'chirishda xato: ${err.message}`);
    }
  }

  return prisma.emojiConfig.update({ where: { id }, data: update });
};

/**
 * Deletes an emoji config and its S3 file (admin).
 * @param {string} id
 * @returns {Promise<void>}
 */
const deleteEmoji = async (id) => {
  const emoji = await prisma.emojiConfig.findUnique({ where: { id } });
  if (!emoji) throw new NotFoundError("Emoji topilmadi");

  try {
    await fileStorageService.deleteObject(emoji.fileKey);
  } catch (err) {
    logger.warn(`Emoji fayl o'chirishda xato: ${err.message}`);
  }

  await prisma.emojiConfig.delete({ where: { id } });
};

module.exports = {
  purchasePremium,
  getPremiumStatus,
  getAvailableEmojis,
  uploadProfilePicture,
  deleteProfilePicture,
  setEmojiBadge,
  setDisplayName,
  setNameColor,
  // public config
  getPremiumConfig,
  // admin
  getSettings,
  updateSettings,
  getSubscriptions,
  getStats,
  getSubscriptionsForExport,
  grantPremium,
  revokePremium,
  getAllEmojis,
  createEmoji,
  updateEmoji,
  deleteEmoji,
};
