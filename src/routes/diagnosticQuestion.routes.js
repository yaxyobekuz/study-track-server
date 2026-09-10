/**
 * DIAGNOSTIKA — SAVOLLAR BANKI (`/diagnostic-questions`).
 *
 * ⚠️ BU YO'L O'QUVCHIGA UMUMAN OCHIQ EMAS. Bank javob kalitini, izohni va
 * yechimni saqlaydi — `diagnostics.questions` ruxsatisiz hech bir GET ham
 * o'tmaydi. Asl loyihada bu ro'yxat har bir autentifikatsiyalangan
 * foydalanuvchiga ochiq edi va o'quvchi o'ziga tayinlangan testning javob
 * kalitini topshirishdan OLDIN o'qib olishi mumkin edi.
 */

const express = require("express");
const router = express.Router();

const {
  getQuestions,
  getStats,
  getCoverage,
  getQuestion,
  createQuestion,
  updateQuestion,
  updateQuestionStatus,
  bulkUpdateStatus,
  deleteQuestion,
  importQuestions,
  exportQuestions,
} = require("../controllers/diagnosticQuestion.controller");

const {
  protect,
  authorizePermission,
  authorizeSection,
} = require("../middleware/auth.middleware");
const { PERMISSIONS, SECTIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const {
  createSingleFileUpload,
  createFieldsUpload,
  handleFileUploadError,
} = require("../middleware/fileUpload.middleware");

// Savol + variant rasmlari. Maydon nomlari `optionImage_<index>` —
// variantning TARTIB RAQAMI shu nomdan olinadi (bo'sh variant tartibni
// surib yuborishi mumkin bo'lgani uchun massivga tayanib bo'lmaydi).
const uploadQuestionImages = createFieldsUpload({
  fields: [
    { name: "questionImage", maxCount: 1 },
    ...Array.from({ length: 6 }, (_, i) => ({
      name: `optionImage_${i}`,
      maxCount: 1,
    })),
  ],
  categories: ["image"],
  maxFiles: 7,
});

const uploadImportFile = createSingleFileUpload({
  fieldName: "file",
  categories: ["spreadsheet"],
});

router.use(protect);
// Butun bo'limga darvoza — aniq amal har route'da alohida tekshiriladi.
router.use(authorizeSection(SECTIONS.DIAGNOSTICS));

// ── O'QISH ───────────────────────────────────
router.get("/", authorizePermission(PERMISSIONS.DIAGNOSTICS_QUESTIONS), getQuestions);
router.get("/stats", authorizePermission(PERMISSIONS.DIAGNOSTICS_QUESTIONS), getStats);
router.get(
  "/coverage",
  authorizePermission(PERMISSIONS.DIAGNOSTICS_QUESTIONS),
  getCoverage,
);
// ⚠️ IKKI RUXSAT BIRDAN. Eksport faylida "To'g'ri javob" USTUNI bor,
// ya'ni u butun bankning javob kalitini bitta bosishda beradi. Faqat
// `diagnostics.export` bilan qoldirilsa, savollar bazasini KO'RA
// OLMAYDIGAN odam ham uni to'liq yuklab olardi — ruxsatlarni maydalash
// shu bilan ma'nosiz bo'lardi.
router.get(
  "/export",
  authorizePermission(PERMISSIONS.DIAGNOSTICS_QUESTIONS),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_EXPORT),
  exportQuestions,
);
router.get(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_QUESTIONS),
  getQuestion,
);

// ── YOZISH ───────────────────────────────────
router.post(
  "/",
  authorizePermission(PERMISSIONS.DIAGNOSTICS_QUESTIONS),
  uploadQuestionImages,
  handleFileUploadError,
  createQuestion,
);

router.post(
  "/import",
  authorizePermission(PERMISSIONS.DIAGNOSTICS_QUESTIONS),
  uploadImportFile,
  handleFileUploadError,
  importQuestions,
);

router.put(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_QUESTIONS),
  uploadQuestionImages,
  handleFileUploadError,
  updateQuestion,
);

// ⚠️ MODERATSIYA ALOHIDA RUXSAT (`moderate`, `questions` EMAS): savol
// yozish huquqi uni o'zi tasdiqlash huquqini bermasligi kerak — bankning
// sifati aynan shu ikki qadamning ajratilganidan kelib chiqadi.
router.patch(
  "/bulk-status",
  authorizePermission(PERMISSIONS.DIAGNOSTICS_MODERATE),
  bulkUpdateStatus,
);
router.patch(
  "/:id/status",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_MODERATE),
  updateQuestionStatus,
);

router.delete(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.DIAGNOSTICS_DELETE),
  deleteQuestion,
);

module.exports = router;
