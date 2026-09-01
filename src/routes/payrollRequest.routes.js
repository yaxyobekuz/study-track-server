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
  getAvailableCategories,
  cancelRequest,
  getAllRequests,
  reviewRequest,
  getAuditLog,
} = require("../controllers/payrollRequest.controller");

// Zayavkaga hujjat/rasm biriktiriladi (dalolatnoma, sertifikat, diplom...)
const uploadAttachments = createMultiFileUpload({
  fieldName: "files",
  categories: ["image", "document"],
  maxFiles: 5,
});

router.use(protect);

// ── XODIM TOMONI (o'z zayavkalari — alohida ruxsat kerak emas) ──
// Har bir autentifikatsiyalangan xodim o'zi uchun zayavka yubora oladi.
router.get("/mine", getMyRequests);
router.get("/available-categories", getAvailableCategories);
router.post("/", uploadAttachments, handleFileUploadError, submitRequest);
router.delete("/:id", validateObjectId("id"), cancelRequest);

// ── ADMIN TOMONI ──
// `/audit` `/:id` yo'llaridan OLDIN emas (GET), lekin barqarorlik uchun yuqorida.
router.get("/audit", authorizePermission(PERMISSIONS.PAYROLLREQUESTS_VIEW), getAuditLog);
router.get("/", authorizePermission(PERMISSIONS.PAYROLLREQUESTS_VIEW), getAllRequests);
router.post(
  "/:id/review",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.PAYROLLREQUESTS_REVIEW),
  reviewRequest,
);

module.exports = router;
