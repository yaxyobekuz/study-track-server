// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorize } = require("../middleware/auth.middleware");

// Controller
const {
  getHolidays,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  checkToday,
  checkDate,
} = require("../controllers/holiday.controller");

// Barcha autentifikatsiya qilingan foydalanuvchilar uchun - tekshirish
router.get("/check/today", protect, checkToday);
router.get("/check/:date", protect, checkDate);

// Barcha autentifikatsiya qilingan foydalanuvchilar ko'rishi mumkin
router.get("/", protect, getHolidays);

// Faqat owner uchun - CRUD
router.post("/", protect, authorize("owner"), createHoliday);
router.put("/:id", protect, authorize("owner"), updateHoliday);
router.delete("/:id", protect, authorize("owner"), deleteHoliday);

module.exports = router;
