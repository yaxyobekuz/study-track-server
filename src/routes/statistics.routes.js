const express = require("express");
const router = express.Router();
const {
  getStudentWeeklyStatistics,
  getClassRankings,
  getSchoolRankings,
  getSchoolTop,
  exportWeeklyStatistics,
  getAllStudentWeeklyStats,
} = require("../controllers/statistics.controller");
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// Barcha route lar protected
router.use(protect);

// Bitta o'quvchining haftalik statistikasi (owner yoki student o'zini)
router.get(
  "/weekly/current/:studentId",
  validateObjectId("studentId"),
  authorizePermission(PERMISSIONS.STATISTICS_VIEW, ROLES.STUDENT),
  getStudentWeeklyStatistics
);

// Sinf bo'yicha reytinglar (faqat owner)
router.get(
  "/weekly/class/:classId/rankings",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.STATISTICS_VIEW),
  getClassRankings
);

// Maktab bo'yicha reytinglar (owner yoki student)
router.get(
  "/weekly/school/rankings",
  authorizePermission(PERMISSIONS.STATISTICS_VIEW, ROLES.STUDENT),
  getSchoolRankings
);

// Bosh sahifadagi karta — eng yuqori va eng past beshtalik.
// ⚠️ `/school/rankings` dan OLDIN emas, keyin turishi muhim emas (yo'l
// aniq, parametr yo'q), lekin ruxsat AYNI: ro'yxatning o'zi shu kalit
// bilan ochiladi, beshtaligi uchun alohida huquq ochib berilmaydi.
router.get(
  "/weekly/school/top",
  authorizePermission(PERMISSIONS.STATISTICS_VIEW),
  getSchoolTop
);

// Haftalik statistikani export qilish (faqat owner)
router.get(
  "/weekly/export",
  authorizePermission(PERMISSIONS.STATISTICS_EXPORT),
  exportWeeklyStatistics
);

// O'quvchining barcha haftalik statistikasi (owner yoki student o'zini)
router.get(
  "/weekly/student/:studentId/all",
  validateObjectId("studentId"),
  authorizePermission(PERMISSIONS.STATISTICS_VIEW, ROLES.STUDENT),
  getAllStudentWeeklyStats
);

module.exports = router;
