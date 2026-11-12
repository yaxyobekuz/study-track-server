const testService = require("../services/diagnosticTest.service");
const studentTestService = require("../services/diagnosticStudentTest.service");
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

/**
 * HAR O'QUVCHIGA MOSLANGAN TEST — OLDINDAN KO'RISH.
 *
 * Guruh tanlanadi, qamrov esa har bolaga alohida hal qilinadi: kim qaysi
 * oraliqda test oladi, kimga tushmaydi va nega.
 */
const previewStudentTest = asyncHandler(async (req, res) => {
  const data = await studentTestService.planStudentTest({
    classId: req.body.classId || (req.body.classIds || [])[0],
    blueprint: req.body.blueprint,
    studentIds: req.body.studentIds || null,
    actorId: req.user.id,
  });
  res.json({ success: true, data });
});

/**
 * HAR O'QUVCHIGA MOSLANGAN TESTNI YIG'ISH.
 *
 * ⚠️ AI ruxsati SERVISDA tekshiriladi (`buildTest` bilan AYNI mulohaza):
 * faqat bankdan oladigan qator model chaqiruvini yuzaga keltirmaydi.
 */
const buildStudentTest = asyncHandler(async (req, res) => {
  const canUseAi =
    hasRole(req.user, ROLES.OWNER) ||
    hasPermission(req.user.permissions || [], PERMISSIONS.DIAGNOSTICS_AI);

  const data = await studentTestService.buildStudentTest(req.body, req.user.id, { canUseAi });

  res.status(201).json({
    success: true,
    message:
      `Test qoralama sifatida yaratildi: ${data.totals.ready} o'quvchiga ` +
      `${data.totals.uniqueQuestions} noyob savol. Chiqarishdan oldin tasdiqlang.`,
    data,
  });
});

/**
 * TASDIQLASH EKRANI — "filial egasi nimani ko'radi".
 *
 * ⚠️ To'g'ri javob ham qaytadi: tasdiqlash "savol to'g'rimi" degan
 * qarorni talab qiladi va javob kalitini ko'rmasdan bu qaror qabul
 * qilinmaydi. Yo'l `diagnostics.view` ortida (ADMIN tomoni).
 */
const getTestReview = asyncHandler(async (req, res) => {
  const data = await studentTestService.getTestReview(req.params.id);
  res.json({ success: true, data });
});

/**
 * SAVOLLARNI ALMASHTIRISH — bitta, bir nechta yoki hammasi.
 *
 * ⚠️ UCHALA REJIM BITTA YO'LDAN: `items` bitta element bo'lsa "bitta
 * savol", bir nechta bo'lsa "tanlanganlar", `all: true` bo'lsa hammasi.
 */
const regenerateTestQuestions = asyncHandler(async (req, res) => {
  const canUseAi =
    hasRole(req.user, ROLES.OWNER) ||
    hasPermission(req.user.permissions || [], PERMISSIONS.DIAGNOSTICS_AI);

  const data = await studentTestService.regenerateQuestions({
    testId: req.params.id,
    items: req.body.items || [],
    all: Boolean(req.body.all),
    actorId: req.user.id,
    canUseAi,
  });

  res.json({
    success: true,
    message:
      `${data.totals.replaced} ta savol almashtirildi` +
      (data.totals.skipped ? `, ${data.totals.skipped} tasi o'z joyida qoldi` : ""),
    data,
  });
});

/** TESTNI TASDIQLASH (`diagnostics.publish`). */
const approveTest = asyncHandler(async (req, res) => {
  const data = await studentTestService.approveTest({
    testId: req.params.id,
    actorId: req.user.id,
    note: req.body.note,
  });
  res.json({ success: true, message: data.message, data });
});

/** TASDIQNI BEKOR QILISH — sabab majburiy (`diagnostics.publish`). */
const rejectTest = asyncHandler(async (req, res) => {
  const data = await studentTestService.rejectTest({
    testId: req.params.id,
    actorId: req.user.id,
    note: req.body.note,
  });
  res.json({ success: true, message: data.message, data });
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
  previewStudentTest,
  buildStudentTest,
  getTestReview,
  regenerateTestQuestions,
  approveTest,
  rejectTest,
  approveTestQuestions,
  updateTest,
  updateTestStatus,
  deleteTest,
  getMyTests,
};
