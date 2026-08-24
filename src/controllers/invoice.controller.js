const asyncHandler = require("../middleware/async.middleware");
const invoiceService = require("../services/invoice.service");
const invoiceGenerationService = require("../services/invoiceGeneration.service");
const paymentService = require("../services/payment.service");
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
  const data = await invoiceService.getMyFinance(req.user.id);
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

/** Kassirning asosiy ekrani — o'quvchilar kesimida tarif, depozit va qarz. */
const getStudentRegistry = asyncHandler(async (req, res) => {
  const result = await invoiceService.getStudentRegistry(req);
  res.json(result);
});

/** Qarzdorlar registri — "kim qancha qarzdor va qachondan beri". */
const getDebtors = asyncHandler(async (req, res) => {
  const result = await invoiceService.getDebtors(req);
  res.json(result);
});

const getStudentInvoices = asyncHandler(async (req, res) => {
  const data = await invoiceService.getStudentInvoices(req.params.studentId, {
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

/**
 * Chegirma kech qo'shilganda yoki tarif narxi xato kiritilganda: summa
 * muhrlangani uchun uni tahrirlab bo'lmaydi, shuning uchun bekor qilib
 * qayta yaratiladi. Bu tarixni qayta yozish — `finance.adjust` talab qilinadi
 * (route darajasida).
 */
const regenerateInvoice = asyncHandler(async (req, res) => {
  const invoice = await invoiceService.regenerateInvoice(
    req.params.id,
    req.body.reason,
    req.user.id,
  );
  res.json({ success: true, data: invoice });
});

// ── Hisob-fakturaga tushgan to'lovlar ────────
// To'lov QABUL QILISH bu yerda emas: kassir o'quvchiga bitta summa
// kiritadi va tizim uni oylarga taqsimlaydi → `POST /api/payments`.

const getInvoicePayments = asyncHandler(async (req, res) => {
  const payments = await paymentService.getInvoiceAllocations(req.params.id, {
    includeVoided: req.query.includeVoided === "true",
  });
  res.json({ success: true, data: payments });
});

module.exports = {
  getMyFinance,
  getInvoices,
  getSummary,
  getStudentRegistry,
  getDebtors,
  getStudentInvoices,
  getInvoice,
  generateInvoices,
  updateInvoice,
  cancelInvoice,
  regenerateInvoice,
  restoreInvoice,
  getInvoicePayments,
};
