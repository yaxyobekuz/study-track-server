const express = require("express");
const router = express.Router();
const {
  getStudentSystems,
  setStudentSystemMarks,
  exportStudentSystems,
} = require("../controllers/studentSystem.controller");
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// ERP VA KUNDALIK.COM — o'quvchi shu tashqi tizimlarga kiritilganmi.
// Amallar alohida ruxsat: ko'rish, belgilash va Excel.
router.use(protect);

router.get("/", authorizePermission(PERMISSIONS.STUDENTSYSTEMS_VIEW), getStudentSystems);
router.get("/export", authorizePermission(PERMISSIONS.STUDENTSYSTEMS_EXPORT), exportStudentSystems);
router.patch("/marks", authorizePermission(PERMISSIONS.STUDENTSYSTEMS_MARK), setStudentSystemMarks);

module.exports = router;
