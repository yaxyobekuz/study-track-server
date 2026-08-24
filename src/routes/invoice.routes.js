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
  getStudentRegistry,
  getDebtors,
  getStudentInvoices,
  getInvoice,
  generateInvoices,
  updateInvoice,
  cancelInvoice,
  regenerateInvoice,
  restoreInvoice,
  getInvoicePayments,
} = require("../controllers/invoice.controller");

// DIQQAT: router darajasida `authorizeSection` QO'YILMAYDI — o'quvchida moliya
// ruxsati yo'q va u o'z ma'lumotiga ham kira olmay qolardi. Har route o'z
// guard'ini oladi.

// O'quvchining o'z ma'lumoti — ruxsatsiz, faqat rol bo'yicha.
// `/:id` dan OLDIN turishi shart, aks holda "my" id sifatida o'qiladi.
router.get("/my", protect, authorize(ROLES.STUDENT), getMyFinance);

// Aniq yo'llar `/:id` dan OLDIN
router.get("/summary", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getSummary);
// Kassirning asosiy ekrani — `/student/:studentId` dan oldin bo'lishi shart emas,
// lekin `/:id` dan OLDIN
router.get("/students", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getStudentRegistry);
// Qarzdorlar — o'quvchidan emas, QARZDAN boshlanadigan ro'yxat
router.get("/debtors", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getDebtors);
router.post("/generate", protect, authorizePermission(PERMISSIONS.FINANCE_GENERATE), generateInvoices);
router.get("/student/:studentId", protect, validateObjectId("studentId"), authorizePermission(PERMISSIONS.FINANCE_VIEW), getStudentInvoices);

router.get("/", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getInvoices);

// To'lov QABUL QILISH bu yerda emas — `POST /api/payments` (o'quvchiga
// bitta summa, tizim oylarga taqsimlaydi).
router.get("/:id/payments", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_VIEW), getInvoicePayments);
router.post("/:id/cancel", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_CANCEL), cancelInvoice);
// Bekor qilib qayta yaratish — tarixni qayta yozish
router.post("/:id/regenerate", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_ADJUST), regenerateInvoice);
router.post("/:id/restore", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_ADJUST), restoreInvoice);

router.get("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_VIEW), getInvoice);
// Faqat izoh — summa/oy/o'quvchi o'zgarmas (qaytarilmaslik qoidasi)
router.patch("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_PAY), updateInvoice);

module.exports = router;
