// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getVacationMonths,
  createVacationMonth,
  deleteVacationMonth,
} = require("../controllers/payment.controller");

// Ko'rish — moliyani ko'radigan hamma uchun (o'quv yili grid'i);
// o'zgartirish esa sozlamalar ruxsati bilan.
router.get("/", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getVacationMonths);
router.post("/", protect, authorizePermission(PERMISSIONS.FINANCE_SETTINGS), createVacationMonth);
router.delete("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.FINANCE_SETTINGS), deleteVacationMonth);

module.exports = router;
