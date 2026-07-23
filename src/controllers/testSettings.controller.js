const testSettingsService = require("../services/testSettings.service");
const asyncHandler = require("../middleware/async.middleware");

/**
 * GET /api/test-settings
 * @access Private (owner only)
 */
exports.getSettings = asyncHandler(async (req, res) => {
  const settings = await testSettingsService.getSettings();
  return res.json({ success: true, data: settings });
});

/**
 * PUT /api/test-settings
 * @access Private (owner only)
 */
exports.updateSettings = asyncHandler(async (req, res) => {
  const settings = await testSettingsService.updateSettings(
    req.body,
    req.user.id,
  );
  return res.json({
    success: true,
    message: "Sozlamalar saqlandi",
    data: settings,
  });
});
