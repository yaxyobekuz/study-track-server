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
router.put("/settings", authorizePermission(PERMISSIONS.PENALTIES), updateSettings);

// ─── Baho qo'ymaslik jarima sozlamalari ──────────────────────────
router.get("/grade-settings", authorizePermission(PERMISSIONS.PENALTIES), getGradePenaltySettings);
router.put("/grade-settings", authorizePermission(PERMISSIONS.PENALTIES), updateGradePenaltySettings);

// ─── Kamaytirish paketlari ─────────────────────────────────────────
router.get("/reduction-packages", getReductionPackages);
router.post("/reduction-packages", authorizePermission(PERMISSIONS.PENALTIES), createReductionPackage);
router.post("/reduction-packages/purchase", authorize(ROLES.STUDENT), purchaseReductionPackage);
router.put("/reduction-packages/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.PENALTIES), updateReductionPackage);
router.delete("/reduction-packages/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.PENALTIES), deleteReductionPackage);

// ─── Statistika (owner) ───────────────────────────────────────────
router.get("/stats", authorizePermission(PERMISSIONS.PENALTIES), getPenaltyStats);

// ─── Kategoriyalar ─────────────────────────────────────────────────
router.get("/categories", authorizePermission(PERMISSIONS.PENALTIES, ROLES.TEACHER, ROLES.RECEPTION), getCategories);
router.post("/categories", authorizePermission(PERMISSIONS.PENALTIES), createPenaltyCategory);
router.put("/categories/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.PENALTIES), updateCategory);
router.delete("/categories/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.PENALTIES), deleteCategory);

// ─── Kamaytirish (owner, reception) ──────────────────────────────
router.post("/reduce", authorizePermission(PERMISSIONS.PENALTIES, ROLES.RECEPTION), reducePenalty);
router.get("/reductions", authorizePermission(PERMISSIONS.PENALTIES), getReductions);

// ─── Pending (owner) ──────────────────────────────────────────────
router.get("/pending", authorizePermission(PERMISSIONS.PENALTIES), getPendingPenalties);

// ─── O'z jarimalari (barcha authenticated userlar) ────────────────
router.get("/my", getMyPenalties);

// ─── Bergan jarimalar (teacher, reception) ────────────────────────
router.get("/given", authorize(ROLES.TEACHER, ROLES.RECEPTION), getGivenPenalties);

// ─── Foydalanuvchi jarimalari (owner) ─────────────────────────────
router.get("/user/:userId", validateObjectId("userId"), authorizePermission(PERMISSIONS.PENALTIES), getUserPenalties);

// ─── Jarima CRUD ──────────────────────────────────────────────────
router.post(
  "/",
  authorizePermission(PERMISSIONS.PENALTIES, ROLES.TEACHER, ROLES.RECEPTION),
  createMultiFileUpload({
    fieldName: "files",
    categories: ["image", "video", "document"],
    maxFiles: 5,
  }),
  handleFileUploadError,
  createPenalty,
);

router.get("/", authorizePermission(PERMISSIONS.PENALTIES), getPenalties);
router.get("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.PENALTIES, ROLES.TEACHER), getPenaltyById);
router.put("/:id/review", validateObjectId("id"), authorizePermission(PERMISSIONS.PENALTIES), reviewPenalty);
router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.PENALTIES), deletePenalty);

module.exports = router;
