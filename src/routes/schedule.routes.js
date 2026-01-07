const express = require("express");
const router = express.Router();
const {
  getScheduleByClass,
  getScheduleByDay,
  createOrUpdateSchedule,
  deleteSchedule,
} = require("../controllers/schedule.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// Barcha routelar himoyalangan
router.use(protect);

// Sinf bo'yicha jadval (Owner va Teacher ko'ra oladi)
router.get(
  "/class/:classId",
  authorize("owner", "teacher"),
  getScheduleByClass
);
router.get(
  "/class/:classId/day/:day",
  authorize("owner", "teacher"),
  getScheduleByDay
);

// CRUD operatsiyalari faqat owner uchun
router.post("/", authorize("owner"), createOrUpdateSchedule);
router.delete("/:id", authorize("owner"), deleteSchedule);

module.exports = router;
