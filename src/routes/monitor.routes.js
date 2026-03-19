const express = require("express");
const router = express.Router();

const { verifyMonitor } = require("../middleware/monitor.middleware");
const { protect, authorize } = require("../middleware/auth.middleware");

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
router.get("/classes/:classId/students", verifyMonitor, getClassStudents);
router.get("/schedules/all-today", verifyMonitor, getAllTodaySchedules);
router.get("/schedules/class/:classId", verifyMonitor, getClassSchedule);
router.get("/statistics/weekly/:studentId", verifyMonitor, getStudentWeeklyStats);
router.get("/coins/balance/:studentId", verifyMonitor, getStudentCoinBalance);
router.get("/social-networks", verifyMonitor, getSocialNetworks);

// Admin endpointlar (JWT bilan himoyalangan, faqat owner)
router.get("/admin/settings", protect, authorize("owner"), getMonitorSettings);
router.put("/admin/settings", protect, authorize("owner"), updateMonitorSettings);

module.exports = router;
