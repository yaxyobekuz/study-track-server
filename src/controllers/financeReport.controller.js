const asyncHandler = require("../middleware/async.middleware");
const { PERMISSIONS, hasPermission, hasRole } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const financeReportService = require("../services/financeReport.service");
const financeDashboardService = require("../services/financeDashboard.service");
const financeTargetService = require("../services/financeTarget.service");
const expenseBudgetService = require("../services/expenseBudget.service");
const incomePlanService = require("../services/incomePlan.service");

const getOverview = asyncHandler(async (req, res) => {
  const data = await financeReportService.getOverview(req.query);
  res.json({ success: true, data });
});

const getCashflow = asyncHandler(async (req, res) => {
  const data = await financeReportService.getCashflow(req.query);
  res.json({ success: true, data });
});

const getDebt = asyncHandler(async (req, res) => {
  const data = await financeReportService.getDebt(req.query);
  res.json({ success: true, data });
});

const getTariffBreakdown = asyncHandler(async (req, res) => {
  const data = await financeReportService.getTariffBreakdown(req.query);
  res.json({ success: true, data });
});

const getExternalIncome = asyncHandler(async (req, res) => {
  const data = await financeReportService.getExternalIncome(req.query);
  res.json({ success: true, data });
});

const getExpenseReport = asyncHandler(async (req, res) => {
  const data = await financeReportService.getExpenseReport(req.query);
  res.json({ success: true, data });
});

// ─────────────────────────────────────────────
// Rahbar dashboardi
// ─────────────────────────────────────────────

const getDashboard = asyncHandler(async (req, res) => {
  // ⚠️ KIM QANCHA OYLIK OLAYOTGANI ALOHIDA RUXSAT ostida. Dashboard
  // `reports.view` bilan ochiladi, lekin xodimlarning ism-familiyasi
  // yonidagi summa — bu `payroll.view` registrining o'zi. Moliya
  // ruxsatlari ataylab mayda (`.claude/rules/finance.md` §11): hisobotni
  // ko'rish huquqi butun oylik vedomostini ochib bermasligi kerak.
  // JAMI summa esa qoladi — u xarajat tarkibida allaqachon ko'rinadi.
  const canSeePayrollStaff =
    hasRole(req.user, ROLES.OWNER) ||
    hasPermission(req.user?.permissions ?? [], PERMISSIONS.PAYROLL_VIEW);

  const data = await financeDashboardService.getDashboard(req.query, {
    includePayrollStaff: canSeePayrollStaff,
  });

  res.json({ success: true, data });
});

const getKpiScorecard = asyncHandler(async (req, res) => {
  const data = await financeDashboardService.getKpiScorecard(req.query);
  res.json({ success: true, data });
});

const getTargets = asyncHandler(async (req, res) => {
  const data = await financeTargetService.getTargets(req.query);
  res.json({ success: true, data });
});

const saveTargets = asyncHandler(async (req, res) => {
  const data = await financeTargetService.upsertTargets(req.body, req.user.id);
  res.json({ success: true, message: "Reja saqlandi", data });
});

const getExpenseBudgets = asyncHandler(async (req, res) => {
  const data = await expenseBudgetService.getBudgets(req.query);
  res.json({ success: true, data });
});

const saveExpenseBudgets = asyncHandler(async (req, res) => {
  const data = await expenseBudgetService.upsertBudgets(req.body, req.user.id);
  res.json({ success: true, message: "Limitlar saqlandi", data });
});

const getIncomePlans = asyncHandler(async (req, res) => {
  const data = await incomePlanService.getPlans(req.query);
  res.json({ success: true, data });
});

const saveIncomePlans = asyncHandler(async (req, res) => {
  const data = await incomePlanService.upsertPlans(req.body, req.user.id);
  res.json({ success: true, message: "Yig'ish rejasi saqlandi", data });
});

module.exports = {
  getIncomePlans,
  saveIncomePlans,
  getExpenseBudgets,
  saveExpenseBudgets,
  getDashboard,
  getKpiScorecard,
  getTargets,
  saveTargets,
  getOverview,
  getCashflow,
  getExpenseReport,
  getDebt,
  getTariffBreakdown,
  getExternalIncome,
};
