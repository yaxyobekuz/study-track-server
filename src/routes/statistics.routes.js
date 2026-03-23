const express = require("express");
const router = express.Router();
const {
  getStudentWeeklyStatistics,
  getClassRankings,
  getSchoolRankings,
  exportWeeklyStatistics,
} = require("../controllers/statistics.controller");
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// Barcha route lar protected
router.use(protect);

// Bitta o'quvchining haftalik statistikasi (owner yoki student o'zini)
router.get(
  "/weekly/current/:studentId",
  validateObjectId("studentId"),
  authorize(ROLES.OWNER, ROLES.STUDENT),
  getStudentWeeklyStatistics
);

// Sinf bo'yicha reytinglar (faqat owner)
router.get(
  "/weekly/class/:classId/rankings",
  validateObjectId("classId"),
  authorize(ROLES.OWNER),
  getClassRankings
);

// Maktab bo'yicha reytinglar (faqat owner)
router.get(
  "/weekly/school/rankings",
  authorize(ROLES.OWNER),
  getSchoolRankings
);

// Haftalik statistikani export qilish (faqat owner)
router.get(
  "/weekly/export",
  authorize(ROLES.OWNER),
  exportWeeklyStatistics
);

module.exports = router;
