const asyncHandler = require("../middleware/async.middleware");
const deductionService = require("../services/payrollDeduction.service");
const { ROLES } = require("../utils/constants");
const { ForbiddenError } = require("../utils/errors");

/** Ushlab qolishlar registri → `{ data, pagination, totals }`. */
const getDeductions = asyncHandler(async (req, res) => {
  const data = await deductionService.listDeductions(req);
  res.json(data);
});

/**
 * O'ZIMNING ushlab qolishlarim — xodim paneli (`payroll.view` siz, faqat o'zi):
 * sabab, izoh, qancha va qaysi oyda.
 */
const getMyDeductions = asyncHandler(async (req, res) => {
  if (req.user.role === ROLES.STUDENT) {
    throw new ForbiddenError("Oylik faqat xodimlar uchun");
  }

  const data = await deductionService.listMyDeductions(req.user.id);
  res.json({ success: true, data });
});

/** Kimdan ushlab qolish mumkin — shu oyda oyligi borlar. */
const getCandidates = asyncHandler(async (req, res) => {
  const data = await deductionService.getCandidates(req.query.month);
  res.json({ success: true, data });
});

/** Jonli hisob — hech narsa yozilmaydi. */
const previewDeductions = asyncHandler(async (req, res) => {
  const data = await deductionService.previewDeductions(req.body);
  res.json({ success: true, data });
});

const createDeductions = asyncHandler(async (req, res) => {
  const data = await deductionService.createDeductions(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const cancelDeduction = asyncHandler(async (req, res) => {
  const data = await deductionService.cancelDeduction(req.params.id, req.body.reason, req.user.id);
  res.json({ success: true, data });
});

const cancelBatch = asyncHandler(async (req, res) => {
  const data = await deductionService.cancelBatch(req.params.batchId, req.body.reason, req.user.id);
  res.json({ success: true, data });
});

module.exports = {
  getDeductions,
  getMyDeductions,
  getCandidates,
  previewDeductions,
  createDeductions,
  cancelDeduction,
  cancelBatch,
};
