const User = require("../models/user.model");
const Image = require("../models/image.model");
const Premium = require("../models/premium.model");
const EmojiConfig = require("../models/emojiConfig.model");
const CoinTransaction = require("../models/coinTransaction.model");
const { uploadImageWithVariants, deleteImageVariants } = require("./image.service");
const { ValidationError, NotFoundError, BadRequestError } = require("../utils/errors");
const logger = require("../utils/logger");

const PREMIUM_COST = 100;
const PREMIUM_DURATION_DAYS = 30;
const ALLOWED_NAME_COLORS = ["blue", "purple", "green", "gold", "red", "pink"];

/**
 * Buys 1 month premium for a student.
 * If already active, extends from current expiresAt.
 * @param {string} studentId
 * @returns {Promise<object>} Updated user
 */
const purchasePremium = async (studentId) => {
  const user = await User.findOneAndUpdate(
    { _id: studentId, coinBalance: { $gte: PREMIUM_COST } },
    { $inc: { coinBalance: -PREMIUM_COST } },
    { new: true }
  );

  if (!user) {
    const exists = await User.exists({ _id: studentId });
    if (!exists) throw new NotFoundError("Foydalanuvchi topilmadi");
    throw new BadRequestError("Tangalar yetarli emas. Premium uchun kamida 100 tanga kerak");
  }

  const now = new Date();
  const baseDate = user.premium?.isActive && user.premium?.expiresAt > now
    ? new Date(user.premium.expiresAt)
    : now;

  const endDate = new Date(baseDate);
  endDate.setDate(endDate.getDate() + PREMIUM_DURATION_DAYS);

  const premium = await Premium.create({
    student: studentId,
    durationDays: PREMIUM_DURATION_DAYS,
    coinCost: PREMIUM_COST,
    startDate: now,
    endDate,
    status: "active",
    coinBalanceAfter: user.coinBalance,
  });

  await User.findByIdAndUpdate(studentId, {
    "premium.isActive": true,
    "premium.expiresAt": endDate,
  });

  await CoinTransaction.create({
    student: studentId,
    amount: PREMIUM_COST,
    type: "premium_purchase",
    description: "MBSI Premium - 30 kunlik obuna",
    balanceAfter: user.coinBalance,
    date: now,
    meta: { premiumId: premium._id },
  });

  logger.info(`Premium sotib olindi: student=${studentId}, endDate=${endDate}`);

  const updatedUser = await User.findById(studentId).populate("profilePicture");
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
 * Returns available (active) emojis for the emoji selector.
 * @returns {Promise<object[]>}
 */
const getAvailableEmojis = async () => {
  return EmojiConfig.find({ isActive: true }).sort({ sortOrder: 1, emojiId: 1 });
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
 * @param {number} emojiId
 * @returns {Promise<object>} Updated user
 */
const setEmojiBadge = async (studentId, emojiId) => {
  const user = await User.findById(studentId);
  if (!user) throw new NotFoundError("Foydalanuvchi topilmadi");
  if (!user.premium?.isActive) {
    throw new BadRequestError("Bu funksiya faqat MBSI Premium foydalanuvchilar uchun mavjud");
  }

  const emoji = await EmojiConfig.findOne({ emojiId, isActive: true });
  if (!emoji) throw new NotFoundError("Emoji topilmadi yoki faol emas");

  await User.findByIdAndUpdate(studentId, { emojiBadgeId: emojiId });

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
    if (!ALLOWED_NAME_COLORS.includes(nameColor)) {
      throw new ValidationError(`Noto'g'ri rang. Ruxsat etilganlar: ${ALLOWED_NAME_COLORS.join(", ")}`);
    }
  }

  await User.findByIdAndUpdate(studentId, { nameColor: nameColor || null });

  return User.findById(studentId).populate("profilePicture");
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
  PREMIUM_COST,
  PREMIUM_DURATION_DAYS,
};
