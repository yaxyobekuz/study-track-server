const asyncHandler = require("../middleware/async.middleware");
const financeReportService = require("../services/financeReport.service");

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

module.exports = {
  getOverview,
  getCashflow,
  getDebt,
  getTariffBreakdown,
  getExternalIncome,
};
