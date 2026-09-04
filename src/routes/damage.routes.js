/**
 * MODDIY ZARAR — hodisa, aybdorga yozilgan qarz va undiruv.
 *
 * ⚠️ Amallar ATAYLAB mayda (`finance` bilan bir xil mulohaza):
 * zararni QAYD ETADIGAN odam (mas'ul shaxs) uni aybdorga YOZA olmasligi,
 * aybdorga yozadigan odam esa undiruvni BEKOR QILA olmasligi kerak.
 *
 * ⚠️ Zarar va qarz summasini O'ZGARTIRADIGAN endpoint YO'Q — ikkalasi ham
 * MUHRLANGAN (`MonthlyInvoice` doktrinasi). Xato bo'lsa: bekor qilinadi
 * va qaytadan kiritiladi.
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
  getDamages,
  getDamageById,
  createDamage,
  waiveDamage,
  unwaiveDamage,
  cancelDamage,
  getCharges,
  getChargeById,
  getPersonSummary,
  createCharges,
  updateCharge,
  cancelCharge,
  getPayments,
  previewPayment,
  createPayment,
  voidPayment,
} = require("../controllers/inventoryDamage.controller");

router.use(protect);

// ─── Qarzlar registri ────────────────────────
// `/charges` `/:id` dan OLDIN: aks holda "charges" so'zi id sifatida
// o'qilardi.
router.get("/charges", authorizePermission(PERMISSIONS.DAMAGES_VIEW), getCharges);
router.get("/charges/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.DAMAGES_VIEW), getChargeById);
router.put("/charges/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.DAMAGES_CHARGE), updateCharge);
router.post("/charges/:id/cancel", validateObjectId("id"), authorizePermission(PERMISSIONS.DAMAGES_CANCEL), cancelCharge);

/**
 * BITTA ODAMNING QARZI — profildagi "moddiy zarar qarzdorligi" bloki.
 * Talabning "toʻliq undirilguniga qadar uning hisobida aks etib turishi"
 * qismi aynan shu javob orqali bajariladi.
 */
router.get("/person/:personId", validateObjectId("personId"), authorizePermission(PERMISSIONS.DAMAGES_VIEW), getPersonSummary);

// ─── Undiruv (to'lov) ────────────────────────
router.get("/payments", authorizePermission(PERMISSIONS.DAMAGES_VIEW), getPayments);
router.post("/payments/preview", authorizePermission(PERMISSIONS.DAMAGES_PAY), previewPayment);
router.post("/payments", authorizePermission(PERMISSIONS.DAMAGES_PAY), createPayment);
router.post("/payments/:id/void", validateObjectId("id"), authorizePermission(PERMISSIONS.DAMAGES_VOID), voidPayment);

// ─── Zarar hodisasi ──────────────────────────
router.get("/", authorizePermission(PERMISSIONS.DAMAGES_VIEW), getDamages);

router.post(
  "/",
  authorizePermission(PERMISSIONS.DAMAGES_CREATE),
  createMultiFileUpload({
    fieldName: "files",
    categories: ["image", "video", "document"],
    maxFiles: 5,
  }),
  handleFileUploadError,
  createDamage,
);

router.get("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.DAMAGES_VIEW), getDamageById);
router.post("/:id/charges", validateObjectId("id"), authorizePermission(PERMISSIONS.DAMAGES_CHARGE), createCharges);
router.post("/:id/waive", validateObjectId("id"), authorizePermission(PERMISSIONS.DAMAGES_WAIVE), waiveDamage);
router.post("/:id/unwaive", validateObjectId("id"), authorizePermission(PERMISSIONS.DAMAGES_WAIVE), unwaiveDamage);
router.post("/:id/cancel", validateObjectId("id"), authorizePermission(PERMISSIONS.DAMAGES_CANCEL), cancelDamage);

module.exports = router;
