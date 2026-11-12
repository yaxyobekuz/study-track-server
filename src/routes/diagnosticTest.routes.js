/**
 * DIAGNOSTIKA — TESTLAR (`/diagnostic-tests`).
 *
 * ⚠️ `/me` YO'LI RUXSAT TALAB QILMAYDI va bu ATAYLAB: o'quvchi o'ziga
 * ochiq testlar ro'yxatini ko'rishi kerak, lekin unga `diagnostics.view`
 * berilmaydi (bu ruxsat butun boshqaruv bo'limini ochib yuborardi). Yo'l
 * faqat `protect` bilan himoyalangan va HAR DOIM `req.user.id` bo'yicha
 * ishlaydi — boshqa odamning ro'yxatini so'rash imkoni yo'q.
 */

const express = require("express");
const router = express.Router();

const {
  getTests,
  getTest,
  getAvailability,
  createTest,
  previewTest,
  buildTest,
  previewStudentTest,
  buildStudentTest,
  getTestReview,
  regenerateTestQuestions,
  approveTest,
  rejectTest,
  approveTestQuestions,
  updateTest,
  updateTestStatus,
  deleteTest,
  getMyTests,
} = require("../controllers/diagnosticTest.controller");

const {
  protect,
  authorizePermission,
  authorizeSection,
} = require("../middleware/auth.middleware");
const { PERMISSIONS, SECTIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const {
  diagnosticAnalysisLimiter,
} = require("../middleware/diagnosticAiLimit.middleware");

router.use(protect);

// O'QUVCHI YO'LI — bo'lim darvozasidan OLDIN turishi shart.
router.get("/me", getMyTests);

// Boshqarish yo'llari — bo'lim darvozasi ortida.
router.use(authorizeSection(SECTIONS.DIAGNOSTICS));

router.get("/", authorizePermission(PERMISSIONS.DIAGNOSTICS_VIEW), getTests);
router.get(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_VIEW),
  getTest,
);
router.get(
  "/:id/availability",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_VIEW),
  getAvailability,
);

/**
 * TASDIQLASH EKRANI — har o'quvchining qamrovi va savollari (TO'G'RI
 * JAVOBI bilan).
 *
 * ⚠️ Ruxsat — `diagnostics.view`, `publish` EMAS: ko'rib chiqishdan oldin
 * KO'RISH kerak va tasdiqlaydigan odam ham, test tuzgan odam ham shu
 * ekranni ochadi. Tasdiqning O'ZI esa `publish` ortida (pastda).
 */
router.get(
  "/:id/review",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_VIEW),
  getTestReview,
);

router.post("/", authorizePermission(PERMISSIONS.DIAGNOSTICS_CREATE), createTest);

/**
 * ⚠️ OLDINDAN KO'RISH — `GET` EMAS, `POST`. Taqsimot bir nechta fan
 * qatoridan iborat obyektlar massivi: uni query stringga solish
 * (`blueprint[0][easy]=5`) ham o'qilmas, ham `clean()` filtridan
 * o'tmas edi. Yozuv yo'q, shuning uchun ruxsat ham yozuvnikidek
 * (`create`) — "nima bo'ladi" ni test yaratadigan odam ko'radi.
 */
router.post(
  "/preview",
  authorizePermission(PERMISSIONS.DIAGNOSTICS_CREATE),
  previewTest,
);

/**
 * MAVZU QAMROVI BILAN YIG'ISH (bank + AI).
 *
 * ⚠️ OG'IR CHEKLOV ORTIDA (`diagnosticAnalysisLimiter`, 5 daqiqada 10):
 * bitta chaqiruv o'ngacha model so'rovini yuzaga keltiradi va natijasi
 * bankka yoziladi. Umumiy cheklov (daqiqasiga 100 so'rov) bu yerda juda
 * bo'sh — tugmani ushlab turish ham hisobni, ham bankni to'ldirardi.
 *
 * ⚠️ `diagnostics.ai` ROUTE'DA TALAB QILINMAYDI — qarorni kontroller
 * qabul qiladi (izohi o'sha yerda): faqat bankdan oladigan qator model
 * chaqiruvini yuzaga keltirmaydi.
 */
router.post(
  "/build",
  authorizePermission(PERMISSIONS.DIAGNOSTICS_CREATE),
  diagnosticAnalysisLimiter,
  buildTest,
);

/**
 * HAR O'QUVCHIGA MOSLANGAN TEST — OLDINDAN KO'RISH.
 *
 * ⚠️ `POST`, chunki taqsimot va o'quvchilar ro'yxati tanada keladi
 * (`/preview` bilan AYNI mulohaza). Hech narsa yozmaydi, ruxsat esa
 * yozuvnikidek (`create`): "nima bo'ladi" ni test yaratadigan odam ko'radi.
 */
router.post(
  "/preview-students",
  authorizePermission(PERMISSIONS.DIAGNOSTICS_CREATE),
  previewStudentTest,
);

/**
 * HAR O'QUVCHIGA MOSLANGAN TESTNI YIG'ISH.
 *
 * ⚠️ OG'IR CHEKLOV ORTIDA (`/build` bilan AYNI): bitta chaqiruv qamrov
 * guruhlari soniga ko'paytirilgan model so'rovini yuzaga keltiradi va
 * natijasi bankka yoziladi.
 */
router.post(
  "/build-students",
  authorizePermission(PERMISSIONS.DIAGNOSTICS_CREATE),
  diagnosticAnalysisLimiter,
  buildStudentTest,
);

/**
 * SAVOLLARNI ALMASHTIRISH — bitta, bir nechta yoki hammasi.
 *
 * ⚠️ Ruxsat — `diagnostics.create` (AI qatoriga tegsa servis qo'shimcha
 * `diagnostics.ai` ni talab qiladi, `/build` bilan AYNI qoida): bu test
 * TARKIBINI o'zgartirish, ya'ni tuzish amalining davomi. Tasdiqlangan
 * testda yo'l baribir yopiq (servis `ConflictError` qaytaradi) —
 * "tasdiqlangan narsa" bilan "chiqadigan narsa" ajralib ketmasin.
 */
router.post(
  "/:id/questions/regenerate",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_CREATE),
  diagnosticAnalysisLimiter,
  regenerateTestQuestions,
);

/**
 * TASDIQLASH VA RAD ETISH — `diagnostics.publish`.
 *
 * ⚠️ `create` DAN ALOHIDA RUXSAT (biznes qarori, 2026-11-12): test
 * TUZISH huquqi uni CHIQARISH huquqiga aylanmasligi kerak
 * (`payroll.generate` / `assign` bilan AYNI mulohaza). Tasdiqsiz test
 * `draft` dan chiqa olmaydi — darvoza `updateTestStatus` da.
 */
router.post(
  "/:id/approve",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_PUBLISH),
  approveTest,
);
router.post(
  "/:id/reject",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_PUBLISH),
  rejectTest,
);

/**
 * ⚠️ TASDIQLASH ALOHIDA RUXSAT (`diagnostics.moderate`, `create` EMAS):
 * savol yozish huquqi uni o'zi tasdiqlash huquqini bermasligi kerak —
 * bank sifati aynan shu ikki qadamning ajratilganidan kelib chiqadi
 * (`diagnosticQuestion.routes.js` dagi AYNI qoida).
 */
router.patch(
  "/:id/approve-questions",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_MODERATE),
  approveTestQuestions,
);
router.put(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_UPDATE),
  updateTest,
);
router.patch(
  "/:id/status",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_UPDATE),
  updateTestStatus,
);
router.delete(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_DELETE),
  deleteTest,
);

module.exports = router;
