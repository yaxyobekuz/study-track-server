const express = require("express");
const router = express.Router();

const {
  buyPremium,
  getMyPremiumStatus,
  getAvailableEmojis,
  uploadMyProfilePicture,
  deleteMyProfilePicture,
  setMyEmojiBadge,
  setMyDisplayName,
  setMyNameColor,
  getConfig,
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
} = require("../controllers/premium.controller");

const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { createSingleFileUpload, handleFileUploadError } = require("../middleware/fileUpload.middleware");
const { ROLES } = require("../utils/constants");

const uploadProfilePicMiddleware = createSingleFileUpload({
  fieldName: "image",
  categories: ["image"],
});

const uploadEmojiMiddleware = createSingleFileUpload({
  fieldName: "file",
  categories: ["json"],
});

// All routes require authentication
router.use(protect);

// ─── Public config (barcha authenticated foydalanuvchilar) ──────────
router.get("/config", getConfig);

// ─── Admin (owner) ──────────────────────────────────────────────────
router.get("/admin/settings", authorize(ROLES.OWNER), getSettings);
router.put("/admin/settings", authorize(ROLES.OWNER), updateSettings);

router.get("/admin/stats", authorize(ROLES.OWNER), getStats);
router.get("/admin/subscriptions/export", authorize(ROLES.OWNER), exportSubscriptions);
router.get("/admin/subscriptions", authorize(ROLES.OWNER), getSubscriptions);

router.post("/admin/grant", authorize(ROLES.OWNER), grantPremium);
router.post("/admin/revoke", authorize(ROLES.OWNER), revokePremium);

router.get("/admin/emojis", authorize(ROLES.OWNER), getAllEmojis);
router.post(
  "/admin/emojis",
  authorize(ROLES.OWNER),
  uploadEmojiMiddleware,
  handleFileUploadError,
  createEmoji,
);
router.put(
  "/admin/emojis/:id",
  validateObjectId("id"),
  authorize(ROLES.OWNER),
  uploadEmojiMiddleware,
  handleFileUploadError,
  updateEmoji,
);
router.delete("/admin/emojis/:id", validateObjectId("id"), authorize(ROLES.OWNER), deleteEmoji);

// ─── Student ────────────────────────────────────────────────────────
router.post("/buy", authorize(ROLES.STUDENT), buyPremium);
router.get("/status", authorize(ROLES.STUDENT), getMyPremiumStatus);
router.get("/emojis", authorize(ROLES.STUDENT), getAvailableEmojis);

router.post(
  "/profile-picture",
  authorize(ROLES.STUDENT),
  uploadProfilePicMiddleware,
  handleFileUploadError,
  uploadMyProfilePicture
);
router.delete("/profile-picture", authorize(ROLES.STUDENT), deleteMyProfilePicture);

router.put("/emoji-badge", authorize(ROLES.STUDENT), setMyEmojiBadge);
router.put("/display-name", authorize(ROLES.STUDENT), setMyDisplayName);
router.put("/name-color", authorize(ROLES.STUDENT), setMyNameColor);

module.exports = router;
