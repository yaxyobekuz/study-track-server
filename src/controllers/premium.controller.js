const asyncHandler = require("../middleware/async.middleware");
const premiumService = require("../services/premium.service");
const ExcelService = require("../services/excel.service");
const { BadRequestError } = require("../utils/errors");

/**
 * @route  POST /api/premium/buy
 * @access Student
 */
const buyPremium = asyncHandler(async (req, res) => {
  const user = await premiumService.purchasePremium(req.user.id);

  res.status(200).json({
    success: true,
    message: "MBSI Premium muvaffaqiyatli faollashtirildi!",
    data: user,
  });
});

/**
 * @route  GET /api/premium/status
 * @access Student
 */
const getMyPremiumStatus = asyncHandler(async (req, res) => {
  const { user, latestPremium } = await premiumService.getPremiumStatus(req.user.id);

  res.status(200).json({
    success: true,
    data: { user, latestPremium },
  });
});

/**
 * @route  GET /api/premium/emojis
 * @access Student
 */
const getAvailableEmojis = asyncHandler(async (req, res) => {
  const emojis = await premiumService.getAvailableEmojis();

  res.status(200).json({
    success: true,
    data: emojis,
  });
});

/**
 * @route  POST /api/premium/profile-picture
 * @access Student
 */
const uploadMyProfilePicture = asyncHandler(async (req, res) => {
  const image = await premiumService.uploadProfilePicture(req.user.id, req.file);

  res.status(200).json({
    success: true,
    message: "Profil rasm muvaffaqiyatli yuklandi",
    data: image,
  });
});

/**
 * @route  DELETE /api/premium/profile-picture
 * @access Student
 */
const deleteMyProfilePicture = asyncHandler(async (req, res) => {
  await premiumService.deleteProfilePicture(req.user.id);

  res.status(200).json({
    success: true,
    message: "Profil rasm o'chirildi",
  });
});

/**
 * @route  PUT /api/premium/emoji-badge
 * @access Student
 */
const setMyEmojiBadge = asyncHandler(async (req, res) => {
  const { emojiId } = req.body;
  const user = await premiumService.setEmojiBadge(req.user.id, emojiId);

  res.status(200).json({
    success: true,
    message: "Emoji badge o'rnatildi",
    data: user,
  });
});

/**
 * @route  PUT /api/premium/display-name
 * @access Student
 */
const setMyDisplayName = asyncHandler(async (req, res) => {
  const { displayName } = req.body;
  const user = await premiumService.setDisplayName(req.user.id, displayName);

  res.status(200).json({
    success: true,
    message: "Ko'rsatma ism o'rnatildi",
    data: user,
  });
});

/**
 * @route  PUT /api/premium/name-color
 * @access Student
 */
const setMyNameColor = asyncHandler(async (req, res) => {
  const { nameColor } = req.body;
  const user = await premiumService.setNameColor(req.user.id, nameColor);

  res.status(200).json({
    success: true,
    message: "Ism rangi o'rnatildi",
    data: user,
  });
});

// ─────────────────────────────────────────────────────────────────
// PUBLIC CONFIG
// ─────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/premium/config
 * @access Authenticated
 */
const getConfig = asyncHandler(async (req, res) => {
  const config = await premiumService.getPremiumConfig();
  res.status(200).json({ success: true, data: config });
});

// ─────────────────────────────────────────────────────────────────
// ADMIN: SOZLAMALAR
// ─────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/premium/admin/settings
 * @access Owner
 */
const getSettings = asyncHandler(async (req, res) => {
  const settings = await premiumService.getSettings();
  res.status(200).json({ success: true, data: settings });
});

/**
 * @route  PUT /api/premium/admin/settings
 * @access Owner
 */
const updateSettings = asyncHandler(async (req, res) => {
  const { isEnabled, coinCost, durationDays, allowedNameColors } = req.body;

  if (coinCost !== undefined && (typeof coinCost !== "number" || coinCost < 0)) {
    throw new BadRequestError("Narx manfiy bo'lishi mumkin emas");
  }
  if (durationDays !== undefined && (typeof durationDays !== "number" || durationDays < 1)) {
    throw new BadRequestError("Muddat kamida 1 kun bo'lishi kerak");
  }
  if (allowedNameColors !== undefined) {
    if (!Array.isArray(allowedNameColors)) {
      throw new BadRequestError("allowedNameColors massiv bo'lishi kerak");
    }
    for (const c of allowedNameColors) {
      if (!c || !c.key || !c.label || !c.hex) {
        throw new BadRequestError("Har bir rang uchun key, label va hex majburiy");
      }
    }
  }

  const settings = await premiumService.updateSettings(
    { isEnabled, coinCost, durationDays, allowedNameColors },
    req.user.id,
  );
  res.status(200).json({ success: true, message: "Sozlamalar saqlandi", data: settings });
});

