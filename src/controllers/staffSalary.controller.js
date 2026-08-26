const asyncHandler = require("../middleware/async.middleware");
const staffSalaryService = require("../services/staffSalary.service");

const getSalaries = asyncHandler(async (req, res) => {
  const data = await staffSalaryService.getSalaries(req);
  res.json({ success: true, ...data });
});

const getStaffHistory = asyncHandler(async (req, res) => {
  const data = await staffSalaryService.getStaffHistory(req.params.staffId);
  res.json({ success: true, data });
});

const createSalary = asyncHandler(async (req, res) => {
  const data = await staffSalaryService.createSalary(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const updateSalary = asyncHandler(async (req, res) => {
  const data = await staffSalaryService.updateSalary(req.params.id, req.body);
  res.json({ success: true, data });
});

const closeSalary = asyncHandler(async (req, res) => {
  const data = await staffSalaryService.closeSalary(req.params.id, req.body.endMonth);
  res.json({ success: true, data });
});

const deleteSalary = asyncHandler(async (req, res) => {
  const data = await staffSalaryService.deleteSalary(req.params.id);
  res.json({ success: true, ...data });
});

module.exports = {
  getSalaries,
  getStaffHistory,
  createSalary,
  updateSalary,
  closeSalary,
  deleteSalary,
};
