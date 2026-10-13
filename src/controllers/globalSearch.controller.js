// GLOBAL QIDIRUV — sidebar qidiruvi (`globalSearch.service.js`).
//
// Faqat foydalanuvchilar serverdan qidiriladi; sahifalar frontend
// marshrutlari bo'lgani uchun o'sha yerda filtrlanadi.

const asyncHandler = require("../middleware/async.middleware");
const globalSearchService = require("../services/globalSearch.service");

const searchUsers = asyncHandler(async (req, res) => {
  const data = await globalSearchService.searchUsers(req.user, req.query ?? {});
  res.json({ success: true, data });
});

module.exports = { searchUsers };
