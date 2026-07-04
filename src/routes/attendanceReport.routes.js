const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/auth.middleware");
const { ROLES } = require("../utils/constants");
const {
  getStudentReport,
  getStaffReport,
} = require("../controllers/attendanceReport.controller");

router.use(protect, authorize(ROLES.OWNER));

router.get("/students", getStudentReport);
router.get("/staff", getStaffReport);

module.exports = router;
