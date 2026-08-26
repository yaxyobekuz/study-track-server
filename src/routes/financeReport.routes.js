// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getOverview,
  getCashflow,
  getDebt,
  getTariffBreakdown,
  getExternalIncome,
} = require("../controllers/financeReport.controller");

// Hisobotlar ALOHIDA ruxsat talab qiladi: bitta ekranda butun maktabning pul
// manzarasi (tushum, qarz, sinf kesimi) ko'rinadi, shuning uchun uni moliya
// bo'limini ko'rish huquqi bilan birga berib yubormaymiz.
router.get("/overview", protect, authorizePermission(PERMISSIONS.REPORTS_VIEW), getOverview);
router.get("/cashflow", protect, authorizePermission(PERMISSIONS.REPORTS_VIEW), getCashflow);
router.get("/debt", protect, authorizePermission(PERMISSIONS.REPORTS_VIEW), getDebt);
router.get("/tariffs", protect, authorizePermission(PERMISSIONS.REPORTS_VIEW), getTariffBreakdown);
router.get("/external", protect, authorizePermission(PERMISSIONS.REPORTS_VIEW), getExternalIncome);

module.exports = router;
