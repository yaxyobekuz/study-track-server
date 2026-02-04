const express = require("express");
const router = express.Router();
const {
  deleteSchedule,
  getScheduleByDay,
  getScheduleByClass,
  getMyTodaySchedule,
  getAllTodaySchedules,
  createOrUpdateSchedule,
  updateCurrentTopic,
  exportScheduleByClass,
  getClassesBySubject,
} = require("../controllers/schedule.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// All routes are protected
router.use(protect);

// Teacher's today schedule
router.get("/my-today", authorize("teacher"), getMyTodaySchedule);

// All today schedules (Owner only)
router.get("/all-today", authorize("owner"), getAllTodaySchedules);

// Schedule by class (Owner and Teacher can view)
router.get(
  "/class/:classId",
  authorize("owner", "teacher"),
  getScheduleByClass,
);
router.get(
  "/class/:classId/export",
  authorize("owner", "teacher"),
  exportScheduleByClass,
);
router.get(
  "/class/:classId/day/:day",
  authorize("owner", "teacher"),
  getScheduleByDay,
);

// Get all classes by subject (Owner only)
router.get("/subject/:subjectId", authorize("owner"), getClassesBySubject);

// CRUD operations for owner only
router.post("/", authorize("owner"), createOrUpdateSchedule);
router.patch(
  "/class/:classId/subject/:subjectId/topic",
  authorize("owner"),
  updateCurrentTopic,
);
router.delete("/:id", authorize("owner"), deleteSchedule);

module.exports = router;
