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
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// All routes are protected
router.use(protect);

// Teacher's today schedule
router.get("/my-today", authorize(ROLES.TEACHER), getMyTodaySchedule);

// All today schedules (Owner only)
router.get("/all-today", authorizePermission(PERMISSIONS.SCHEDULES), getAllTodaySchedules);

// Schedule by class (Owner and Teacher can view)
router.get(
  "/class/:classId",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES, ROLES.TEACHER),
  getScheduleByClass,
);
router.get(
  "/class/:classId/export",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES, ROLES.TEACHER),
  exportScheduleByClass,
);
router.get(
  "/class/:classId/day/:day",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES, ROLES.TEACHER),
  getScheduleByDay,
);

// Get all classes by subject (Owner only)
router.get("/subject/:subjectId", validateObjectId("subjectId"), authorizePermission(PERMISSIONS.SCHEDULES), getClassesBySubject);

// CRUD operations for owner only
router.post("/", authorizePermission(PERMISSIONS.SCHEDULES), createOrUpdateSchedule);
router.put(
  "/class/:classId",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES),
  saveClassSchedule,
);
router.patch(
  "/class/:classId/subject/:subjectId/topic",
  validateObjectId("classId"),
  validateObjectId("subjectId"),
  authorizePermission(PERMISSIONS.SCHEDULES),
  updateCurrentTopic,
);
router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.SCHEDULES), deleteSchedule);

module.exports = router;
