const testService = require("../services/diagnosticTest.service");
const asyncHandler = require("../middleware/async.middleware");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { PERMISSIONS, hasPermission, hasRole } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");

const getTests = asyncHandler(async (req, res) => {
  const pagination = getPaginationParams(req);
  const { total, rows } = await testService.listTests(req.query, pagination);

  res.json(formatPaginationResponse(rows, total, pagination.page, pagination.limit));
});

const getTest = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await testService.getTestById(req.params.id) });
});

// Nashr qilishdan OLDIN: bankda yetarli savol bormi?
// ⚠️ Ekranda ogohlantirish sifatida ko'rsatiladi — muammo o'quvchining
// oldida emas, testni tuzayotgan odam oldida chiqishi kerak.
const getAvailability = asyncHandler(async (req, res) => {
  const test = await testService.getTestById(req.params.id);
  res.json({ success: true, data: await testService.checkAvailability(test) });
});

const createTest = asyncHandler(async (req, res) => {
  const data = await testService.createTest(req.body, req.user.id);
  res.status(201).json({ success: true, message: "Test yaratildi", data });
});

/**
 * OLDINDAN KO'RISH — hech narsa yozmaydi.
 *
 * Har qator uchun: sinf qaysi mavzuga kelgan, qamrov qabul qilinadimi,
 * bankda nechta mos savol bor va AI nechtasini yozishi kerak.
 */
const previewTest = asyncHandler(async (req, res) => {
  const data = await testService.planTest({
    classId: req.body.classId,
    blueprint: req.body.blueprint,
    actorId: req.user.id,
  });
  res.json({ success: true, data });
});

/**
 * MAVZU QAMROVI BILAN TEST YIG'ISH (bank + AI).
 *
 * ⚠️ AI RUXSATI SHU YERDA TEKSHIRILADI, ROUTE'DA EMAS. Route darajasida
 * `diagnostics.ai` talab qilinsa, savollarni FAQAT BANKDAN oladigan
 * odam ham shu endpointdan foydalana olmay qolardi — holbuki u hech
 * qanday model chaqiruvini yuzaga keltirmaydi. Shart qatorlarning
 * manbasiga bog'liq, shuning uchun qarorni servis qabul qiladi.
 */
const buildTest = asyncHandler(async (req, res) => {
  const canUseAi =
    hasRole(req.user, ROLES.OWNER) ||
    hasPermission(req.user.permissions || [], PERMISSIONS.DIAGNOSTICS_AI);

  const data = await testService.buildTest(req.body, req.user.id, { canUseAi });

  res.status(201).json({
    success: true,
    message: data.pendingApproval
      ? `Test qoralama sifatida yaratildi. ${data.pendingApproval} ta savol tasdiqlanishi kerak.`
      : "Test yaratildi",
    data,
  });
});

/** AI yozgan savollarni ommaviy tasdiqlash (`diagnostics.moderate`). */
const approveTestQuestions = asyncHandler(async (req, res) => {
  const data = await testService.approveTestQuestions(req.params.id);
  res.json({ success: true, message: data.message, data });
});

const updateTest = asyncHandler(async (req, res) => {
  const data = await testService.updateTest(req.params.id, req.body);
  res.json({ success: true, message: "Test yangilandi", data });
});

const updateTestStatus = asyncHandler(async (req, res) => {
  const data = await testService.updateTestStatus(req.params.id, req.body.status);
  res.json({ success: true, message: "Test holati o'zgartirildi", data });
});

const deleteTest = asyncHandler(async (req, res) => {
  const data = await testService.deleteTest(req.params.id);
  res.json({ success: true, message: data.message, data });
});

// O'quvchining o'ziga ochiq testlar (o'quvchi paneli uchun)
const getMyTests = asyncHandler(async (req, res) => {
  const data = await testService.listAvailableForStudent(req.user.id);
  res.json({ success: true, data });
});

module.exports = {
  getTests,
  getTest,
  getAvailability,
  createTest,
  previewTest,
  buildTest,
  approveTestQuestions,
  updateTest,
  updateTestStatus,
  deleteTest,
  getMyTests,
};
