// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getDashboard,
  getKpiScorecard,
  getTargets,
  saveTargets,
  getOverview,
  getCashflow,
  getDebt,
  getTariffBreakdown,
  getExternalIncome,
  getExpenseReport,
} = require("../controllers/financeReport.controller");

// Hisobotlar ALOHIDA ruxsat talab qiladi: bitta ekranda butun maktabning pul
// manzarasi (tushum, qarz, sinf kesimi) ko'rinadi, shuning uchun uni moliya
// bo'limini ko'rish huquqi bilan birga berib yubormaymiz.
// RAHBAR DASHBOARDI — hisobotlarning eng yig'iq ko'rinishi, shuning uchun
// ayni `reports.view` ruxsati bilan ochiladi: u allaqachon "butun maktabning
// pul manzarasi" degan chegara.
router.get("/dashboard", protect, authorizePermission(PERMISSIONS.REPORTS_VIEW), getDashboard);
router.get("/kpi", protect, authorizePermission(PERMISSIONS.REPORTS_VIEW), getKpiScorecard);

// REJA (byudjet). Ko'rish — dashboard bilan bir xil huquq (raqam baribir
// ekranda turadi), YOZISH esa alohida: reja qo'yish rahbarning qarori va
// hisobotni "bajarildi" ko'rinishiga keltirishning eng oson yo'li.
router.get("/targets", protect, authorizePermission(PERMISSIONS.REPORTS_VIEW), getTargets);
router.put("/targets", protect, authorizePermission(PERMISSIONS.REPORTS_PLAN), saveTargets);

router.get("/overview", protect, authorizePermission(PERMISSIONS.REPORTS_VIEW), getOverview);
router.get("/cashflow", protect, authorizePermission(PERMISSIONS.REPORTS_VIEW), getCashflow);
router.get("/debt", protect, authorizePermission(PERMISSIONS.REPORTS_VIEW), getDebt);
router.get("/tariffs", protect, authorizePermission(PERMISSIONS.REPORTS_VIEW), getTariffBreakdown);
router.get("/external", protect, authorizePermission(PERMISSIONS.REPORTS_VIEW), getExternalIncome);
router.get("/expenses", protect, authorizePermission(PERMISSIONS.REPORTS_VIEW), getExpenseReport);

module.exports = router;
