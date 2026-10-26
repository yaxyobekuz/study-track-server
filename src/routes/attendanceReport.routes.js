const express = require("express");
const router = express.Router();
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const {
  getStudentReport,
  getStudentTrend,
  getClassReport,
  getStaffReport,
} = require("../controllers/attendanceReport.controller");

router.use(protect, authorizePermission(PERMISSIONS.ATTENDANCE_REPORTS));

router.get("/students", getStudentReport);
// So'nggi N kundagi davomat trendi (bosh sahifadagi grafik)
router.get("/students/trend", getStudentTrend);
router.get("/students/classes/:classId", getClassReport);
router.get("/staff", getStaffReport);

module.exports = router;
