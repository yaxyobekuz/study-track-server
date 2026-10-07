const asyncHandler = require("../middleware/async.middleware");
const branchTransferService = require("../services/branchTransfer.service");

// ── Ko'rib chiqish (hech narsa yozmaydi) ──

const previewStudents = asyncHandler(async (req, res) => {
  const data = await branchTransferService.previewStudents(req.user, req.body ?? {});
  res.json({ success: true, data });
});

const previewStaff = asyncHandler(async (req, res) => {
  const data = await branchTransferService.previewStaff(req.user, req.body ?? {});
  res.json({ success: true, data });
});

const previewClasses = asyncHandler(async (req, res) => {
  const data = await branchTransferService.previewClasses(req.user, req.body ?? {});
  res.json({ success: true, data });
});

// ── Tasdiqlash (rejaning xeshi va tasdiqlangan oqibatlar bilan) ──

const transferStudents = asyncHandler(async (req, res) => {
  const data = await branchTransferService.transferStudents(req.user, req.body ?? {});
  res.json({ success: true, message: data.message, data });
});

const transferStaff = asyncHandler(async (req, res) => {
  const data = await branchTransferService.transferStaff(req.user, req.body ?? {});
  res.json({ success: true, message: data.message, data });
});

const transferClasses = asyncHandler(async (req, res) => {
  const data = await branchTransferService.transferClasses(req.user, req.body ?? {});
  res.json({ success: true, message: data.message, data });
});

// Maqsad filial sinflari (o'quvchini darhol sinfga biriktirish uchun)
const listTargetClasses = asyncHandler(async (req, res) => {
  const data = await branchTransferService.listTargetClasses(req.user, req.query.branchId);
  res.json({ success: true, data });
});

// ── Jurnal ──

const listTransfers = asyncHandler(async (req, res) => {
  res.json(await branchTransferService.listTransfers(req));
});

const getUserTransfers = asyncHandler(async (req, res) => {
  const data = await branchTransferService.getUserTransfers(req.params.id);
  res.json({ success: true, data });
});

const getStaffPayrollAcrossBranches = asyncHandler(async (req, res) => {
  const data = await branchTransferService.getStaffPayrollAcrossBranches(req.params.id, {
    months: req.query.months,
  });
  res.json({ success: true, data });
});

module.exports = {
  previewStudents,
  previewStaff,
  previewClasses,
  transferStudents,
  transferStaff,
  transferClasses,
  listTargetClasses,
  listTransfers,
  getUserTransfers,
  getStaffPayrollAcrossBranches,
};
