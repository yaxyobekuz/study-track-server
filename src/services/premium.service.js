const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/user.model");
const Image = require("../models/image.model");
const Premium = require("../models/premium.model");
const EmojiConfig = require("../models/emojiConfig.model");
const PremiumSettings = require("../models/premiumSettings.model");
const CoinTransaction = require("../models/coinTransaction.model");
const { uploadImageWithVariants, deleteImageVariants } = require("./image.service");
const fileStorageService = require("./fileStorage.service");
const { notifyPremiumEvent } = require("./premiumNotification.service");
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
  const settings = await PremiumSettings.getSettings();

  if (!settings.isEnabled) {
    throw new BadRequestError("MBSI Premium hozircha mavjud emas");
  }

  const cost = settings.coinCost;
  const durationDays = settings.durationDays;

  const user = await User.findOneAndUpdate(
    { _id: studentId, coinBalance: { $gte: cost } },
    { $inc: { coinBalance: -cost } },
    { new: true }
  );

  if (!user) {
    const exists = await User.exists({ _id: studentId });
    if (!exists) throw new NotFoundError("Foydalanuvchi topilmadi");
    throw new BadRequestError(`Tangalar yetarli emas. Premium uchun kamida ${cost} tanga kerak`);
  }

  const now = new Date();
  const baseDate = user.premium?.isActive && user.premium?.expiresAt > now
    ? new Date(user.premium.expiresAt)
    : now;

  const endDate = new Date(baseDate);
  endDate.setDate(endDate.getDate() + durationDays);

  const premium = await Premium.create({
    student: studentId,
    durationDays,
    coinCost: cost,
    startDate: now,
    endDate,
    status: "active",
    coinBalanceAfter: user.coinBalance,
    source: "purchase",
  });

  await User.findByIdAndUpdate(studentId, {
    "premium.isActive": true,
    "premium.expiresAt": endDate,
  });

  await CoinTransaction.create({
    student: studentId,
    amount: cost,
    type: "premium_purchase",
    description: `MBSI Premium - ${durationDays} kunlik obuna`,
    balanceAfter: user.coinBalance,
    date: now,
    meta: { premiumId: premium._id },
  });

  logger.info(`Premium sotib olindi: student=${studentId}, endDate=${endDate}`);

  const updatedUser = await User.findById(studentId).populate("profilePicture");

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
  const user = await User.findById(studentId).populate("profilePicture").select(
    "premium emojiBadgeId displayName nameColor profilePicture coinBalance"
  );
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");

  const latestPremium = await Premium.findOne({ student: studentId }).sort({ createdAt: -1 });

  return { user, latestPremium };
};

/**
 * Returns available emojis for the emoji selector.
 * @returns {Promise<object[]>}
 */
const getAvailableEmojis = async () => {
  return EmojiConfig.find().sort({ createdAt: -1 });
};

/**
 * Uploads and sets profile picture for a premium student.
 * Replaces existing picture if any.
 * @param {string} studentId
 * @param {object} file - Multer file object with buffer and mimetype
 * @returns {Promise<object>} Updated user
 */
const uploadProfilePicture = async (studentId, file) => {
  const user = await User.findById(studentId).populate("profilePicture");
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");
  if (!user.premium?.isActive) {
    throw new BadRequestError("Bu funksiya faqat MBSI Premium foydalanuvchilar uchun mavjud");
  }

  if (!file || !file.buffer) throw new ValidationError("Rasm fayli talab qilinadi");

  const { mimeType, extension, variants } = await uploadImageWithVariants({
    buffer: file.buffer,
    mimeType: file.mimetype,
  });

  // Delete old profile picture from S3 and DB
  if (user.profilePicture) {
    try {
      await deleteImageVariants(user.profilePicture.variants);
      await Image.findByIdAndDelete(user.profilePicture._id);
    } catch (err) {
      logger.warn(`Eski profil rasm o'chirishda xato: ${err.message}`);
    }
  }

  const image = await Image.create({
    originalName: file.originalname || `profile.${extension}`,
    mimeType,
    extension,
    originalSizeBytes: file.size || file.buffer.length,
    variants,
    uploadedBy: studentId,
  });

  await User.findByIdAndUpdate(studentId, { profilePicture: image._id });

  logger.info(`Profil rasm yuklandi: student=${studentId}, image=${image._id}`);

  return image;
};

