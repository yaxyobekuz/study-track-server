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
  updatePayment,
  voidPayment,
} = require("../controllers/invoicePayment.controller");

// To'lovlar registri — kassaning kunlik/oylik hisoboti
router.get("/", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getPayments);

// Faqat izoh o'zgaradi — summa/sana o'zgarmas (append-only log)
router.patch("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_PAY), updatePayment);

// Soft void — yozuv bazadan chiqmaydi
router.delete("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_ADJUST), voidPayment);

module.exports = router;
