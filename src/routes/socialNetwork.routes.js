// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorize } = require("../middleware/auth.middleware");

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
router.get("/", protect, authorize("owner"), getSocialNetworks);
router.post("/", protect, authorize("owner"), createSocialNetwork);
router.put("/:id", protect, authorize("owner"), updateSocialNetwork);
router.delete("/:id", protect, authorize("owner"), deleteSocialNetwork);

module.exports = router;
