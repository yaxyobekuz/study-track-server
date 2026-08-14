const asyncHandler = require("../middleware/async.middleware");
const invoiceService = require("../services/invoice.service");
const invoiceGenerationService = require("../services/invoiceGeneration.service");
const invoicePaymentService = require("../services/invoicePayment.service");
const { PERMISSIONS, hasPermission } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const { ForbiddenError } = require("../utils/errors");
const { currentMonthKey, parseMonthKey } = require("../helpers/month.helpers");

const canAdjust = (req) =>
  req.user.role === ROLES.OWNER ||
  hasPermission(req.user.permissions, PERMISSIONS.FINANCE_ADJUST);

// ── O'quvchining o'z ma'lumoti ───────────────

/**
 * O'quvchi o'z moliyaviy manzarasini ko'radi. `studentId` FAQAT tokendan —
 * query'dan olinsa, har kim boshqaning qarzini ko'rib qolardi.
 */
const getMyFinance = asyncHandler(async (req, res) => {
  const data = await invoiceService.getMyFinance(req.user.id, {
    academicYear: req.query.academicYear,
  });
  res.json({ success: true, data });
});

// ── Admin ────────────────────────────────────

const getInvoices = asyncHandler(async (req, res) => {
  const result = await invoiceService.getInvoices(req);
  res.json(result);
});

const getSummary = asyncHandler(async (req, res) => {
  const data = await invoiceService.getSummary(req.query.month);
  res.json({ success: true, data });
});

const getStudentInvoices = asyncHandler(async (req, res) => {
  const data = await invoiceService.getStudentInvoices(req.params.studentId, {
    academicYear: req.query.academicYear,
    includeCancelled: req.query.includeCancelled === "true",
  });
  res.json({ success: true, data });
});

const getInvoice = asyncHandler(async (req, res) => {
  const invoice = await invoiceService.getInvoiceById(req.params.id, {
    includeVoided: req.query.includeVoided === "true",
  });
  res.json({ success: true, data: invoice });
});

/**
 * Majburiyatlarni shakllantirish. Natija — paket hisoboti, yaratilgan resurs
 * emas, shuning uchun 201 emas 200.
 *
 * O'tgan oy uchun shakllantirish tarixga qarz qo'shadi — `finance.adjust`
 * talab qilinadi (dryRun bundan mustasno: u hech narsa yozmaydi).
 */
const generateInvoices = asyncHandler(async (req, res) => {
  const month = parseMonthKey(req.body.month, "Oy");
  const dryRun = req.body.dryRun === true;

  if (!dryRun && month < currentMonthKey() && !canAdjust(req)) {
    throw new ForbiddenError(
      "O'tgan oy uchun majburiyat shakllantirish uchun ruxsatingiz yo'q",
    );
  }

  const summary = await invoiceGenerationService.generateForMonth(month, {
    actorId: req.user.id,
    source: "manual",
    studentIds: req.body.studentIds,
    classId: req.body.classId,
    dryRun,
  });

  res.json({ success: true, data: summary });
});

const updateInvoice = asyncHandler(async (req, res) => {
  const invoice = await invoiceService.updateNote(req.params.id, req.body.note);
  res.json({ success: true, data: invoice });
});

const cancelInvoice = asyncHandler(async (req, res) => {
  const invoice = await invoiceService.getInvoiceById(req.params.id);

  // O'tgan oyni bekor qilish — tarixni qayta yozish
  if (invoice.month < currentMonthKey() && !canAdjust(req)) {
    throw new ForbiddenError(
      "O'tgan oy hisob-fakturasini bekor qilish uchun ruxsatingiz yo'q",
    );
  }

  const updated = await invoiceService.cancelInvoice(
    req.params.id,
    req.body.reason,
    req.user.id,
  );
  res.json({ success: true, data: updated });
});

const restoreInvoice = asyncHandler(async (req, res) => {
  const invoice = await invoiceService.restoreInvoice(req.params.id, req.user.id);
  res.json({ success: true, data: invoice });
});

// ── To'lovlar (hisob-faktura ichida) ─────────

const createPayment = asyncHandler(async (req, res) => {
  const result = await invoicePaymentService.createPayment(
    req.params.id,
    req.body,
    req.user.id,
  );
  res.status(201).json({ success: true, data: result });
});

const getPayments = asyncHandler(async (req, res) => {
  const payments = await invoicePaymentService.getInvoicePayments(req.params.id, {
    includeVoided: req.query.includeVoided === "true",
  });
  res.json({ success: true, data: payments });
});

module.exports = {
  getMyFinance,
  getInvoices,
  getSummary,
  getStudentInvoices,
  getInvoice,
  generateInvoices,
  updateInvoice,
  cancelInvoice,
  restoreInvoice,
  createPayment,
  getPayments,
};
