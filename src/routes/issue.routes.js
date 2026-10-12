const express = require("express");
const router = express.Router();
const {
  protect,
  authorizePermission,
} = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const {
  createMultiFileUpload,
  handleFileUploadError,
} = require("../middleware/fileUpload.middleware");
const {
  createCategory,
  getCategories,
  getActiveCategories,
  updateCategory,
  deleteCategory,
  getAll,
  getCounts,
  getOne,
  review,
  assignTasks,
  remove,
  getReport,
} = require("../controllers/issue.controller");

// ⚠️ 10 — `task.service.js` dagi `TASK_ATTACHMENTS_MAX` bilan bir xil:
// topshiriq shu yerdan ham, topshiriqlar bo'limidan ham bir xil qoida
// bilan yaratiladi. Aniq chegara service'da tekshiriladi.
const upload = createMultiFileUpload({
  fieldName: "files",
  categories: ["image", "video", "document"],
  maxFiles: 10,
});

router.use(protect);

// ─── Kategoriyalar ────────────────────────────────────────────────
//
// ⚠️ `/categories/*` MUAMMO ROUTE'LARIDAN OLDIN turadi: aks holda
// `GET /:id` ni "categories" ni id deb olib, `validateObjectId` rad
// etardi.
//
// ⚠️ Faol kategoriyalar ro'yxati `issues.view` BILAN ham ochiladi:
// panelda muammolarni FILTRLASH uchun kerak va u boshqaruv ro'yxatidan
// kamroq ma'lumot beradi (noaktivlar va sanoqlar yo'q).
router.get("/categories/active", authorizePermission(PERMISSIONS.ISSUES_VIEW), getActiveCategories);

router.get("/categories", authorizePermission(PERMISSIONS.ISSUES_CATEGORIES), getCategories);
router.post("/categories", authorizePermission(PERMISSIONS.ISSUES_CATEGORIES), createCategory);
router.put(
  "/categories/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.ISSUES_CATEGORIES),
  updateCategory,
);
router.delete(
  "/categories/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.ISSUES_CATEGORIES),
  deleteCategory,
);

// ─── Hisobot ──────────────────────────────────────────────────────
//
// Butun jamoaning shikoyat manzarasi — ro'yxatni ko'rishdan kengroq
// kesim, shuning uchun o'z kaliti (`tasks.reports` bilan ayni mulohaza).
router.get("/report", authorizePermission(PERMISSIONS.ISSUES_REPORTS), getReport);

// ─── Muammolar ────────────────────────────────────────────────────
router.get("/counts", authorizePermission(PERMISSIONS.ISSUES_VIEW), getCounts);
router.get("/", authorizePermission(PERMISSIONS.ISSUES_VIEW), getAll);
router.get("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.ISSUES_VIEW), getOne);

// Holat + javob — javob botga ketadi va maktab nomidan yoziladi,
// shuning uchun ro'yxatni ko'rishdan alohida kalit.
router.patch(
  "/:id/review",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.ISSUES_REVIEW),
  review,
);

// Topshiriq biriktirish — BOSHQA ODAMNING ishini belgilaydi va muddati
// o'tsa unga jarima yoziladi, shuning uchun `review` dan alohida kalit.
router.post(
  "/:id/tasks",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.ISSUES_ASSIGN),
  upload,
  handleFileUploadError,
  assignTasks,
);

router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.ISSUES_DELETE), remove);

module.exports = router;
