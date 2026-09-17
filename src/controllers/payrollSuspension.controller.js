const asyncHandler = require("../middleware/async.middleware");
const suspensionService = require("../services/payrollSuspension.service");
const { ROLES } = require("../utils/constants");
const { ForbiddenError } = require("../utils/errors");

/** To'xtatishlar registri → `{ data, pagination, totals }`. */
const getSuspensions = asyncHandler(async (req, res) => {
  const data = await suspensionService.listSuspensions(req);
  res.json(data);
});

/**
 * O'ZIMNING to'xtatilgan oyligim — xodim paneli (`payroll.view` siz, faqat
 * o'zi, id tokendan): qaysi oy, qaysi qism, sababi va qancha.
 */
const getMySuspensions = asyncHandler(async (req, res) => {
  if (req.user.role === ROLES.STUDENT) {
    throw new ForbiddenError("Oylik faqat xodimlar uchun");
  }
  const data = await suspensionService.listMySuspensions(req.user.id);
  res.json({ success: true, data });
});

/** Kimning oyligini to'xtatish mumkin — shu oyda oyligi borlar. */
const getCandidates = asyncHandler(async (req, res) => {
  const data = await suspensionService.getCandidates(req.query.month);
  res.json({ success: true, data });
});

/** Bitta xodimning oylik qismlari — "aniq qo'shimcha" tanlovi uchun. */
const getUnits = asyncHandler(async (req, res) => {
  const data = await suspensionService.getUnits(req.query.staffId, req.query.month);
  res.json({ success: true, data });
});

/** Jonli hisob — hech narsa yozilmaydi. */
const previewSuspension = asyncHandler(async (req, res) => {
  const data = await suspensionService.previewSuspension(req.body);
  res.json({ success: true, data });
});

const createSuspension = asyncHandler(async (req, res) => {
  const data = await suspensionService.createSuspension(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const cancelSuspension = asyncHandler(async (req, res) => {
  const data = await suspensionService.cancelSuspension(req.params.id, req.body?.reason, req.user.id);
  res.json({ success: true, data });
});

const cancelBatch = asyncHandler(async (req, res) => {
  const data = await suspensionService.cancelBatch(req.params.batchId, req.body?.reason, req.user.id);
  res.json({ success: true, data });
});

module.exports = {
  getSuspensions,
  getMySuspensions,
  getCandidates,
  getUnits,
  previewSuspension,
  createSuspension,
  cancelSuspension,
  cancelBatch,
};
