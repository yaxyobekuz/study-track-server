const asyncHandler = require("../middleware/async.middleware");
const financeSettingsService = require("../services/financeSettings.service");

const getSettings = asyncHandler(async (req, res) => {
  const settings = await financeSettingsService.getSettings();
  res.json({ success: true, data: settings });
});

const updateSettings = asyncHandler(async (req, res) => {
  const { settings, warnings } = await financeSettingsService.updateSettings(
    req.body,
    req.user.id,
  );
  res.json({ success: true, data: settings, warnings });
});

const getAcademicYear = asyncHandler(async (req, res) => {
  const data = await financeSettingsService.getAcademicYear(req.query);
  res.json({ success: true, data });
});

module.exports = { getSettings, updateSettings, getAcademicYear };
