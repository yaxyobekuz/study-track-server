/** INVENTAR HISOBOTLARI VA SOZLAMALARI. */

const asyncHandler = require("../middleware/async.middleware");
const reportService = require("../services/inventoryReport.service");
const settingsService = require("../services/inventorySettings.service");

const getSummary = asyncHandler(async (req, res) => {
  const data = await reportService.getSummary(req.query);
  res.json({ success: true, data });
});

const getByLocation = asyncHandler(async (req, res) => {
  const data = await reportService.getByLocation(req.query);
  res.json({ success: true, ...data });
});

const getByItem = asyncHandler(async (req, res) => {
  const data = await reportService.getByItem(req.query);
  res.json({ success: true, ...data });
});

const getDebtors = asyncHandler(async (req, res) => {
  const data = await reportService.getDebtors(req.query);
  res.json({ success: true, ...data });
});

const getMonitoringReport = asyncHandler(async (req, res) => {
  const data = await reportService.getMonitoringReport(req.query);
  res.json({ success: true, ...data });
});

const getSettings = asyncHandler(async (req, res) => {
  const data = await settingsService.getSettings();
  res.json({ success: true, data });
});

const updateSettings = asyncHandler(async (req, res) => {
  const data = await settingsService.updateSettings(req.body, req.user.id);
  res.json({ success: true, data, message: "Sozlamalar saqlandi" });
});

module.exports = {
  getSummary,
  getByLocation,
  getByItem,
  getDebtors,
  getMonitoringReport,
  getSettings,
  updateSettings,
};
