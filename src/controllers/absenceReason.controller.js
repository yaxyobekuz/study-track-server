const asyncHandler = require("../middleware/async.middleware");
const absenceReasonService = require("../services/absenceReason.service");

const create = asyncHandler(async (req, res) => {
  const reason = await absenceReasonService.createReason(req.body, req.user.id);
  res.status(201).json({ success: true, data: reason });
});

const getAll = asyncHandler(async (req, res) => {
  const result = await absenceReasonService.getReasons(req);
  res.json(result);
});

const getActive = asyncHandler(async (req, res) => {
  const reasons = await absenceReasonService.getActiveReasons();
  res.json({ success: true, data: reasons });
});

const getApplicable = asyncHandler(async (req, res) => {
  const reasons = await absenceReasonService.getApplicableForRole(req.user.role);
  res.json({ success: true, data: reasons });
});

const update = asyncHandler(async (req, res) => {
  const reason = await absenceReasonService.updateReason(req.params.id, req.body);
  res.json({ success: true, data: reason });
});

const remove = asyncHandler(async (req, res) => {
  await absenceReasonService.deleteReason(req.params.id);
  res.json({ success: true });
});

module.exports = {
  create,
  getAll,
  getActive,
  getApplicable,
  update,
  remove,
};
