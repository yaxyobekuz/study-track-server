const asyncHandler = require("../middleware/async.middleware");
const payrollViewService = require("../services/payrollView.service");

/** Staff bo'lim xodimlari + hisoblangan oylik. */
const getStaffPayroll = asyncHandler(async (req, res) => {
  const data = await payrollViewService.getStaffPayroll(req);
  res.json({ success: true, ...data });
});

/** Toifa o'qituvchilari + hisoblangan oylik. */
const getTeacherPayroll = asyncHandler(async (req, res) => {
  const data = await payrollViewService.getTeacherPayroll(req);
  res.json({ success: true, ...data });
});

module.exports = { getStaffPayroll, getTeacherPayroll };
