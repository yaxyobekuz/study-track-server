const asyncHandler = require("../middleware/async.middleware");
const salaryRequestService = require("../services/salaryRequest.service");

// ── Xodim tomoni (o'z so'rovlari) ──

const submitRequest = asyncHandler(async (req, res) => {
  const data = await salaryRequestService.submitRequest(
    req.user.id,
    req.body,
    req.files || [],
  );
  res.status(201).json({ success: true, data });
});

const getMyRequests = asyncHandler(async (req, res) => {
  const data = await salaryRequestService.getMyRequests(req.user.id, req.query);
  res.json({ success: true, data });
});

const cancelRequest = asyncHandler(async (req, res) => {
  const data = await salaryRequestService.cancelRequest(req.params.id, req.user.id);
  res.json({ success: true, ...data });
});

// ── Admin tomoni ──

const getAllRequests = asyncHandler(async (req, res) => {
  const { data, pagination, pendingCount } =
    await salaryRequestService.getAllRequests(req.query);
  res.json({ success: true, data, pagination, pendingCount });
});

const reviewRequest = asyncHandler(async (req, res) => {
  const data = await salaryRequestService.reviewRequest(
    req.params.id,
    req.body,
    req.user.id,
  );
  res.json({ success: true, data });
});

module.exports = {
  submitRequest,
  getMyRequests,
  cancelRequest,
  getAllRequests,
  reviewRequest,
};
