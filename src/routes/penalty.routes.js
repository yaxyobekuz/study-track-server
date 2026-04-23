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
  reviewPenalty,
  getUserPenalties,
  reducePenalty,
  getReductionPackages,
  createReductionPackage,
  updateReductionPackage,
  deleteReductionPackage,
  purchaseReductionPackage,
} = require("../controllers/penalty.controller");
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const {
  createMultiFileUpload,
  handleFileUploadError,
} = require("../middleware/fileUpload.middleware");
const { ROLES } = require("../utils/constants");

router.use(protect);

// ─── Sozlamalar ─────────────────────────────────────────────────────
router.get("/settings", getSettings);
router.put("/settings", authorize(ROLES.OWNER), updateSettings);

// ─── Kamaytirish paketlari ─────────────────────────────────────────
router.get("/reduction-packages", getReductionPackages);
router.post("/reduction-packages", authorize(ROLES.OWNER), createReductionPackage);
router.post("/reduction-packages/purchase", authorize(ROLES.STUDENT), purchaseReductionPackage);
router.put("/reduction-packages/:id", validateObjectId("id"), authorize(ROLES.OWNER), updateReductionPackage);
router.delete("/reduction-packages/:id", validateObjectId("id"), authorize(ROLES.OWNER), deleteReductionPackage);

// ─── Statistika (owner) ───────────────────────────────────────────
router.get("/stats", authorize(ROLES.OWNER), getPenaltyStats);

// ─── Kategoriyalar ─────────────────────────────────────────────────
router.get("/categories", authorize(ROLES.OWNER, ROLES.TEACHER), getCategories);
router.post("/categories", authorize(ROLES.OWNER), createPenaltyCategory);
router.put("/categories/:id", validateObjectId("id"), authorize(ROLES.OWNER), updateCategory);
router.delete("/categories/:id", validateObjectId("id"), authorize(ROLES.OWNER), deleteCategory);

// ─── Kamaytirish (owner) ──────────────────────────────────────────
router.post("/reduce", authorize(ROLES.OWNER), reducePenalty);
router.get("/reductions", authorize(ROLES.OWNER), getReductions);

// ─── Pending (owner) ──────────────────────────────────────────────
router.get("/pending", authorize(ROLES.OWNER), getPendingPenalties);

// ─── O'z jarimalari (barcha authenticated userlar) ────────────────
router.get("/my", getMyPenalties);

// ─── Ustoz bergan jarimalar (teacher) ─────────────────────────────
router.get("/given", authorize(ROLES.TEACHER), getGivenPenalties);

// ─── Foydalanuvchi jarimalari (owner) ─────────────────────────────
router.get("/user/:userId", validateObjectId("userId"), authorize(ROLES.OWNER), getUserPenalties);

// ─── Jarima CRUD ──────────────────────────────────────────────────
router.post(
  "/",
  authorize(ROLES.OWNER, ROLES.TEACHER),
  createMultiFileUpload({
    fieldName: "files",
    categories: ["image", "video", "document"],
    maxFiles: 5,
  }),
  handleFileUploadError,
  createPenalty,
);

router.get("/", authorize(ROLES.OWNER), getPenalties);
router.get("/:id", validateObjectId("id"), authorize(ROLES.OWNER, ROLES.TEACHER), getPenaltyById);
router.put("/:id/review", validateObjectId("id"), authorize(ROLES.OWNER), reviewPenalty);

module.exports = router;
