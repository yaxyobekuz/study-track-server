/** KUNLIK MONITORING HISOBOTI. */

const asyncHandler = require("../middleware/async.middleware");
const checkService = require("../services/inventoryCheck.service");

const getChecks = asyncHandler(async (req, res) => {
  const data = await checkService.getChecks(req);
  res.json({ success: true, ...data });
});

const getCheckById = asyncHandler(async (req, res) => {
  const data = await checkService.getCheckById(req.params.id);
  res.json({ success: true, data });
});

/** Bugun (yoki berilgan kunda) hisobot bermagan xonalar. */
const getPendingLocations = asyncHandler(async (req, res) => {
  const data = await checkService.getPendingLocations(req.query.date);
  res.json({ success: true, data });
});

const openCheck = asyncHandler(async (req, res) => {
  const data = await checkService.openCheck(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const updateCheckLines = asyncHandler(async (req, res) => {
  const data = await checkService.updateCheckLines(req.params.id, req.body, req.user.id);
  res.json({ success: true, data, message: "Saqlandi" });
});

const attachLineFiles = asyncHandler(async (req, res) => {
  const data = await checkService.attachLineFiles(
    req.params.id,
    req.params.lineId,
    req.files || [],
    req.user.id,
  );
  res.status(201).json({ success: true, data, message: "Fayl biriktirildi" });
});

const submitCheck = asyncHandler(async (req, res) => {
  const data = await checkService.submitCheck(req.params.id, req.body, req.user.id);
  res.json({ success: true, data, message: "Hisobot yuborildi" });
});

const deleteCheck = asyncHandler(async (req, res) => {
  const { message, ...data } = await checkService.deleteCheck(req.params.id, req.user.id);
  res.json({ success: true, data, message });
});

module.exports = {
  getChecks,
  getCheckById,
  getPendingLocations,
  openCheck,
  updateCheckLines,
  attachLineFiles,
  submitCheck,
  deleteCheck,
};
