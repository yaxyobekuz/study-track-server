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
} = require("../controllers/payment.controller");

// Aniq yo'llar `/:id` dan OLDIN
// Preview hech narsa yozmaydi, lekin taqsimotni ko'rsatgani uchun `pay`
// ruxsatiga bog'lanadi — kassir ko'radigan ekranning bir qismi.
router.post("/preview", protect, authorizePermission(PERMISSIONS.FINANCE_PAY), previewPayment);
router.get("/student/:studentId", protect, validateObjectId("studentId"), authorizePermission(PERMISSIONS.FINANCE_VIEW), getStudentPayments);

router.get("/", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getPayments);
router.post("/", protect, authorizePermission(PERMISSIONS.FINANCE_PAY), createPayment);

// Bekor qilish — ALOHIDA ruxsat: kassir o'z xatosini o'zi yashira olmasin
router.post("/:id/void", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_VOID), voidPayment);

router.get("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_VIEW), getPayment);
// Faqat izoh — summa va sana o'zgarmas (append-only log)
router.patch("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_PAY), updatePayment);

module.exports = router;
