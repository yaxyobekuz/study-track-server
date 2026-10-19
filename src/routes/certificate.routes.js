const express = require("express");
const router = express.Router();

const {
  getPlans,
  getStudentPlans,
  getMyPlans,
  searchStudents,
  createPlan,
  updatePlan,
  cancelPlan,
  markPlanPassed,
  getTutorGroupPlans,
  updateTutorPlan,
  getTracks,
  createTrack,
  updateTrack,
  previewImport,
  confirmImport,
  getStats,
} = require("../controllers/certificate.controller");

const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const {
  createSingleFileUpload,
  handleFileUploadError,
} = require("../middleware/fileUpload.middleware");

// SERTIFIKAT REJALARI — "kim qaysi sertifikatni qachon topshirmoqchi".
router.use(protect);

// ⚠️ `/my` — O'QUVCHINING O'ZI uchun, ruxsat kalitisiz (id tokendan).
// U `/:id` dan OLDIN turishi SHART: aks holda "my" id deb o'qilardi
// (`payroll.routes.js` dagi AYNI tuzoq — `finance.md` §10).
router.get("/my", getMyPlans);

router.get("/stats", authorizePermission(PERMISSIONS.CERTIFICATES_VIEW), getStats);

// ⚠️ TYUTOR (GURUH RAHBARI) — RUXSAT KALITI YO'Q, huquq guruh
// biriktirilganidan keladi (`/tutor-groups/my` bilan AYNI qoida). Id
// tokendan olinadi, egalik servisda HAR SO'ROVDA qayta tekshiriladi.
// ⚠️ `/tutor/...` yo'llari `/:id` dan OLDIN turishi SHART.
router.get(
  "/tutor/groups/:classId",
  validateObjectId("classId"),
  getTutorGroupPlans,
);
router.patch("/tutor/plans/:id", validateObjectId("id"), updateTutorPlan);

// O'quvchi tanlagichi — YOZISH yo'lining qismi, shuning uchun `manage`
router.get(
  "/students",
  authorizePermission(PERMISSIONS.CERTIFICATES_MANAGE),
  searchStudents,
);

// Yo'nalishlar katalogi
router.get("/tracks", authorizePermission(PERMISSIONS.CERTIFICATES_VIEW), getTracks);
router.post("/tracks", authorizePermission(PERMISSIONS.CERTIFICATES_MANAGE), createTrack);
router.patch(
  "/tracks/:id",
  authorizePermission(PERMISSIONS.CERTIFICATES_MANAGE),
  validateObjectId("id"),
  updateTrack,
);

// Fayldan ommaviy yuklash — ko'rib chiqish YOZMAYDI, tasdiq yozadi
router.post(
  "/import/preview",
  authorizePermission(PERMISSIONS.CERTIFICATES_IMPORT),
  createSingleFileUpload({ categories: ["spreadsheet"] }),
  handleFileUploadError,
  previewImport,
);
router.post(
  "/import/confirm",
  authorizePermission(PERMISSIONS.CERTIFICATES_IMPORT),
  confirmImport,
);

// Rejalar
router.get("/", authorizePermission(PERMISSIONS.CERTIFICATES_VIEW), getPlans);
router.post("/", authorizePermission(PERMISSIONS.CERTIFICATES_MANAGE), createPlan);

router.get(
  "/student/:studentId",
  authorizePermission(PERMISSIONS.CERTIFICATES_VIEW),
  validateObjectId("studentId"),
  getStudentPlans,
);

router.patch(
  "/:id",
  authorizePermission(PERMISSIONS.CERTIFICATES_MANAGE),
  validateObjectId("id"),
  updatePlan,
);
router.post(
  "/:id/cancel",
  authorizePermission(PERMISSIONS.CERTIFICATES_MANAGE),
  validateObjectId("id"),
  cancelPlan,
);
router.post(
  "/:id/passed",
  authorizePermission(PERMISSIONS.CERTIFICATES_MANAGE),
  validateObjectId("id"),
  markPlanPassed,
);

module.exports = router;
