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

// Faqat owner uchun - ro'yxat va CRUD
router.get("/", protect, authorizePermission(PERMISSIONS.SOCIAL), getSocialNetworks);
router.post("/", protect, authorizePermission(PERMISSIONS.SOCIAL), createSocialNetwork);
router.put("/:id", protect, authorizePermission(PERMISSIONS.SOCIAL), validateObjectId("id"), updateSocialNetwork);
router.delete("/:id", protect, authorizePermission(PERMISSIONS.SOCIAL), validateObjectId("id"), deleteSocialNetwork);

module.exports = router;
