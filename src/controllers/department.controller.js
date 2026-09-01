const asyncHandler = require("../middleware/async.middleware");
const departmentService = require("../services/department.service");
const positionService = require("../services/position.service");

const getDepartments = asyncHandler(async (req, res) => {
  const data = await departmentService.getDepartments(req.query);
  res.json({ success: true, data });
});

const createDepartment = asyncHandler(async (req, res) => {
  const data = await departmentService.createDepartment(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const updateDepartment = asyncHandler(async (req, res) => {
  const data = await departmentService.updateDepartment(req.params.id, req.body);
  res.json({ success: true, data });
});

const deleteDepartment = asyncHandler(async (req, res) => {
  const data = await departmentService.deleteDepartment(req.params.id);
  res.json({ success: true, ...data });
});

// ── Lavozimlar (bo'lim ichida) ──
const getPositions = asyncHandler(async (req, res) => {
  const data = await positionService.getPositions(req.query);
  res.json({ success: true, data });
});

const createPosition = asyncHandler(async (req, res) => {
  const data = await positionService.createPosition(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const updatePosition = asyncHandler(async (req, res) => {
  const data = await positionService.updatePosition(req.params.id, req.body, req.user.id);
  res.json({ success: true, data });
});

const deletePosition = asyncHandler(async (req, res) => {
  const data = await positionService.deletePosition(req.params.id);
  res.json({ success: true, ...data });
});

// Xodimni lavozim/toifaga biriktirish
const assignStaff = asyncHandler(async (req, res) => {
  const data = await departmentService.assignStaff(req.params.staffId, req.body, req.user.id);
  res.json({ success: true, data });
});

module.exports = {
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  getPositions,
  createPosition,
  updatePosition,
  deletePosition,
  assignStaff,
};
