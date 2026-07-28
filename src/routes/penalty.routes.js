const express = require("express");
const router = express.Router();
const {
  getCategories,
  createPenaltyCategory,
  updateCategory,
  deleteCategory,
  createPenalty,
  getPenalties,
  getPendingPenalties,
  getPenaltyStats,
  getSettings,
  updateSettings,
  getMyPenalties,
  getGivenPenalties,
  getReductions,
  getPenaltyById,
  deletePenalty,
  reviewPenalty,
  getUserPenalties,
  reducePenalty,
  getReductionPackages,
  createReductionPackage,
  updateReductionPackage,
  deleteReductionPackage,
  purchaseReductionPackage,
  getGradePenaltySettings,
  updateGradePenaltySettings,
} = require("../controllers/penalty.controller");
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const {
  createMultiFileUpload,
  handleFileUploadError,
} = require("../middleware/fileUpload.middleware");
const { ROLES } = require("../utils/constants");

router.use(protect);

// ─── Sozlamalar ─────────────────────────────────────────────────────
router.get("/settings", getSettings);
router.put("/settings", authorizePermission(PERMISSIONS.PENALTIES_SETTINGS), updateSettings);

// ─── Baho qo'ymaslik jarima sozlamalari ──────────────────────────
router.get("/grade-settings", authorizePermission(PERMISSIONS.PENALTIES_VIEW), getGradePenaltySettings);
router.put("/grade-settings", authorizePermission(PERMISSIONS.PENALTIES_SETTINGS), updateGradePenaltySettings);

// ─── Kamaytirish paketlari ─────────────────────────────────────────
router.get("/reduction-packages", getReductionPackages);
router.post("/reduction-packages", authorizePermission(PERMISSIONS.PENALTIES_PACKAGES), createReductionPackage);
router.post("/reduction-packages/purchase", authorize(ROLES.STUDENT), purchaseReductionPackage);
router.put("/reduction-packages/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.PENALTIES_PACKAGES), updateReductionPackage);
router.delete("/reduction-packages/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.PENALTIES_PACKAGES), deleteReductionPackage);

// ─── Statistika (owner) ───────────────────────────────────────────
router.get("/stats", authorizePermission(PERMISSIONS.PENALTIES_VIEW), getPenaltyStats);

// ─── Kategoriyalar ─────────────────────────────────────────────────
router.get("/categories", authorizePermission(PERMISSIONS.PENALTIES_VIEW, ROLES.TEACHER, ROLES.RECEPTION), getCategories);
router.post("/categories", authorizePermission(PERMISSIONS.PENALTIES_CATEGORIES), createPenaltyCategory);
router.put("/categories/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.PENALTIES_CATEGORIES), updateCategory);
router.delete("/categories/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.PENALTIES_CATEGORIES), deleteCategory);

// ─── Kamaytirish (owner, reception) ──────────────────────────────
router.post("/reduce", authorizePermission(PERMISSIONS.PENALTIES_REDUCE, ROLES.RECEPTION), reducePenalty);
router.get("/reductions", authorizePermission(PERMISSIONS.PENALTIES_VIEW), getReductions);

// ─── Pending (owner) ──────────────────────────────────────────────
router.get("/pending", authorizePermission(PERMISSIONS.PENALTIES_REVIEW), getPendingPenalties);

// ─── O'z jarimalari (barcha authenticated userlar) ────────────────
router.get("/my", getMyPenalties);

// ─── Bergan jarimalar (teacher, reception) ────────────────────────
router.get("/given", authorize(ROLES.TEACHER, ROLES.RECEPTION), getGivenPenalties);

// ─── Foydalanuvchi jarimalari (owner) ─────────────────────────────
router.get("/user/:userId", validateObjectId("userId"), authorizePermission(PERMISSIONS.PENALTIES_VIEW), getUserPenalties);

// ─── Jarima CRUD ──────────────────────────────────────────────────
router.post(
  "/",
  authorizePermission(PERMISSIONS.PENALTIES_CREATE, ROLES.TEACHER, ROLES.RECEPTION),
  createMultiFileUpload({
    fieldName: "files",
    categories: ["image", "video", "document"],
    maxFiles: 5,
  }),
  handleFileUploadError,
  createPenalty,
);

router.get("/", authorizePermission(PERMISSIONS.PENALTIES_VIEW), getPenalties);
router.get("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.PENALTIES_VIEW, ROLES.TEACHER), getPenaltyById);
router.put("/:id/review", validateObjectId("id"), authorizePermission(PERMISSIONS.PENALTIES_REVIEW), reviewPenalty);
router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.PENALTIES_DELETE), deletePenalty);

module.exports = router;
