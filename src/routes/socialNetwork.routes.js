// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// Controller
const {
  getSocialNetworks,
  createSocialNetwork,
  updateSocialNetwork,
  deleteSocialNetwork,
  checkSubscription,
} = require("../controllers/socialNetwork.controller");

// Barcha autentifikatsiya qilingan foydalanuvchilar uchun - obuna tekshirish
router.get("/check-subscription", protect, checkSubscription);

// Ro'yxat va CRUD - amal darajasidagi ruxsat bilan
router.get("/", protect, authorizePermission(PERMISSIONS.SOCIAL_VIEW), getSocialNetworks);
router.post("/", protect, authorizePermission(PERMISSIONS.SOCIAL_CREATE), createSocialNetwork);
router.put("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.SOCIAL_UPDATE), updateSocialNetwork);
router.delete("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.SOCIAL_DELETE), deleteSocialNetwork);

module.exports = router;
