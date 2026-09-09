const asyncHandler = require("../middleware/async.middleware");
const payrollViewService = require("../services/payrollView.service");

const getStaffPayroll = asyncHandler(async (req, res) => {
  const data = await payrollViewService.getStaffPayroll(req);
  res.json(data);
});

const getTeacherPayroll = asyncHandler(async (req, res) => {
  const data = await payrollViewService.getTeacherPayroll(req);
  res.json(data);
});

module.exports = { getStaffPayroll, getTeacherPayroll };
