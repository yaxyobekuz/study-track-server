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

const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
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
router.get("/admin/settings", authorizePermission(PERMISSIONS.PREMIUM), getSettings);
router.put("/admin/settings", authorizePermission(PERMISSIONS.PREMIUM), updateSettings);

router.get("/admin/stats", authorizePermission(PERMISSIONS.PREMIUM), getStats);
router.get("/admin/subscriptions/export", authorizePermission(PERMISSIONS.PREMIUM), exportSubscriptions);
router.get("/admin/subscriptions", authorizePermission(PERMISSIONS.PREMIUM), getSubscriptions);

router.post("/admin/grant", authorizePermission(PERMISSIONS.PREMIUM), grantPremium);
router.post("/admin/revoke", authorizePermission(PERMISSIONS.PREMIUM), revokePremium);

router.get("/admin/emojis", authorizePermission(PERMISSIONS.PREMIUM), getAllEmojis);
router.post(
  "/admin/emojis",
  authorizePermission(PERMISSIONS.PREMIUM),
  uploadEmojiMiddleware,
  handleFileUploadError,
  createEmoji,
);
router.put(
  "/admin/emojis/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.PREMIUM),
  uploadEmojiMiddleware,
  handleFileUploadError,
  updateEmoji,
);
router.delete("/admin/emojis/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.PREMIUM), deleteEmoji);

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
