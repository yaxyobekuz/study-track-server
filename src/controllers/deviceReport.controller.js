/**
 * QURILMA NAZORATI — MANZARA VA HISOBOTLAR (kontroller, yupqa).
 */

const asyncHandler = require("../middleware/async.middleware");
const deviceReportService = require("../services/deviceReport.service");

const getDashboard = asyncHandler(async (req, res) => {
  const data = await deviceReportService.getDashboard(req.query);
  res.json({ success: true, data });
});

const getUsageReport = asyncHandler(async (req, res) => {
  const data = await deviceReportService.getUsageReport(req.query);
  res.json({ success: true, data });
});

const getStudentOverview = asyncHandler(async (req, res) => {
  const data = await deviceReportService.getStudentOverview(req.params.studentId, req.query);
  res.json({ success: true, data });
});

module.exports = { getDashboard, getUsageReport, getStudentOverview };
