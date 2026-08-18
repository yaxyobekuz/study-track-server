// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getStudentAccount,
  getMovements,
  applyDeposit,
  refundDeposit,
  adjustBalance,
} = require("../controllers/payment.controller");

// Barcha yo'llar `:studentId` bilan boshlanadi — `/:id` tuzog'i yo'q
router.get("/:studentId", protect, validateObjectId("studentId"), authorizePermission(PERMISSIONS.FINANCE_VIEW), getStudentAccount);
router.get("/:studentId/movements", protect, validateObjectId("studentId"), authorizePermission(PERMISSIONS.FINANCE_VIEW), getMovements);

// Depozitni qo'llash — pul yaratmaydi, faqat ichki taqsimot
router.post("/:studentId/apply", protect, validateObjectId("studentId"), authorizePermission(PERMISSIONS.FINANCE_PAY), applyDeposit);
// Qaytarish — pul to'lov turidan chiqadi
router.post("/:studentId/refund", protect, validateObjectId("studentId"), authorizePermission(PERMISSIONS.FINANCE_REFUND), refundDeposit);
// Qo'lda to'g'rilash — sababsiz pul yaratadi/yo'q qiladi
router.post("/:studentId/adjust", protect, validateObjectId("studentId"), authorizePermission(PERMISSIONS.FINANCE_ADJUST), adjustBalance);

module.exports = router;
