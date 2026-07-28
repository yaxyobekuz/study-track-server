const express = require("express");
const router = express.Router();
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const {
  mark,
  updateRecord,
  getTodayClass,
  getTodayAllStudents,
  getClasses,
  getClassMonthRecords,
  getStudentMonthRecords,
  getAllRecords,
} = require("../controllers/studentAttendance.controller");

// Reception va owner: belgilash va ko'rish
router.get("/classes", protect, authorizePermission(PERMISSIONS.ATTENDANCE_VIEW, ROLES.RECEPTION), getClasses);
router.get("/today", protect, authorizePermission(PERMISSIONS.ATTENDANCE_VIEW, ROLES.RECEPTION), getTodayAllStudents);
router.get("/today/:classId", protect, authorizePermission(PERMISSIONS.ATTENDANCE_VIEW, ROLES.RECEPTION), getTodayClass);
router.post("/mark", protect, authorizePermission(PERMISSIONS.ATTENDANCE_MARK, ROLES.RECEPTION), mark);
router.put("/:id", protect, authorizePermission(PERMISSIONS.ATTENDANCE_UPDATE, ROLES.RECEPTION), updateRecord);

// Faqat owner: hisobotlar
router.get("/class/:classId", protect, authorizePermission(PERMISSIONS.ATTENDANCE_VIEW), getClassMonthRecords);
router.get("/student/:studentId", protect, authorizePermission(PERMISSIONS.ATTENDANCE_VIEW), getStudentMonthRecords);
router.get("/", protect, authorizePermission(PERMISSIONS.ATTENDANCE_VIEW), getAllRecords);

module.exports = router;
