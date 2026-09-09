// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getForStudent,
  upsert,
  bulk,
  remove,
} = require("../controllers/studentMonthOverride.controller");

// Oy summasini SABAB bilan o'zgartirish — summa ota-onasiz o'zgaradi, shuning
// uchun `finance.adjust` (regenerate bilan bir xil huquq).
// Aniq yo'llar `/:id` dan OLDIN.
router.post("/bulk", protect, authorizePermission(PERMISSIONS.FINANCE_ADJUST), bulk);
router.get(
  "/student/:studentId",
  protect,
  validateObjectId("studentId"),
  authorizePermission(PERMISSIONS.FINANCE_ADJUST),
  getForStudent,
);
router.post(
  "/student/:studentId",
  protect,
  validateObjectId("studentId"),
  authorizePermission(PERMISSIONS.FINANCE_ADJUST),
  upsert,
);
router.delete(
  "/:id",
  protect,
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.FINANCE_ADJUST),
  remove,
);

module.exports = router;
