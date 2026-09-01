const asyncHandler = require("../middleware/async.middleware");
const payrollRequestService = require("../services/payrollRequest.service");
const payrollAuditService = require("../services/payrollAudit.service");

// ── Xodim tomoni (o'z zayavkalari) ──

const submitRequest = asyncHandler(async (req, res) => {
  const data = await payrollRequestService.submitRequest(
    req.user.id,
    req.body,
    req.files || [],
  );
  res.status(201).json({ success: true, data });
});

const getMyRequests = asyncHandler(async (req, res) => {
  const data = await payrollRequestService.getMyRequests(req.user.id, req.query);
  res.json({ success: true, data });
});

const getAvailableCategories = asyncHandler(async (req, res) => {
  const data = await payrollRequestService.getAvailableCategories(req.user.id);
  res.json({ success: true, data });
});

const cancelRequest = asyncHandler(async (req, res) => {
  const data = await payrollRequestService.cancelRequest(req.params.id, req.user.id);
  res.json({ success: true, ...data });
});

// ── Admin tomoni ──

const getAllRequests = asyncHandler(async (req, res) => {
  const { data, pagination, pendingCount } =
    await payrollRequestService.getAllRequests(req.query);
  res.json({ success: true, data, pagination, pendingCount });
});

const reviewRequest = asyncHandler(async (req, res) => {
  const data = await payrollRequestService.reviewRequest(
    req.params.id,
    req.body,
    req.user.id,
  );
  res.json({ success: true, data });
});

const getAuditLog = asyncHandler(async (req, res) => {
  const { data, pagination } = await payrollAuditService.list(req.query);
  res.json({ success: true, data, pagination });
});

module.exports = {
  submitRequest,
  getMyRequests,
  getAvailableCategories,
  cancelRequest,
  getAllRequests,
  reviewRequest,
  getAuditLog,
};
