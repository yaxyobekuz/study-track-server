const asyncHandler = require("../middleware/async.middleware");
const paymentService = require("../services/payment.service");
const studentAccountService = require("../services/studentAccount.service");
const vacationMonthService = require("../services/vacationMonth.service");

// ── To'lovlar ────────────────────────────────

const getPayments = asyncHandler(async (req, res) => {
  const result = await paymentService.getPayments(req);
  res.json(result);
});

const getPayment = asyncHandler(async (req, res) => {
  const data = await paymentService.getPaymentById(req.params.id);
  res.json({ success: true, data });
});

const getStudentPayments = asyncHandler(async (req, res) => {
  const data = await paymentService.getStudentPayments(req.params.studentId, {
    includeVoided: req.query.includeVoided === "true",
  });
  res.json({ success: true, data });
});

/**
 * Taqsimot oldindan ko'rinishi — kassir tasdiqlashdan OLDIN qaysi oyga
 * qancha tushishini ko'radi. Hech narsa yozmaydi.
 */
const previewPayment = asyncHandler(async (req, res) => {
  const data = await paymentService.previewPayment(
    req.body.studentId,
    req.body.amount,
  );
  res.json({ success: true, data });
});

const createPayment = asyncHandler(async (req, res) => {
  const data = await paymentService.createPayment(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const voidPayment = asyncHandler(async (req, res) => {
  const result = await paymentService.voidPayment(
    req.params.id,
    req.body.reason,
    req.user.id,
  );
  res.json({ success: true, ...result });
});

const updatePayment = asyncHandler(async (req, res) => {
  const data = await paymentService.updatePaymentNote(req.params.id, req.body.note);
  res.json({ success: true, data });
});

// ── Depozit ──────────────────────────────────

const getStudentAccount = asyncHandler(async (req, res) => {
  const data = await studentAccountService.getStudentAccount(req.params.studentId);
  res.json({ success: true, data });
});

const getMovements = asyncHandler(async (req, res) => {
  const data = await studentAccountService.getMovements(req.params.studentId);
  res.json({ success: true, data });
});

const applyDeposit = asyncHandler(async (req, res) => {
  const data = await studentAccountService.applyDepositsForStudent(
    req.params.studentId,
  );
  res.json({ success: true, data });
});

const refundDeposit = asyncHandler(async (req, res) => {
  const data = await studentAccountService.refundDeposit(
    req.params.studentId,
    req.body,
    req.user.id,
  );
  res.status(201).json({ success: true, data });
});

const adjustBalance = asyncHandler(async (req, res) => {
  const data = await studentAccountService.adjustBalance(
    req.params.studentId,
    req.body,
    req.user.id,
  );
  res.json({ success: true, data });
});

// ── Ta'til oylari ────────────────────────────

const getVacationMonths = asyncHandler(async (req, res) => {
  const data = await vacationMonthService.getVacationMonths(req.query);
  res.json({ success: true, data });
});

const createVacationMonth = asyncHandler(async (req, res) => {
  const data = await vacationMonthService.createVacationMonth(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const deleteVacationMonth = asyncHandler(async (req, res) => {
  const result = await vacationMonthService.deleteVacationMonth(req.params.id);
  res.json({ success: true, ...result });
});

module.exports = {
  getPayments,
  getPayment,
  getStudentPayments,
  previewPayment,
  createPayment,
  voidPayment,
  updatePayment,
  getStudentAccount,
  getMovements,
  applyDeposit,
  refundDeposit,
  adjustBalance,
  getVacationMonths,
  createVacationMonth,
  deleteVacationMonth,
};
