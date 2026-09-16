const asyncHandler = require("../middleware/async.middleware");
const service = require("../services/expenseLimitRequest.service");

// ── Xodim tomoni ──────────────────────────────

const submitRequest = asyncHandler(async (req, res) => {
  const data = await service.submitRequest(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const getMyRequests = asyncHandler(async (req, res) => {
  const data = await service.getMyRequests(req.user.id, req.query);
  res.json({ success: true, data });
});

// ── Admin tomoni ──────────────────────────────

const getAllRequests = asyncHandler(async (req, res) => {
  const result = await service.getAllRequests(req);
  res.json({ success: true, ...result });
});

const reviewRequest = asyncHandler(async (req, res) => {
  const data = await service.reviewRequest(req.params.id, req.body, req.user.id);
  res.json({ success: true, data });
});

module.exports = {
  submitRequest,
  getMyRequests,
  getAllRequests,
  reviewRequest,
};
