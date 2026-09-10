/**
 * DIAGNOSTIKA — URINISHLAR (`/diagnostic-attempts`).
 *
 * ⚠️ IKKI GURUH YO'L VA ULARNING HIMOYASI HAR XIL:
 *
 *   1. O'QUVCHI YO'LLARI (`/start`, `/me`, `/:id/active`, `/:id/answers/...`,
 *      `/:id/submit`) — faqat `protect`. Ular HAR DOIM `req.user.id` bilan
 *      ishlaydi va service egalikni tekshiradi. O'quvchiga `diagnostics.*`
 *      ruxsati berilmaydi, chunki u butun boshqaruv bo'limini ochib
 *      yuborardi.
 *
 *   2. BOSHQARUV YO'LLARI (ro'yxat, eksport, o'chirish) — `diagnostics.attempts`
 *      ruxsati ortida.
 *
 * `/:id/result` ikkalasiga ham xizmat qiladi: huquq controller ichida
 * hal qilinadi ("o'zimniki YOKI `diagnostics.attempts`"), chunki bu
 * yagona joyda ikkala tomon ham bir xil ma'lumotni ko'rishi kerak.
 */

const express = require("express");
const router = express.Router();

const {
  startAttempt,
  getActiveAttempt,
  saveAnswer,
  submitAttempt,
  getMyAttempts,
  getMyDashboard,
  getResult,
  exportResult,
  getInsights,
  explainAnswer,
  requestAnalysis,
  getAttempts,
  deleteAttempt,
  exportAttempts,
} = require("../controllers/diagnosticAttempt.controller");

const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const {
  diagnosticAiLimiter,
  diagnosticAnalysisLimiter,
} = require("../middleware/diagnosticAiLimit.middleware");

router.use(protect);

// ── BOSHQARUV ────────────────────────────────
// ⚠️ `/` va `/export` `/:id` DAN OLDIN — aks holda "export" id deb
// o'qilardi (`validateObjectId` uni rad qilsa ham, xato xabari noto'g'ri
// bo'lardi).
router.get("/", authorizePermission(PERMISSIONS.DIAGNOSTICS_ATTEMPTS), getAttempts);
router.get(
  "/export",
  authorizePermission(PERMISSIONS.DIAGNOSTICS_EXPORT),
  exportAttempts,
);

// ── O'QUVCHI ─────────────────────────────────
router.get("/me", getMyAttempts);
// ⚠️ `/me/dashboard` `/me` DAN KEYIN, LEKIN `/:id` DAN OLDIN — aks holda
// "me" id deb o'qilardi.
router.get("/me/dashboard", getMyDashboard);
router.post("/start", startAttempt);

router.get("/:id/active", validateObjectId("id"), getActiveAttempt);
router.put(
  "/:id/answers/:questionId",
  validateObjectId("id"),
  validateObjectId("questionId"),
  saveAnswer,
);
router.post("/:id/submit", validateObjectId("id"), submitAttempt);

// ── NATIJA (o'quvchi + xodim) ────────────────
router.get("/:id/result", validateObjectId("id"), getResult);
// ⚠️ EKSPORT ALOHIDA RUXSAT TALAB QILMAYDI: fayl `getResult` bilan AYNI
// ma'lumotdan yasaladi va "javoblarni ko'rsatma" sozlamasini ham
// hurmat qiladi. Ruxsat qo'yilsa o'quvchi o'z natijasini yuklab
// ololmasdi — hisobot esa aynan unga mo'ljallangan.
router.get("/:id/result/export", validateObjectId("id"), exportResult);
router.get("/:id/insights", validateObjectId("id"), getInsights);
router.post(
  "/:id/questions/:questionId/explain",
  validateObjectId("id"),
  validateObjectId("questionId"),
  // Har savol uchun bitta model chaqiruvi — natija keshlanadi, lekin
  // birinchi so'rov baribir pullik.
  diagnosticAiLimiter,
  explainAnswer,
);

// AI tahlilini QAYTA ishga tushirish — pullik chaqiruv, alohida ruxsat.
router.post(
  "/:id/analyze",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_AI),
  // Bitta bosish uchtagacha model chaqiruvini ishga tushiradi.
  diagnosticAnalysisLimiter,
  requestAnalysis,
);

router.delete(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_DELETE),
  deleteAttempt,
);

module.exports = router;
