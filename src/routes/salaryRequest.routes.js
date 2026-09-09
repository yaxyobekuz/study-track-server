// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const {
  createMultiFileUpload,
  handleFileUploadError,
} = require("../middleware/fileUpload.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controllers
const {
  submitRequest,
  getMyRequests,
  cancelRequest,
  getAllRequests,
  reviewRequest,
} = require("../controllers/salaryRequest.controller");

// So'rovga hujjat/rasm biriktiriladi (sertifikat, diplom, buyruq...).
// `createMultiFileUpload` filial kontekstini o'zi saqlaydi (withBranchContext).
const uploadAttachments = createMultiFileUpload({
  fieldName: "files",
  categories: ["image", "document"],
  maxFiles: 5,
});

router.use(protect);

// ── XODIM TOMONI (o'z so'rovlari — alohida ruxsat kerak emas) ──
router.get("/mine", getMyRequests);
router.post("/", uploadAttachments, handleFileUploadError, submitRequest);
router.delete("/:id", validateObjectId("id"), cancelRequest);

// ── ADMIN TOMONI ──
router.get("/", authorizePermission(PERMISSIONS.SALARYREQUESTS_VIEW), getAllRequests);
router.post(
  "/:id/review",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.SALARYREQUESTS_REVIEW),
  reviewRequest,
);

module.exports = router;