/**
 * Deletes profile picture for a student.
 * @param {string} studentId
 * @returns {Promise<void>}
 */
const deleteProfilePicture = async (studentId) => {
  const user = await User.findById(studentId).populate("profilePicture");
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");
  if (!user.premium?.isActive) {
    throw new BadRequestError("Bu funksiya faqat MBSI Premium foydalanuvchilar uchun mavjud");
  }
  if (!user.profilePicture) throw new NotFoundError("Profil rasm mavjud emas");

  await deleteImageVariants(user.profilePicture.variants);
  await Image.findByIdAndDelete(user.profilePicture._id);
  await User.findByIdAndUpdate(studentId, { profilePicture: null });

  logger.info(`Profil rasm o'chirildi: student=${studentId}`);
};

/**
 * Sets the emoji badge for a premium student.
 * @param {string} studentId
 * @param {string} emojiId - EmojiConfig _id
 * @returns {Promise<object>} Updated user
 */
const setEmojiBadge = async (studentId, emojiId) => {
  const user = await User.findById(studentId);
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");
  if (!user.premium?.isActive) {
    throw new BadRequestError("Bu funksiya faqat MBSI Premium foydalanuvchilar uchun mavjud");
  }

  if (!mongoose.isValidObjectId(emojiId)) {
    throw new ValidationError("Noto'g'ri emoji tanlandi");
  }

  const emoji = await EmojiConfig.findById(emojiId);
  if (!emoji) throw new NotFoundError("Emoji topilmadi");

  await User.findByIdAndUpdate(studentId, { emojiBadgeId: String(emoji._id) });

  return User.findById(studentId).populate("profilePicture");
};

/**
 * Sets a custom display name for a premium student.
 * @param {string} studentId
 * @param {string} displayName
 * @returns {Promise<object>} Updated user
 */
const setDisplayName = async (studentId, displayName) => {
  const user = await User.findById(studentId);
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");
  if (!user.premium?.isActive) {
    throw new BadRequestError("Bu funksiya faqat MBSI Premium foydalanuvchilar uchun mavjud");
  }

  const trimmed = (displayName || "").trim();
  if (trimmed.length > 48) throw new ValidationError("Ko'rsatma ismi maksimal 48 ta belgidan iborat bo'lishi kerak");

  await User.findByIdAndUpdate(studentId, { displayName: trimmed || null });

  return User.findById(studentId).populate("profilePicture");
};

/**
 * Sets a name color for a premium student.
 * @param {string} studentId
 * @param {string|null} nameColor
 * @returns {Promise<object>} Updated user
 */
