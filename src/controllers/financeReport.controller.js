const asyncHandler = require("../middleware/async.middleware");
const financeReportService = require("../services/financeReport.service");
const financeDashboardService = require("../services/financeDashboard.service");
const financeTargetService = require("../services/financeTarget.service");

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
  const data = await financeDashboardService.getDashboard(req.query);
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

module.exports = {
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
