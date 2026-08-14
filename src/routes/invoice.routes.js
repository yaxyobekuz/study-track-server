// Express
const express = require("express");
const router = express.Router();

// Middleware
const {
  protect,
  authorize,
  authorizePermission,
} = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");

// Controller
const {
  getMyFinance,
  getInvoices,
  getSummary,
  getStudentInvoices,
  getInvoice,
  generateInvoices,
  updateInvoice,
  cancelInvoice,
  restoreInvoice,
  createPayment,
  getPayments,
} = require("../controllers/invoice.controller");

// DIQQAT: router darajasida `authorizeSection` QO'YILMAYDI — o'quvchida moliya
// ruxsati yo'q va u o'z ma'lumotiga ham kira olmay qolardi. Har route o'z
// guard'ini oladi.

// O'quvchining o'z ma'lumoti — ruxsatsiz, faqat rol bo'yicha.
// `/:id` dan OLDIN turishi shart, aks holda "my" id sifatida o'qiladi.
router.get("/my", protect, authorize(ROLES.STUDENT), getMyFinance);

// Aniq yo'llar `/:id` dan OLDIN
router.get("/summary", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getSummary);
router.post("/generate", protect, authorizePermission(PERMISSIONS.FINANCE_GENERATE), generateInvoices);
router.get("/student/:studentId", protect, validateObjectId("studentId"), authorizePermission(PERMISSIONS.FINANCE_VIEW), getStudentInvoices);

router.get("/", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getInvoices);

router.post("/:id/payments", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_PAY), createPayment);
router.get("/:id/payments", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_VIEW), getPayments);
router.post("/:id/cancel", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_CANCEL), cancelInvoice);
router.post("/:id/restore", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_ADJUST), restoreInvoice);

router.get("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_VIEW), getInvoice);
// Faqat izoh — summa/oy/o'quvchi o'zgarmas (qaytarilmaslik qoidasi)
router.patch("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_PAY), updateInvoice);

module.exports = router;
