const express = require("express");
const router = express.Router();
const {
  deleteSchedule,
  getScheduleByDay,
  getScheduleByClass,
  getMyTodaySchedule,
  getAllTodaySchedules,
  createOrUpdateSchedule,
  saveClassSchedule,
  updateCurrentTopic,
  exportScheduleByClass,
  getClassesBySubject,
} = require("../controllers/schedule.controller");
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// All routes are protected
router.use(protect);

// Teacher's today schedule
router.get("/my-today", authorize(ROLES.TEACHER), getMyTodaySchedule);

// All today schedules (Owner only)
router.get("/all-today", authorize(ROLES.OWNER), getAllTodaySchedules);

// Schedule by class (Owner and Teacher can view)
router.get(
  "/class/:classId",
  validateObjectId("classId"),
  authorize(ROLES.OWNER, ROLES.TEACHER),
  getScheduleByClass,
);
router.get(
  "/class/:classId/export",
  validateObjectId("classId"),
  authorize(ROLES.OWNER, ROLES.TEACHER),
  exportScheduleByClass,
);
router.get(
  "/class/:classId/day/:day",
  validateObjectId("classId"),
  authorize(ROLES.OWNER, ROLES.TEACHER),
  getScheduleByDay,
);

// Get all classes by subject (Owner only)
router.get("/subject/:subjectId", validateObjectId("subjectId"), authorize(ROLES.OWNER), getClassesBySubject);

// CRUD operations for owner only
router.post("/", authorize(ROLES.OWNER), createOrUpdateSchedule);
router.put(
  "/class/:classId",
  validateObjectId("classId"),
  authorize(ROLES.OWNER),
  saveClassSchedule,
);
router.patch(
  "/class/:classId/subject/:subjectId/topic",
  validateObjectId("classId"),
  validateObjectId("subjectId"),
  authorize(ROLES.OWNER),
  updateCurrentTopic,
);
router.delete("/:id", validateObjectId("id"), authorize(ROLES.OWNER), deleteSchedule);

module.exports = router;
