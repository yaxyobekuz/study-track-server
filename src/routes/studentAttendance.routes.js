const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/auth.middleware");
const {
  mark,
  updateRecord,
  getTodayClass,
  getClasses,
  getClassMonthRecords,
  getStudentMonthRecords,
  getAllRecords,
} = require("../controllers/studentAttendance.controller");

// Reception va owner: belgilash va ko'rish
router.get("/classes", protect, authorize("owner", "reception"), getClasses);
router.get("/today/:classId", protect, authorize("owner", "reception"), getTodayClass);
router.post("/mark", protect, authorize("owner", "reception"), mark);
router.put("/:id", protect, authorize("owner", "reception"), updateRecord);

// Faqat owner: hisobotlar
router.get("/class/:classId", protect, authorize("owner"), getClassMonthRecords);
router.get("/student/:studentId", protect, authorize("owner"), getStudentMonthRecords);
router.get("/", protect, authorize("owner"), getAllRecords);

module.exports = router;
