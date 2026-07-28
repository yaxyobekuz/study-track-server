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

// CRUD - amal darajasidagi ruxsat bilan
router.post("/", protect, authorizePermission(PERMISSIONS.HOLIDAYS_CREATE), createHoliday);
router.put("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.HOLIDAYS_UPDATE), updateHoliday);
router.delete("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.HOLIDAYS_DELETE), deleteHoliday);

module.exports = router;
