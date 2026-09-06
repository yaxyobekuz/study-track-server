/**
 * INVENTAR DASHBOARDI — bitta o'qish endpointi.
 *
 * Kontroller ATAYLAB ingichka: butun hisob-kitob servisda
 * (`inventoryDashboard.service.js`), bu yerda faqat so'rov parametrlari
 * uzatiladi. `academicDashboard.controller.js` bilan bir xil shakl.
 */

const asyncHandler = require("../middleware/async.middleware");
const inventoryDashboardService = require("../services/inventoryDashboard.service");

const getOverview = asyncHandler(async (req, res) => {
  const data = await inventoryDashboardService.getOverview(req.query);
  res.json({ success: true, data });
});

module.exports = { getOverview };
