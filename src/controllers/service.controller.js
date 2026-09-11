const asyncHandler = require("../middleware/async.middleware");
const serviceService = require("../services/service.service");

// ── Katalog ──────────────────────────────────

const getServices = asyncHandler(async (req, res) => {
  const data = await serviceService.getServices({
    includeArchived: req.query.includeArchived === "true",
  });
  res.json({ success: true, data });
});

const createService = asyncHandler(async (req, res) => {
  const data = await serviceService.createService(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const updateService = asyncHandler(async (req, res) => {
  const data = await serviceService.updateService(req.params.id, req.body);
  res.json({ success: true, data });
});

const archiveService = asyncHandler(async (req, res) => {
  const data = await serviceService.setServiceArchived(
    req.params.id,
    req.body.isArchived !== false,
  );
  res.json({ success: true, data });
});

const deleteService = asyncHandler(async (req, res) => {
  const result = await serviceService.deleteService(req.params.id);
  res.json({ success: true, ...result });
});

// ── O'quvchilar ro'yxati ─────────────────────

const getStudentsWithServices = asyncHandler(async (req, res) => {
  const result = await serviceService.getStudentsWithServices(req);
  res.json({ success: true, ...result });
});

// ── Biriktirish ──────────────────────────────

const getAssignment = asyncHandler(async (req, res) => {
  const data = await serviceService.getAssignmentById(req.params.id);
  res.json({ success: true, data });
});

const createAssignment = asyncHandler(async (req, res) => {
  const data = await serviceService.createAssignment(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const updateAssignment = asyncHandler(async (req, res) => {
  const data = await serviceService.updateAssignment(req.params.id, req.body);
  res.json({ success: true, data });
});

const closeAssignment = asyncHandler(async (req, res) => {
  const data = await serviceService.closeAssignment(
    req.params.id,
    req.body.endMonth,
  );
  res.json({ success: true, data });
});

const deleteAssignment = asyncHandler(async (req, res) => {
  const result = await serviceService.deleteAssignment(req.params.id);
  res.json({ success: true, ...result });
});

module.exports = {
  getServices,
  createService,
  updateService,
  archiveService,
  deleteService,
  getStudentsWithServices,
  getAssignment,
  createAssignment,
  updateAssignment,
  closeAssignment,
  deleteAssignment,
};
