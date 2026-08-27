const express = require("express");
const router = express.Router();
const {
  deleteSchedule,
  getScheduleByDay,
  getScheduleByClass,
  getScheduleVersions,
  getRevisions,
  getRevision,
  restoreRevision,
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
router.get("/all-today", authorizePermission(PERMISSIONS.SCHEDULES_VIEW), getAllTodaySchedules);

// Schedule by class (Owner and Teacher can view)
router.get(
  "/class/:classId",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES_VIEW, ROLES.TEACHER),
  getScheduleByClass,
);
// Barcha versiyalar (tarix) — sana bo'yicha
router.get(
  "/class/:classId/versions",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES_VIEW, ROLES.TEACHER),
  getScheduleVersions,
);
// Tahrirlar tarixi (revision — kim/qachon/IP/xulosa)
router.get(
  "/class/:classId/revisions",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES_VIEW),
  getRevisions,
);
router.get(
  "/revisions/:revId",
  validateObjectId("revId"),
  authorizePermission(PERMISSIONS.SCHEDULES_VIEW),
  getRevision,
);
router.post(
  "/revisions/:revId/restore",
  validateObjectId("revId"),
  authorizePermission(PERMISSIONS.SCHEDULES_UPDATE),
  restoreRevision,
);
router.get(
  "/class/:classId/export",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES_EXPORT, ROLES.TEACHER),
  exportScheduleByClass,
);
router.get(
  "/class/:classId/day/:day",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES_VIEW, ROLES.TEACHER),
  getScheduleByDay,
);

// Get all classes by subject (Owner only)
router.get("/subject/:subjectId", validateObjectId("subjectId"), authorizePermission(PERMISSIONS.SCHEDULES_VIEW), getClassesBySubject);

// CRUD operations - amal darajasidagi ruxsat bilan
router.post("/", authorizePermission(PERMISSIONS.SCHEDULES_CREATE), createOrUpdateSchedule);
router.put(
  "/class/:classId",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.SCHEDULES_UPDATE),
  saveClassSchedule,
);
router.patch(
  "/class/:classId/subject/:subjectId/topic",
  validateObjectId("classId"),
  validateObjectId("subjectId"),
  authorizePermission(PERMISSIONS.SCHEDULES_UPDATE),
  updateCurrentTopic,
);
router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.SCHEDULES_DELETE), deleteSchedule);

module.exports = router;
