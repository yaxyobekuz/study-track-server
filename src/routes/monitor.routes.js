const express = require("express");
const router = express.Router();

const { verifyMonitor } = require("../middleware/monitor.middleware");
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

const {
  verifyCode,
  getClasses,
  getClassStudents,
  getAllTodaySchedules,
  getClassSchedule,
  getStudentWeeklyStats,
  getStudentCoinBalance,
  getSocialNetworks,
  getMonitorSettings,
  updateMonitorSettings,
} = require("../controllers/monitor.controller");

// Public - kod tekshirish (middleware yo'q)
router.post("/verify", verifyCode);

// Monitor code bilan himoyalangan endpointlar
router.get("/classes", verifyMonitor, getClasses);
router.get("/classes/:classId/students", verifyMonitor, validateObjectId("classId"), getClassStudents);
router.get("/schedules/all-today", verifyMonitor, getAllTodaySchedules);
router.get("/schedules/class/:classId", verifyMonitor, validateObjectId("classId"), getClassSchedule);
router.get("/statistics/weekly/:studentId", verifyMonitor, validateObjectId("studentId"), getStudentWeeklyStats);
router.get("/coins/balance/:studentId", verifyMonitor, validateObjectId("studentId"), getStudentCoinBalance);
router.get("/social-networks", verifyMonitor, getSocialNetworks);

// Admin endpointlar (JWT bilan himoyalangan, faqat owner)
router.get("/admin/settings", protect, authorizePermission(PERMISSIONS.MONITORS), getMonitorSettings);
router.put("/admin/settings", protect, authorizePermission(PERMISSIONS.MONITORS), updateMonitorSettings);

module.exports = router;
