// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getOptions,
  searchStudents,
  createRun,
  listRuns,
  getRun,
  listRunReports,
  getReport,
  getStudentHistory,
  cancelRun,
  publishRun,
  unpublishRun,
  deleteRun,
  getSettings,
  updateSettings,
  listMyReports,
  getMyLatestReport,
  getMyReport,
} = require("../controllers/gradeAnalysis.controller");

router.use(protect);

// ─────────────────────────────────────────────
// MOBIL — o'quvchi va ota-ona (ruxsat darvozalaridan OLDIN)
// ─────────────────────────────────────────────
// ⚠️ Ruxsat kaliti yo'q, lekin servis faqat o'quvchi rolini o'tkazadi va
// faqat O'ZINING nashr qilingan hisobotini beradi. `/my/latest` —
// `/my/:id` DAN OLDIN, aks holda "latest" id deb o'qilardi.
router.get("/my", listMyReports);
router.get("/my/latest", getMyLatestReport);
router.get("/my/:id", validateObjectId("id"), getMyReport);

// ─────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────
// Ko'rish — `gradeAnalysis.view`: har bir o'quvchining baholari, sabablari
// va xavf balli. Baholar jurnali (`grades.view`) bitta sinfning kunlik
// ishi, bu yerda esa butun maktab kesimi — shuning uchun alohida bo'lim.
router.get("/options", authorizePermission(PERMISSIONS.GRADEANALYSIS_VIEW), getOptions);
router.get("/students", authorizePermission(PERMISSIONS.GRADEANALYSIS_VIEW), searchStudents);
router.get(
  "/students/:studentId/history",
  validateObjectId("studentId"),
  authorizePermission(PERMISSIONS.GRADEANALYSIS_VIEW),
  getStudentHistory,
);

router.get("/settings", authorizePermission(PERMISSIONS.GRADEANALYSIS_VIEW), getSettings);
router.put("/settings", authorizePermission(PERMISSIONS.GRADEANALYSIS_SETTINGS), updateSettings);

router.get("/runs", authorizePermission(PERMISSIONS.GRADEANALYSIS_VIEW), listRuns);
// ⚠️ ISHGA TUSHIRISH — `run`: butun maktab bo'yicha minglab so'rov va
// model chaqiruvi. Ko'rish huquqiga qo'shilsa, ekranni ochgan har kim AI
// limitini sarflay olardi.
router.post("/runs", authorizePermission(PERMISSIONS.GRADEANALYSIS_RUN), createRun);
router.get("/runs/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.GRADEANALYSIS_VIEW), getRun);
router.get(
  "/runs/:id/reports",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.GRADEANALYSIS_VIEW),
  listRunReports,
);
router.post("/runs/:id/cancel", validateObjectId("id"), authorizePermission(PERMISSIONS.GRADEANALYSIS_RUN), cancelRun);
// ⚠️ YUBORISH — alohida `publish`: hisobot o'quvchi va ota-onaga ochiladi
// va push ketadi. Tahlilni ishga tushirish huquqi buni o'zi bermaydi.
router.post(
  "/runs/:id/publish",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.GRADEANALYSIS_PUBLISH),
  publishRun,
);
router.post(
  "/runs/:id/unpublish",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.GRADEANALYSIS_PUBLISH),
  unpublishRun,
);
router.delete("/runs/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.GRADEANALYSIS_DELETE), deleteRun);

router.get("/reports/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.GRADEANALYSIS_VIEW), getReport);

module.exports = router;
