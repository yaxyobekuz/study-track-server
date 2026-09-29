const asyncHandler = require("../middleware/async.middleware");
const checkoutGateService = require("../services/checkoutGate.service");

// O'z tayyorligi — "Men ketdim" oynasidagi ishlar ro'yxati (id tokendan)
const getMyReadiness = asyncHandler(async (req, res) => {
  const data = await checkoutGateService.getCheckoutReadiness(req.user);
  res.json({ success: true, data });
});

const createRequest = asyncHandler(async (req, res) => {
  const data = await checkoutGateService.createCheckoutRequest(req.user, {
    reason: req.body?.reason,
  });
  res.status(201).json({ success: true, data });
});

const cancelRequest = asyncHandler(async (req, res) => {
  await checkoutGateService.cancelCheckoutRequest(req.user, req.params.id);
  res.json({ success: true });
});

const listRequests = asyncHandler(async (req, res) => {
  res.json(await checkoutGateService.listCheckoutRequests(req));
});

const reviewRequest = asyncHandler(async (req, res) => {
  const data = await checkoutGateService.reviewCheckoutRequest(
    req.params.id,
    { status: req.body?.status, note: req.body?.note },
    req.user,
  );
  res.json({ success: true, data });
});

module.exports = {
  getMyReadiness,
  createRequest,
  cancelRequest,
  listRequests,
  reviewRequest,
};