// ─────────────────────────────────────────────────────────────────
// ADMIN: HISOBOT
// ─────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/premium/admin/stats
 * @access Owner
 */
const getStats = asyncHandler(async (req, res) => {
  const stats = await premiumService.getStats();
  res.status(200).json({ success: true, data: stats });
});

/**
 * @route  GET /api/premium/admin/subscriptions
 * @access Owner
 */
const getSubscriptions = asyncHandler(async (req, res) => {
  const result = await premiumService.getSubscriptions(req);
  res.status(200).json(result);
});

/**
 * @route  GET /api/premium/admin/subscriptions/export
 * @access Owner
 */
const exportSubscriptions = asyncHandler(async (req, res) => {
  const rows = await premiumService.getSubscriptionsForExport(req);

  const data = rows.map((r) => ({
    ...r,
    startDate: r.startDate ? new Date(r.startDate).toLocaleDateString("uz-UZ") : "-",
    endDate: r.endDate ? new Date(r.endDate).toLocaleDateString("uz-UZ") : "-",
  }));

  const workbook = ExcelService.createExcel({
    sheetName: "Premium obunalar",
    columns: [
      { header: "O'quvchi", key: "fullName", width: 30 },
      { header: "Login", key: "username", width: 20 },
      { header: "Manba", key: "source", width: 16 },
      { header: "Narx (tanga)", key: "coinCost", width: 14 },
      { header: "Muddat (kun)", key: "durationDays", width: 14 },
      { header: "Boshlanish", key: "startDate", width: 16 },
      { header: "Tugash", key: "endDate", width: 16 },
      { header: "Holat", key: "status", width: 16 },
      { header: "Bergan admin", key: "grantedBy", width: 24 },
    ],
    data,
    headerStyle: { bgColor: ExcelService.COLORS.HEADER_PURPLE },
  });

  const filename = ExcelService.generateFileName("premium_obunalar");
  await ExcelService.sendWorkbook(res, workbook, filename);
});

// ─────────────────────────────────────────────────────────────────
// ADMIN: QO'LDA BERISH / BEKOR QILISH
// ─────────────────────────────────────────────────────────────────

/**
 * @route  POST /api/premium/admin/grant
 * @access Owner
 */
const grantPremium = asyncHandler(async (req, res) => {
  const { studentId, durationDays } = req.body;
  if (!studentId) throw new BadRequestError("O'quvchi IDsi majburiy");

  const user = await premiumService.grantPremium(studentId, durationDays, req.user.id);
  res.status(200).json({ success: true, message: "Premium berildi", data: user });
});

/**
 * @route  POST /api/premium/admin/revoke
 * @access Owner
 */
const revokePremium = asyncHandler(async (req, res) => {
  const { studentId } = req.body;
  if (!studentId) throw new BadRequestError("O'quvchi IDsi majburiy");

  const user = await premiumService.revokePremium(studentId, req.user.id);
  res.status(200).json({ success: true, message: "Premium bekor qilindi", data: user });
});

// ─────────────────────────────────────────────────────────────────
// ADMIN: EMOJI BOSHQARUVI
// ─────────────────────────────────────────────────────────────────

/**
 * @route  GET /api/premium/admin/emojis
 * @access Owner
 */
const getAllEmojis = asyncHandler(async (req, res) => {
  const emojis = await premiumService.getAllEmojis();
  res.status(200).json({ success: true, data: emojis });
});

/**
 * @route  POST /api/premium/admin/emojis
 * @access Owner
 */
const createEmoji = asyncHandler(async (req, res) => {
  const emoji = await premiumService.createEmoji(req.body, req.file);
  res.status(201).json({ success: true, message: "Emoji qo'shildi", data: emoji });
});

/**
 * @route  PUT /api/premium/admin/emojis/:id
 * @access Owner
 */
const updateEmoji = asyncHandler(async (req, res) => {
  const emoji = await premiumService.updateEmoji(req.params.id, req.body, req.file);
  res.status(200).json({ success: true, message: "Emoji yangilandi", data: emoji });
});

/**
 * @route  DELETE /api/premium/admin/emojis/:id
 * @access Owner
 */
const deleteEmoji = asyncHandler(async (req, res) => {
  await premiumService.deleteEmoji(req.params.id);
  res.status(200).json({ success: true, message: "Emoji o'chirildi" });
});

module.exports = {
  buyPremium,
  getMyPremiumStatus,
  getAvailableEmojis,
  uploadMyProfilePicture,
  deleteMyProfilePicture,
  setMyEmojiBadge,
  setMyDisplayName,
  setMyNameColor,
  // public config
  getConfig,
  // admin
  getSettings,
  updateSettings,
  getStats,
  getSubscriptions,
  exportSubscriptions,
  grantPremium,
  revokePremium,
  getAllEmojis,
  createEmoji,
  updateEmoji,
  deleteEmoji,
};
