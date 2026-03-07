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
} = require("../controllers/penalty.controller");
const { protect, authorize } = require("../middleware/auth.middleware");
const {
  createMultiFileUpload,
  handleFileUploadError,
} = require("../middleware/fileUpload.middleware");

router.use(protect);

// ─── Sozlamalar (owner) ────────────────────────────────────────────
router.get("/settings", authorize("owner", "teacher", "student"), getSettings);
router.put("/settings", authorize("owner"), updateSettings);

// ─── Statistika (owner) ───────────────────────────────────────────
router.get("/stats", authorize("owner"), getPenaltyStats);

// ─── Kategoriyalar ─────────────────────────────────────────────────
router.get("/categories", authorize("owner", "teacher"), getCategories);
router.post("/categories", authorize("owner"), createPenaltyCategory);
router.put("/categories/:id", authorize("owner"), updateCategory);
router.delete("/categories/:id", authorize("owner"), deleteCategory);

// ─── Kamaytirish (owner) ──────────────────────────────────────────
router.post("/reduce", authorize("owner"), reducePenalty);
router.get("/reductions", authorize("owner"), getReductions);

// ─── Pending (owner) ──────────────────────────────────────────────
router.get("/pending", authorize("owner"), getPendingPenalties);

// ─── O'z jarimalari (student, teacher) ────────────────────────────
router.get("/my", authorize("student", "teacher"), getMyPenalties);

// ─── Ustoz bergan jarimalar (teacher) ─────────────────────────────
router.get("/given", authorize("teacher"), getGivenPenalties);

// ─── Foydalanuvchi jarimalari (owner) ─────────────────────────────
router.get("/user/:userId", authorize("owner"), getUserPenalties);

// ─── Jarima CRUD ──────────────────────────────────────────────────
router.post(
  "/",
  authorize("owner", "teacher"),
  createMultiFileUpload({
    fieldName: "files",
    categories: ["image", "video", "document"],
    maxFiles: 5,
  }),
  handleFileUploadError,
  createPenalty,
);

router.get("/", authorize("owner"), getPenalties);
router.get("/:id", authorize("owner", "teacher"), getPenaltyById);
router.put("/:id/review", authorize("owner"), reviewPenalty);

module.exports = router;
