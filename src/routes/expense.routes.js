// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getExpenses,
  createExpense,
  voidExpense,
} = require("../controllers/expense.controller");

// Amallar ATAYLAB mayda: xarajat qo'sha oladigan xodim uni BEKOR QILA
// olmasligi kerak — bekor qilish kassa qoldig'ini oshiradi.
router.get("/", protect, authorizePermission(PERMISSIONS.EXPENSES_VIEW), getExpenses);
router.post("/", protect, authorizePermission(PERMISSIONS.EXPENSES_CREATE), createExpense);
router.post("/:id/void", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.EXPENSES_VOID), voidExpense);

module.exports = router;
