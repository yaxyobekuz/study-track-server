const asyncHandler = require("../middleware/async.middleware");
const payrollService = require("../services/payroll.service");
const salaryPaymentService = require("../services/salaryPayment.service");

// ── Majburiyatlar ────────────────────────────

const getEntries = asyncHandler(async (req, res) => {
  const data = await payrollService.getEntries(req);
  res.json({ success: true, ...data });
});

const getStaffEntries = asyncHandler(async (req, res) => {
  const data = await payrollService.getStaffEntries(req.params.staffId);
  res.json({ success: true, data });
});

const generate = asyncHandler(async (req, res) => {
  const data = await payrollService.generateForMonth(req.body.month, {
    dryRun: req.body.dryRun === true,
    staffIds: req.body.staffIds,
    actorId: req.user.id,
  });
  res.json({ success: true, data });
});

const cancelEntry = asyncHandler(async (req, res) => {
  const data = await payrollService.cancelEntry(
    req.params.id,
    req.body.reason,
    req.user.id,
  );
  res.json({ success: true, data, message: "Majburiyat bekor qilindi" });
});

// ── To'lovlar ────────────────────────────────

const previewPayment = asyncHandler(async (req, res) => {
  const data = await salaryPaymentService.previewPayment(req.body);
  res.json({ success: true, data });
});

const createPayment = asyncHandler(async (req, res) => {
  const data = await salaryPaymentService.createPayment(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const voidPayment = asyncHandler(async (req, res) => {
  const data = await salaryPaymentService.voidPayment(
    req.params.id,
    req.body.reason,
    req.user.id,
  );
  res.json({ success: true, data, message: "To'lov bekor qilindi" });
});

const getPayments = asyncHandler(async (req, res) => {
  const data = await salaryPaymentService.getPayments(req);
  res.json({ success: true, ...data });
});

module.exports = {
  getEntries,
  getStaffEntries,
  generate,
  cancelEntry,
  previewPayment,
  createPayment,
  voidPayment,
  getPayments,
};
