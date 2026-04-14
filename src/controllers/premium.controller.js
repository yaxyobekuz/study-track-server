const asyncHandler = require("../middleware/async.middleware");
const premiumService = require("../services/premium.service");

/**
 * @route  POST /api/premium/buy
 * @access Student
 */
const buyPremium = asyncHandler(async (req, res) => {
  const user = await premiumService.purchasePremium(req.user._id);

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
  const { user, latestPremium } = await premiumService.getPremiumStatus(req.user._id);

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
  const image = await premiumService.uploadProfilePicture(req.user._id, req.file);

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
  await premiumService.deleteProfilePicture(req.user._id);

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
  const user = await premiumService.setEmojiBadge(req.user._id, emojiId);

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
  const user = await premiumService.setDisplayName(req.user._id, displayName);

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
  const user = await premiumService.setNameColor(req.user._id, nameColor);

  res.status(200).json({
    success: true,
    message: "Ism rangi o'rnatildi",
    data: user,
  });
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
};
