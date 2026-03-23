// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorize } = require("../middleware/auth.middleware");
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
router.get("/", protect, authorize(ROLES.OWNER), getSocialNetworks);
router.post("/", protect, authorize(ROLES.OWNER), createSocialNetwork);
router.put("/:id", protect, authorize(ROLES.OWNER), validateObjectId("id"), updateSocialNetwork);
router.delete("/:id", protect, authorize(ROLES.OWNER), validateObjectId("id"), deleteSocialNetwork);

module.exports = router;
