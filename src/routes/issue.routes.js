const express = require("express");
const router = express.Router();
const {
  protect,
  authorizePermission,
} = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
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
  remove,
  getReport,
} = require("../controllers/issue.controller");

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

router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.ISSUES_DELETE), remove);

module.exports = router;
