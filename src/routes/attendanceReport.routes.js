const express = require("express");
const router = express.Router();
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const {
  getStudentReport,
  getStaffReport,
} = require("../controllers/attendanceReport.controller");

router.use(protect, authorizePermission(PERMISSIONS.ATTENDANCE_REPORTS));

router.get("/students", getStudentReport);
router.get("/staff", getStaffReport);

module.exports = router;
