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
router.post("/", protect, authorizePermission(PERMISSIONS.HOLIDAYS), createHoliday);
router.put("/:id", protect, authorizePermission(PERMISSIONS.HOLIDAYS), validateObjectId("id"), updateHoliday);
router.delete("/:id", protect, authorizePermission(PERMISSIONS.HOLIDAYS), validateObjectId("id"), deleteHoliday);

module.exports = router;
