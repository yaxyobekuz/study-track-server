// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getPayments,
  getPayment,
  getStudentPayments,
  previewPayment,
  createPayment,
  voidPayment,
  updatePayment,
  replacePayment,
  editAllocation,
  releaseAllocation,
} = require("../controllers/payment.controller");

// Aniq yo'llar `/:id` dan OLDIN
// Preview hech narsa yozmaydi, lekin taqsimotni ko'rsatgani uchun `pay`
// ruxsatiga bog'lanadi — kassir ko'radigan ekranning bir qismi.
router.post("/preview", protect, authorizePermission(PERMISSIONS.FINANCE_PAY), previewPayment);
router.get("/student/:studentId", protect, validateObjectId("studentId"), authorizePermission(PERMISSIONS.FINANCE_VIEW), getStudentPayments);

// Yechim (chekning bitta oyga tushgan ulushi) — summani kamaytirish, boshqa
// oyga ko'chirish, olib tashlash. Pul kassaga kirmaydi ham, chiqmaydi ham,
// lekin oy qarzi o'zgaradi: `finance.adjust` ("amaldagi yozuvni to'g'rilash").
// Uch segmentli yo'l — `/:id/void` bilan to'qnashmaydi.
router.post("/allocations/:allocationId/edit", protect, validateObjectId("allocationId"), authorizePermission(PERMISSIONS.FINANCE_ADJUST), editAllocation);
router.post("/allocations/:allocationId/release", protect, validateObjectId("allocationId"), authorizePermission(PERMISSIONS.FINANCE_ADJUST), releaseAllocation);

router.get("/", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getPayments);
router.post("/", protect, authorizePermission(PERMISSIONS.FINANCE_PAY), createPayment);

// Bekor qilish — ALOHIDA ruxsat: kassir o'z xatosini o'zi yashira olmasin
router.post("/:id/void", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_VOID), voidPayment);

// Tahrirlash — eski to'lovni bekor qilib, tahrirlangan yangisini yaratadi.
// `finance.void` ruxsati: tahrir bekor qilishni ham o'z ichiga oladi.
router.post("/:id/replace", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_VOID), replacePayment);

router.get("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_VIEW), getPayment);
// Faqat izoh — summa va sana o'zgarmas (append-only log)
router.patch("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_PAY), updatePayment);

module.exports = router;
