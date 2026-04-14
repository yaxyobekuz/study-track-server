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
} = require("../controllers/premium.controller");

const { protect, authorize } = require("../middleware/auth.middleware");
const { createSingleFileUpload, handleFileUploadError } = require("../middleware/fileUpload.middleware");
const { ROLES } = require("../utils/constants");

const uploadProfilePicMiddleware = createSingleFileUpload({
  fieldName: "image",
  categories: ["image"],
});

// All routes require authentication as student
router.use(protect);
router.use(authorize(ROLES.STUDENT));

router.post("/buy", buyPremium);
router.get("/status", getMyPremiumStatus);
router.get("/emojis", getAvailableEmojis);

router.post(
  "/profile-picture",
  uploadProfilePicMiddleware,
  handleFileUploadError,
  uploadMyProfilePicture
);
router.delete("/profile-picture", deleteMyProfilePicture);

router.put("/emoji-badge", setMyEmojiBadge);
router.put("/display-name", setMyDisplayName);
router.put("/name-color", setMyNameColor);

module.exports = router;
