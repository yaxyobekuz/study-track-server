const asyncHandler = require("../middleware/async.middleware");
const studentTariffService = require("../services/studentTariff.service");

const getAssignments = asyncHandler(async (req, res) => {
  const result = await studentTariffService.getAssignments(req);
  res.json(result);
});

const getStudentHistory = asyncHandler(async (req, res) => {
  const result = await studentTariffService.getStudentHistory(
    req.params.studentId,
  );
  res.json({ success: true, ...result });
});

const getAssignment = asyncHandler(async (req, res) => {
  const assignment = await studentTariffService.getAssignmentById(req.params.id);
  res.json({ success: true, data: assignment });
});

const createAssignment = asyncHandler(async (req, res) => {
  const assignment = await studentTariffService.createAssignment(
    req.body,
    req.user.id,
  );
  res.status(201).json({ success: true, data: assignment });
});

const bulkAssign = asyncHandler(async (req, res) => {
  const result = await studentTariffService.bulkAssign(req.body, req.user.id);
  res.status(201).json({ success: true, data: result });
});

const updateAssignment = asyncHandler(async (req, res) => {
  const assignment = await studentTariffService.updateAssignment(
    req.params.id,
    req.body,
  );
  res.json({ success: true, data: assignment });
});

const closeAssignment = asyncHandler(async (req, res) => {
  const assignment = await studentTariffService.closeAssignment(
    req.params.id,
    req.body.endMonth,
  );
  res.json({ success: true, data: assignment });
});

const changeTariff = asyncHandler(async (req, res) => {
  const result = await studentTariffService.changeTariff(
    req.params.id,
    req.body,
    req.user.id,
  );
  res.json({ success: true, data: result });
});

const deleteAssignment = asyncHandler(async (req, res) => {
  const result = await studentTariffService.deleteAssignment(req.params.id);
  res.json({ success: true, ...result });
});

module.exports = {
  getAssignments,
  getStudentHistory,
  getAssignment,
  createAssignment,
  bulkAssign,
  updateAssignment,
  closeAssignment,
  changeTariff,
  deleteAssignment,
};
