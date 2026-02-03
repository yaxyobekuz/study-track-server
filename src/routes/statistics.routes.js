const express = require("express");
const router = express.Router();
const {
  getStudentWeeklyStatistics,
  getClassRankings,
  getSchoolRankings,
  exportWeeklyStatistics,
} = require("../controllers/statistics.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// Barcha route lar protected
router.use(protect);

// Bitta o'quvchining haftalik statistikasi (owner yoki student o'zini)
router.get(
  "/weekly/current/:studentId",
  authorize("owner", "student"),
  getStudentWeeklyStatistics
);

// Sinf bo'yicha reytinglar (faqat owner)
router.get(
  "/weekly/class/:classId/rankings",
  authorize("owner"),
  getClassRankings
);

// Maktab bo'yicha reytinglar (faqat owner)
router.get(
  "/weekly/school/rankings",
  authorize("owner"),
  getSchoolRankings
);

// Haftalik statistikani export qilish (faqat owner)
router.get(
  "/weekly/export",
  authorize("owner"),
  exportWeeklyStatistics
);

module.exports = router;
