const express = require("express");
const router = express.Router();

const {
  createSelfTask,
  createSelfSchedule,
  getSelfTasks,
  getSelfStats,
  getSelfSchedules,
  getSelfTaskById,
  completeSelfTask,
  updateSelfTask,
  extendSelfTask,
  stopSelfTask,
  reopenSelfTask,
  deleteSelfTask,
  updateSelfSchedule,
  stopSelfSchedule,
  resumeSelfSchedule,
  deleteSelfSchedule,
  getSelfOverview,
  getAllSelfTasks,
  getAnySelfTaskById,
} = require("../controllers/selfTask.controller");
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const asyncHandler = require("../middleware/async.middleware");
const {
  selfScope,
  resolveSelfViewScope,
} = require("../services/taskScope.service");
const {
  createMultiFileUpload,
  handleFileUploadError,
} = require("../middleware/fileUpload.middleware");

/**
 * XODIM O'ZIGA O'ZI BELGILAGAN TOPSHIRIQLAR.
 *
 * Ikki guruh, ikki xil darvoza:
 *
 *   XODIMNING O'ZI — RUXSAT KALITI YO'Q, `studentId`/`userId` TOKENDAN
 *   (`/payroll/my`, `/tutor-groups/my`, `/devices/me/*` bilan AYNI
 *   doktrina). Egalik `req.selfScope` orqali va u service'da HAR AMALDA
 *   qayta tekshiriladi: route faqat "kim so'rayapti" ni biladi, "bu qator
 *   menikimi" degan savolga esa `task.service.js` javob beradi.
 *
 *   BOSHQARUVCHI — `tasks.self` (ALOHIDA kalit): topshiriq registrini
 *   ko'rish huquqi xodimlarning shaxsiy rejasini ochib bermasligi kerak.
 *   Doira `resolveSelfViewScope` dan: butun filial yoki `tasks.team` bilan
 *   o'z bo'limi.
 *
 * ⚠️ MAXSUS YO'LLAR `/:id` DAN OLDIN. `/stats`, `/rules`, `/overview`,
 * `/all` — `/:id` dan keyin qolsa, Express ularni id deb o'qib, sahifa
 * "topilmadi" bo'lib turardi (`payroll.routes.js` da aynan shu tushib
 * qolgan edi — `finance.md` §10).
 */

// Fayl chegarasi — topshiriqlar bo'limi bilan AYNI (`task.routes.js`)
const upload = createMultiFileUpload({
  fieldName: "files",
  categories: ["image", "video", "document"],
  maxFiles: 10,
});

router.use(protect);

// ─── XODIMNING O'Z DOIRASI (har so'rovda, qo'shimcha SQL'siz) ─────
router.use((req, _res, next) => {
  req.selfScope = selfScope(req.user.id);
  next();
});

// ─── BOSHQARUVCHI YO'LLARI (`/:id` dan OLDIN) ────────────────────
// Doira faqat shu yo'llarda hisoblanadi: bo'lim a'zolarini o'qish
// qo'shimcha so'rov, xodimning o'z ekraniga esa u kerak emas.
const withViewScope = asyncHandler(async (req, _res, next) => {
  req.selfViewScope = await resolveSelfViewScope(req.user);
  next();
});

router.get(
  "/overview",
  authorizePermission(PERMISSIONS.TASKS_SELF),
  withViewScope,
  getSelfOverview,
);
router.get("/all", authorizePermission(PERMISSIONS.TASKS_SELF), withViewScope, getAllSelfTasks);
router.get(
  "/all/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.TASKS_SELF),
  withViewScope,
  getAnySelfTaskById,
);

// ─── DOIMIY ISH QOIDASI (o'zining) ───────────────────────────────
router.get("/rules", getSelfSchedules);
router.post("/rules", upload, handleFileUploadError, createSelfSchedule);
router.put("/rules/:id", validateObjectId("id"), upload, handleFileUploadError, updateSelfSchedule);
router.put("/rules/:id/stop", validateObjectId("id"), stopSelfSchedule);
router.put("/rules/:id/resume", validateObjectId("id"), resumeSelfSchedule);
router.delete("/rules/:id", validateObjectId("id"), deleteSelfSchedule);

// ─── XODIMNING O'Z RO'YXATI VA SANOQCHILARI ──────────────────────
router.get("/stats", getSelfStats);
router.get("/", getSelfTasks);
router.post("/", upload, handleFileUploadError, createSelfTask);

// ─── BITTA TOPSHIRIQ VA AMALLAR ──────────────────────────────────
router.get("/:id", validateObjectId("id"), getSelfTaskById);
router.put("/:id", validateObjectId("id"), upload, handleFileUploadError, updateSelfTask);
router.put(
  "/:id/complete",
  validateObjectId("id"),
  upload,
  handleFileUploadError,
  completeSelfTask,
);
router.put("/:id/extend", validateObjectId("id"), extendSelfTask);
router.put("/:id/stop", validateObjectId("id"), stopSelfTask);
router.put("/:id/reopen", validateObjectId("id"), reopenSelfTask);
router.delete("/:id", validateObjectId("id"), deleteSelfTask);

module.exports = router;
