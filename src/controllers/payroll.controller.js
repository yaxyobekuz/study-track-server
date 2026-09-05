const asyncHandler = require("../middleware/async.middleware");
const payrollService = require("../services/payroll.service");
const salaryPaymentService = require("../services/salaryPayment.service");
const { ROLES } = require("../utils/constants");
const { ForbiddenError } = require("../utils/errors");

// ── Majburiyatlar ────────────────────────────

const getEntries = asyncHandler(async (req, res) => {
  const data = await payrollService.getEntries(req);
  res.json({ success: true, ...data });
});

const getStaffEntries = asyncHandler(async (req, res) => {
  const data = await payrollService.getStaffEntries(req.params.staffId);
  res.json({ success: true, data });
});

// O'ZIMNING oylik majburiyatlarim — xodim panelidagi profil sahifasi
// (`getMySalary` bilan bir xil mulohaza: `payroll.view` siz, faqat o'zi).
const getMyEntries = asyncHandler(async (req, res) => {
  if (req.user.role === ROLES.STUDENT) {
    throw new ForbiddenError("Oylik faqat xodimlar uchun");
  }

  const data = await payrollService.getStaffEntries(req.user.id);
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

/**
 * Bitta majburiyatni qayta shakllantirish — bekor qilinganini qaytarish
 * yoki qoida to'g'rilangandan keyin summani yangilash.
 */
const regenerateEntry = asyncHandler(async (req, res) => {
  const data = await payrollService.regenerateEntry(
    req.params.id,
    req.body?.reason,
    req.user.id,
  );
  res.json({ success: true, message: "Majburiyat qayta shakllantirildi", data });
});

module.exports = {
  regenerateEntry,
  getEntries,
  getStaffEntries,
  getMyEntries,
  generate,
  cancelEntry,
  previewPayment,
  createPayment,
  voidPayment,
  getPayments,
};
