/**
 * KUNLIK MONITORING HISOBOTI.
 *
 * ⚠️ `PUT /:id` yo'q va bo'lmasligi ham kerak: yuborilgan hisobot
 * MUHRLANGAN hujjat. Xato bo'lsa — zarar yozuvi bekor qilinadi yoki
 * xatlov qo'lda to'g'rilanadi, ikkalasi ham ko'rinadigan amal.
 */

const express = require("express");
const router = express.Router();

const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const {
  createMultiFileUpload,
  handleFileUploadError,
} = require("../middleware/fileUpload.middleware");
const { PERMISSIONS } = require("../utils/permissions");

const {
  getChecks,
  getCheckById,
  getPendingLocations,
  openCheck,
  updateCheckLines,
  attachLineFiles,
  submitCheck,
  deleteCheck,
} = require("../controllers/inventoryCheck.controller");

router.use(protect);

// "Bugun kim hisobot bermadi" — eslatma job'i va admin paneldagi blok
// bir xil manbadan o'qiydi
router.get("/pending", authorizePermission(PERMISSIONS.MONITORING_VIEW), getPendingLocations);

router.get("/", authorizePermission(PERMISSIONS.MONITORING_VIEW), getChecks);
router.get("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.MONITORING_VIEW), getCheckById);

// Varaq ochish IDEMPOTENT: shu kun uchun varaq bo'lsa o'sha qaytadi
router.post("/", authorizePermission(PERMISSIONS.MONITORING_SUBMIT), openCheck);
router.put("/:id/lines", validateObjectId("id"), authorizePermission(PERMISSIONS.MONITORING_SUBMIT), updateCheckLines);

// Rasm — faqat sindirilgan satrga qo'shiladi, shuning uchun alohida
// endpoint (satrlarni saqlash JSON so'rovi bo'lib qoladi)
router.post(
  "/:id/lines/:lineId/attachments",
  validateObjectId("id"),
  validateObjectId("lineId"),
  authorizePermission(PERMISSIONS.MONITORING_SUBMIT),
  createMultiFileUpload({
    fieldName: "files",
    categories: ["image", "video", "document"],
    maxFiles: 5,
  }),
  handleFileUploadError,
  attachLineFiles,
);

router.post("/:id/submit", validateObjectId("id"), authorizePermission(PERMISSIONS.MONITORING_SUBMIT), submitCheck);
router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.MONITORING_DELETE), deleteCheck);

module.exports = router;
