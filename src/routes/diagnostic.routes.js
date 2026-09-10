/**
 * DIAGNOSTIKA — TAHLIL, SOZLAMALAR VA AI YORDAMCHILARI (`/diagnostics`).
 *
 * Savollar banki `/diagnostic-questions`, testlar `/diagnostic-tests`,
 * urinishlar `/diagnostic-attempts` da — bu yerda faqat "yuqoridan
 * qarash" (tahlil) va sozlamalar.
 */

const express = require("express");
const router = express.Router();

const {
  getSummary,
  getTrend,
  getBySubject,
  exportSubjects,
  getByTopic,
  exportTopics,
  getByClass,
  getClassDetail,
  getByStudent,
  getParticipation,
  getClassParticipation,
  getToday,
  getStudentDashboard,
  getStudentProfile,
  getSettings,
  updateSettings,
  tutorTurn,
  essayCoach,
} = require("../controllers/diagnosticAnalytics.controller");

const {
  protect,
  authorizePermission,
  authorizeSection,
} = require("../middleware/auth.middleware");
const { PERMISSIONS, SECTIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const {
  diagnosticAiLimiter,
} = require("../middleware/diagnosticAiLimit.middleware");

router.use(protect);

// ── AI YORDAMCHILARI ─────────────────────────
// ⚠️ RUXSAT TALAB QILMAYDI va bo'lim darvozasidan OLDIN turadi: bular
// O'QUVCHIGA mo'ljallangan (repetitor va insho murabbiy). Ular hech qanday
// registrni ochmaydi — faqat yuborilgan matn bilan ishlaydi.
// ⚠️ CHEKLOV MAJBURIY: har chaqiruv pullik model so'rovi
// (`diagnosticAiLimit.middleware.js` dagi izoh).
router.post("/tutor", diagnosticAiLimiter, tutorTurn);
router.post("/essay-coach", diagnosticAiLimiter, essayCoach);

// ── BOSHQARUV ────────────────────────────────
router.use(authorizeSection(SECTIONS.DIAGNOSTICS));

// Sozlamalar — `settings` amali ostida; o'qish esa bo'limga kirgan har
// kimga ochiq (chegaralar UI'da yorliq chizish uchun kerak).
router.get("/settings", authorizePermission(PERMISSIONS.DIAGNOSTICS_VIEW), getSettings);
router.put(
  "/settings",
  authorizePermission(PERMISSIONS.DIAGNOSTICS_SETTINGS),
  updateSettings,
);

// Tahlil — alohida amal: umumiy manzarani ko'rish huquqi butun
// o'quvchilar registrini ochib bermasligi kerak.
router.use(authorizePermission(PERMISSIONS.DIAGNOSTICS_ANALYTICS));

router.get("/analytics/summary", getSummary);
router.get("/analytics/trend", getTrend);
router.get("/analytics/subjects", getBySubject);
router.get(
  "/analytics/subjects/export",
  authorizePermission(PERMISSIONS.DIAGNOSTICS_EXPORT),
  exportSubjects,
);
router.get("/analytics/topics", getByTopic);
// ⚠️ EKSPORT ALOHIDA RUXSAT ORTIDA: fayl butun registrni tashqariga
// olib chiqadi, ekrandagi ko'rinish esa yo'q.
router.get(
  "/analytics/topics/export",
  authorizePermission(PERMISSIONS.DIAGNOSTICS_EXPORT),
  exportTopics,
);
router.get("/analytics/classes", getByClass);
router.get("/analytics/students", getByStudent);
router.get(
  "/analytics/classes/:classId",
  validateObjectId("classId"),
  getClassDetail,
);
router.get("/analytics/participation", getParticipation);
router.get("/analytics/class-participation", getClassParticipation);
// ⚠️ "Bugun" kartalari sana filtrini OLMAYDI (servisdagi izoh).
router.get("/analytics/today", getToday);
router.get(
  "/analytics/students/:studentId",
  validateObjectId("studentId"),
  getStudentProfile,
);
// ⚠️ `/dashboard` UMUMIY YO'LDAN KEYIN — Express birinchi mos kelganini
// oladi, lekin ikkalasi ham `:studentId` bilan boshlangani uchun tartib
// muhim emas; shunga qaramay o'qish oson bo'lishi uchun yonma-yon.
router.get(
  "/analytics/students/:studentId/dashboard",
  validateObjectId("studentId"),
  getStudentDashboard,
);

module.exports = router;
