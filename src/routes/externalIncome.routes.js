// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getIncomes,
  createIncome,
  voidIncome,
} = require("../controllers/externalIncome.controller");

// Amallar ATAYLAB mayda: kirim qo'sha oladigan xodim uni BEKOR QILA
// olmasligi kerak — bekor qilish kassa qoldig'ini kamaytiradi.
router.get("/", protect, authorizePermission(PERMISSIONS.INCOME_VIEW), getIncomes);
router.post("/", protect, authorizePermission(PERMISSIONS.INCOME_CREATE), createIncome);
router.post("/:id/void", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.INCOME_VOID), voidIncome);

module.exports = router;
