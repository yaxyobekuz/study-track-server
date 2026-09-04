/** MODDIY ZARAR — hodisa, aybdorga yozish va undiruv. */

const asyncHandler = require("../middleware/async.middleware");
const damageService = require("../services/inventoryDamage.service");
const chargeService = require("../services/damageCharge.service");
const paymentService = require("../services/damagePayment.service");

// ─── Zarar hodisasi ──────────────────────────

const getDamages = asyncHandler(async (req, res) => {
  const data = await damageService.getDamages(req);
  res.json({ success: true, ...data });
});

const getDamageById = asyncHandler(async (req, res) => {
  const data = await damageService.getDamageById(req.params.id);
  res.json({ success: true, data });
});

const createDamage = asyncHandler(async (req, res) => {
  const data = await damageService.createDamage(
    // Multipart so'rovda barcha maydonlar STRING bo'lib keladi — service
    // ularni `parseQuantity` / `parseAmount` orqali o'qiydi
    { ...req.body, files: req.files || [] },
    req.user.id,
  );
  res.status(201).json({ success: true, data, message: "Zarar qayd etildi" });
});

const waiveDamage = asyncHandler(async (req, res) => {
  const data = await damageService.waiveDamage(req.params.id, req.body.reason, req.user.id);
  res.json({ success: true, data, message: "Zarar maktab hisobidan deb belgilandi" });
});

const unwaiveDamage = asyncHandler(async (req, res) => {
  const data = await damageService.unwaiveDamage(req.params.id, req.user.id);
  res.json({ success: true, data, message: "Qaror qaytarildi" });
});

const cancelDamage = asyncHandler(async (req, res) => {
  const data = await damageService.cancelDamage(req.params.id, req.body.reason, req.user.id);
  res.json({ success: true, data, message: "Zarar bekor qilindi" });
});

// ─── Aybdorga yozilgan qarz ──────────────────

const getCharges = asyncHandler(async (req, res) => {
  const data = await chargeService.getCharges(req);
  res.json({ success: true, ...data });
});

const getChargeById = asyncHandler(async (req, res) => {
  const data = await chargeService.getChargeById(req.params.id);
  res.json({ success: true, data });
});

/**
 * Bitta odamning moddiy zarar qarzi — profildagi "qarzdorlik" bloki.
 * Qoldiq nolga tushmaguncha `hasDebt` rost bo'lib turadi.
 */
const getPersonSummary = asyncHandler(async (req, res) => {
  const data = await chargeService.getPersonSummary(req.params.personId);
  res.json({ success: true, data });
});

const createCharges = asyncHandler(async (req, res) => {
  const data = await chargeService.createCharges(req.params.id, req.body, req.user.id);
  res.status(201).json({ success: true, data, message: "Qarz yozildi" });
});

const updateCharge = asyncHandler(async (req, res) => {
  const data = await chargeService.updateCharge(req.params.id, req.body, req.user.id);
  res.json({ success: true, data, message: "Saqlandi" });
});

const cancelCharge = asyncHandler(async (req, res) => {
  const data = await chargeService.cancelCharge(req.params.id, req.body.reason, req.user.id);
  res.json({ success: true, data, message: "Qarz bekor qilindi" });
});

// ─── Undiruv (to'lov) ────────────────────────

const getPayments = asyncHandler(async (req, res) => {
  const data = await paymentService.getPayments(req);
  res.json({ success: true, ...data });
});

/** Taqsimotni OLDINDAN ko'rsatadi — kassir to'lovdan oldin ko'radi. */
const previewPayment = asyncHandler(async (req, res) => {
  const data = await paymentService.previewPayment(req.body);
  res.json({ success: true, data });
});

const createPayment = asyncHandler(async (req, res) => {
  const data = await paymentService.createPayment(req.body, req.user.id);
  res.status(201).json({ success: true, data, message: "To'lov qabul qilindi" });
});

const voidPayment = asyncHandler(async (req, res) => {
  const data = await paymentService.voidPayment(req.params.id, req.body.reason, req.user.id);
  res.json({ success: true, data, message: "To'lov bekor qilindi" });
});

module.exports = {
  getDamages,
  getDamageById,
  createDamage,
  waiveDamage,
  unwaiveDamage,
  cancelDamage,
  getCharges,
  getChargeById,
  getPersonSummary,
  createCharges,
  updateCharge,
  cancelCharge,
  getPayments,
  previewPayment,
  createPayment,
  voidPayment,
};