const setNameColor = async (studentId, nameColor) => {
  const user = await User.findById(studentId);
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");
  if (!user.premium?.isActive) {
    throw new BadRequestError("Bu funksiya faqat MBSI Premium foydalanuvchilar uchun mavjud");
  }

  if (nameColor !== null && nameColor !== undefined && nameColor !== "") {
    const settings = await PremiumSettings.getSettings();
    const allowedKeys = settings.allowedNameColors
      .filter((c) => c.isActive)
      .map((c) => c.key);
    if (!allowedKeys.includes(nameColor)) {
      throw new ValidationError(`Noto'g'ri rang. Ruxsat etilganlar: ${allowedKeys.join(", ")}`);
    }
  }

  await User.findByIdAndUpdate(studentId, { nameColor: nameColor || null });

  return User.findById(studentId).populate("profilePicture");
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
  const settings = await PremiumSettings.getSettings();
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
 * @returns {Promise<Document>}
 */
const getSettings = async () => {
  return PremiumSettings.getSettings();
};

/**
 * Updates premium settings (admin).
 * @param {object} data - { isEnabled, coinCost, durationDays, allowedNameColors }
 * @param {string} updatedBy - admin user id
 * @returns {Promise<Document>}
 */
const updateSettings = async (data, updatedBy) => {
  const settings = await PremiumSettings.getSettings();

  if (data.isEnabled !== undefined) settings.isEnabled = !!data.isEnabled;
  if (data.coinCost !== undefined) settings.coinCost = data.coinCost;
  if (data.durationDays !== undefined) settings.durationDays = data.durationDays;

  if (Array.isArray(data.allowedNameColors)) {
    settings.allowedNameColors = data.allowedNameColors.map((c) => ({
      key: String(c.key || "").trim(),
      label: String(c.label || "").trim(),
      hex: String(c.hex || "").trim(),
      isActive: c.isActive !== false,
    }));
  }

  settings.updatedBy = updatedBy;
  await settings.save();

  logger.info(`Premium sozlamalari yangilandi: by=${updatedBy}`);
  return settings;
};

// ─────────────────────────────────────────────────────────────────
// ADMIN: OBUNALAR RO'YXATI VA HISOBOT
// ─────────────────────────────────────────────────────────────────

/**
 * Builds a Mongo filter for premium subscriptions from request query.
 * @param {object} query - { status, source, studentId }
 * @returns {object}
 */
const buildSubscriptionFilter = (query = {}) => {
  const filter = {};
  if (query.status && ["active", "expired", "revoked"].includes(query.status)) {
    filter.status = query.status;
  }
  if (query.source && ["purchase", "admin_grant"].includes(query.source)) {
    // Eski hujjatlarda source maydoni yo'q — ularni "purchase" deb hisoblaymiz
    filter.source =
      query.source === "purchase"
        ? { $in: ["purchase", null] }
        : "admin_grant";
  }
  if (query.studentId) filter.student = query.studentId;
  return filter;
};

/**
 * Paginated list of premium subscriptions (admin).
 * @param {object} req - Express request
 * @returns {Promise<object>} paginated response
 */
const getSubscriptions = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const filter = buildSubscriptionFilter(req.query);

  const [items, total] = await Promise.all([
    Premium.find(filter)
      .populate("student", "firstName lastName username premium")
      .populate("grantedBy", "firstName lastName username")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Premium.countDocuments(filter),
  ]);

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
    User.countDocuments({
      "premium.isActive": true,
      "premium.expiresAt": { $gt: now },
    }),
    User.countDocuments({
      "premium.isActive": true,
      "premium.expiresAt": { $gt: now, $lte: sevenDaysLater },
    }),
    Premium.countDocuments({}),
    // Admin grantlar coinCost=0 bo'lgani uchun barcha coinCost yig'indisi =
    // o'quvchilar sotib olishga sarflagan jami tanga (eski hujjatlarga ham mos)
    Premium.aggregate([
      { $group: { _id: null, total: { $sum: "$coinCost" } } },
    ]),
    Premium.aggregate([
      {
        $group: {
          _id: { $ifNull: ["$source", "purchase"] },
          count: { $sum: 1 },
        },
      },
    ]),
    Premium.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
            day: { $dayOfMonth: "$createdAt" },
          },
          count: { $sum: 1 },
          revenue: { $sum: "$coinCost" },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]),
  ]);

  // So'nggi 30 kun uchun to'liq kunlik massiv
  const dailyTrend = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(thirtyDaysAgo);
    d.setDate(d.getDate() + i);
    const entry = dailyRaw.find(
      (e) =>
        e._id.year === d.getFullYear() &&
        e._id.month === d.getMonth() + 1 &&
        e._id.day === d.getDate(),
    );
    dailyTrend.push({
      date: d.toISOString().split("T")[0],
      count: entry?.count || 0,
      revenue: entry?.revenue || 0,
    });
  }

  const purchaseCount = bySource.find((s) => s._id === "purchase")?.count || 0;
  const grantCount = bySource.find((s) => s._id === "admin_grant")?.count || 0;

  return {
    activeCount,
    expiringSoon,
    totalSubscriptions,
    totalRevenue: revenueAgg[0]?.total || 0,
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
  const items = await Premium.find(filter)
    .populate("student", "firstName lastName username")
    .populate("grantedBy", "firstName lastName username")
    .sort({ createdAt: -1 })
    .limit(5000);

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
  const settings = await PremiumSettings.getSettings();
  const days = Number(durationDays) > 0 ? Number(durationDays) : settings.durationDays;

  const user = await User.findById(studentId);
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");

  const now = new Date();
  const baseDate =
    user.premium?.isActive && user.premium?.expiresAt > now
      ? new Date(user.premium.expiresAt)
      : now;

  const endDate = new Date(baseDate);
  endDate.setDate(endDate.getDate() + days);

  await Premium.create({
    student: studentId,
    durationDays: days,
    coinCost: 0,
    startDate: now,
    endDate,
    status: "active",
    coinBalanceAfter: user.coinBalance ?? 0,
    source: "admin_grant",
    grantedBy: adminId,
  });

  await User.findByIdAndUpdate(studentId, {
    "premium.isActive": true,
    "premium.expiresAt": endDate,
  });

  logger.info(`Premium qo'lda berildi: student=${studentId}, by=${adminId}, endDate=${endDate}`);

  const updatedUser = await User.findById(studentId).populate("profilePicture");

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
  const user = await User.findById(studentId);
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");
  if (!user.premium?.isActive) {
    throw new BadRequestError("Foydalanuvchida faol premium mavjud emas");
  }

  await User.findByIdAndUpdate(studentId, {
    "premium.isActive": false,
    "premium.expiresAt": null,
  });

  await Premium.updateMany(
    { student: studentId, status: "active" },
    { status: "revoked", grantedBy: adminId },
  );

  logger.info(`Premium bekor qilindi: student=${studentId}, by=${adminId}`);

  const updatedUser = await User.findById(studentId).populate("profilePicture");

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
  return EmojiConfig.find().sort({ createdAt: -1 });
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
 * @returns {Promise<Document>}
 */
const createEmoji = async (data, file) => {
  const name = String(data.name || "").trim();
  if (!name) throw new ValidationError("Emoji nomi majburiy");

  const { url, key } = await uploadEmojiFile(file);

  return EmojiConfig.create({ name, animationUrl: url, fileKey: key });
};

/**
 * Updates an emoji config (admin). Optionally replaces the lottie file.
 * @param {string} id
 * @param {object} data - { name }
 * @param {object} [file] - New lottie .json file (optional)
 * @returns {Promise<Document>}
 */
const updateEmoji = async (id, data, file) => {
  const emoji = await EmojiConfig.findById(id);
  if (!emoji) throw new NotFoundError("Emoji topilmadi");

  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw new ValidationError("Emoji nomi bo'sh bo'lishi mumkin emas");
    emoji.name = name;
  }

  if (file && file.buffer) {
    const oldKey = emoji.fileKey;
    const { url, key } = await uploadEmojiFile(file);
    emoji.animationUrl = url;
    emoji.fileKey = key;
    // Eski faylni o'chirish (xatosi jarayonni to'xtatmaydi)
    try {
      await fileStorageService.deleteObject(oldKey);
    } catch (err) {
      logger.warn(`Eski emoji fayl o'chirishda xato: ${err.message}`);
    }
  }

  await emoji.save();
  return emoji;
};

/**
 * Deletes an emoji config and its S3 file (admin).
 * @param {string} id
 * @returns {Promise<void>}
 */
const deleteEmoji = async (id) => {
  const emoji = await EmojiConfig.findById(id);
  if (!emoji) throw new NotFoundError("Emoji topilmadi");

  try {
    await fileStorageService.deleteObject(emoji.fileKey);
  } catch (err) {
    logger.warn(`Emoji fayl o'chirishda xato: ${err.message}`);
  }

  await EmojiConfig.findByIdAndDelete(id);
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
