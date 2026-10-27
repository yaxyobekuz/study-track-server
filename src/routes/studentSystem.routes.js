const express = require("express");
const router = express.Router();
const {
  getStudentSystems,
  setStudentSystemMarks,
  exportStudentSystems,
  getSystemsSummary,
  getSystemsReport,
  exportSystemsReport,
} = require("../controllers/studentSystem.controller");
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// ERP VA KUNDALIK.COM — o'quvchi shu tashqi tizimlarga kiritilganmi.
// Amallar alohida ruxsat: ko'rish, belgilash va fayl (Excel / Word).
router.use(protect);

// ⚠️ `/report/export` `/report` DAN OLDIN: Express birinchi mos kelgan
// yo'lni oladi va teskari tartibda hujjat o'rniga JSON qaytardi.
router.get("/report/export", authorizePermission(PERMISSIONS.STUDENTSYSTEMS_EXPORT), exportSystemsReport);
router.get("/report", authorizePermission(PERMISSIONS.STUDENTSYSTEMS_VIEW), getSystemsReport);
// Bosh sahifadagi karta — yengil sanoqchi (ro'yxatsiz)
router.get("/summary", authorizePermission(PERMISSIONS.STUDENTSYSTEMS_VIEW), getSystemsSummary);

router.get("/", authorizePermission(PERMISSIONS.STUDENTSYSTEMS_VIEW), getStudentSystems);
router.get("/export", authorizePermission(PERMISSIONS.STUDENTSYSTEMS_EXPORT), exportStudentSystems);
router.patch("/marks", authorizePermission(PERMISSIONS.STUDENTSYSTEMS_MARK), setStudentSystemMarks);

module.exports = router;
