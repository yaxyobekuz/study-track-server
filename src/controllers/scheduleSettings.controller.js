const scheduleSettingsService = require("../services/scheduleSettings.service");
const asyncHandler = require("../middleware/async.middleware");

/**
 * GET /api/schedule-settings
 * @access Private (owner, teacher)
 */
exports.getSettings = asyncHandler(async (req, res) => {
  const settings = await scheduleSettingsService.getSettings();
  return res.json({ success: true, data: settings });
});

/**
 * PUT /api/schedule-settings
 * @access Private (owner only)
 */
exports.updateSettings = asyncHandler(async (req, res) => {
  const settings = await scheduleSettingsService.updateSettings(
    req.body,
    req.user._id,
  );
  return res.json({
    success: true,
    message: "Sozlamalar saqlandi",
    data: settings,
  });
});
