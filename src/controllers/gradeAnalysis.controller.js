const asyncHandler = require("../middleware/async.middleware");
const gradeAnalysisService = require("../services/gradeAnalysis.service");

// ─────────────────────────────────────────────
// Admin: tahlil oynasi
// ─────────────────────────────────────────────

const getOptions = asyncHandler(async (req, res) => {
  const data = await gradeAnalysisService.getOptions();
  res.json({ success: true, data });
});

const searchStudents = asyncHandler(async (req, res) => {
  const data = await gradeAnalysisService.searchStudents(req.query);
  res.json({ success: true, data });
});

// ⚠️ 202: tahlil FONDA ishlanadi — javob navbatga qo'yilgan tahlilni
// qaytaradi, admin paneli progressni `GET /runs/:id` bilan kuzatadi.
const createRun = asyncHandler(async (req, res) => {
  const data = await gradeAnalysisService.createRun(req.body, { actorId: req.user.id });
  res.status(202).json({ success: true, message: "Tahlil boshlandi", data });
});

const listRuns = asyncHandler(async (req, res) => {
  const result = await gradeAnalysisService.listRuns(req.query);
  res.json({ success: true, ...result });
});

const getRun = asyncHandler(async (req, res) => {
  const data = await gradeAnalysisService.getRun(req.params.id);
  res.json({ success: true, data });
});

const listRunReports = asyncHandler(async (req, res) => {
  const result = await gradeAnalysisService.listRunReports(req.params.id, req.query);
  res.json({ success: true, ...result });
});

const getReport = asyncHandler(async (req, res) => {
  const data = await gradeAnalysisService.getReport(req.params.id);
  res.json({ success: true, data });
});

const getStudentHistory = asyncHandler(async (req, res) => {
  const data = await gradeAnalysisService.getStudentHistory(req.params.studentId, req.query);
  res.json({ success: true, data });
});

const cancelRun = asyncHandler(async (req, res) => {
  const data = await gradeAnalysisService.cancelRun(req.params.id);
  res.json({ success: true, message: "Tahlil to'xtatildi", data });
});

const publishRun = asyncHandler(async (req, res) => {
  const data = await gradeAnalysisService.publishRun(req.params.id, { actorId: req.user.id });
  res.json({
    success: true,
    // ⚠️ Sanoq bilan: "yuborildi" deb qo'yib, bildirishnoma nechta
    // qurilmaga yetganini aytmaslik — jim yo'qotish bo'lardi
    message: `${data.published} ta hisobot ochildi, ${data.pushSent} ta qurilmaga bildirishnoma ketdi`,
    data,
  });
});

const unpublishRun = asyncHandler(async (req, res) => {
  const data = await gradeAnalysisService.unpublishRun(req.params.id);
  res.json({ success: true, message: `${data.unpublished} ta hisobot yopildi`, data });
});

const deleteRun = asyncHandler(async (req, res) => {
  const data = await gradeAnalysisService.deleteRun(req.params.id);
  res.json({ success: true, message: "Tahlil o'chirildi", data });
});

const getSettings = asyncHandler(async (req, res) => {
  const data = await gradeAnalysisService.getSettings();
  res.json({ success: true, data });
});

const updateSettings = asyncHandler(async (req, res) => {
  const data = await gradeAnalysisService.updateSettings(req.body, req.user.id);
  res.json({ success: true, message: "Sozlamalar saqlandi", data });
});

// ─────────────────────────────────────────────
// Mobil: o'quvchi va ota-ona
// ─────────────────────────────────────────────
// ⚠️ `studentId` SO'ROVDAN OLINMAYDI — har doim `req.user`. Auditoriya
// (`?audience=student|parent`) faqat qaysi matn qaytishini hal qiladi.

const listMyReports = asyncHandler(async (req, res) => {
  const result = await gradeAnalysisService.listMyReports(req.user, req.query);
  res.json({ success: true, ...result });
});

const getMyLatestReport = asyncHandler(async (req, res) => {
  const data = await gradeAnalysisService.getMyLatestReport(req.user, req.query);
  res.json({ success: true, data });
});

const getMyReport = asyncHandler(async (req, res) => {
  const data = await gradeAnalysisService.getMyReport(req.user, req.params.id, req.query);
  res.json({ success: true, data });
});

module.exports = {
  getOptions,
  searchStudents,
  createRun,
  listRuns,
  getRun,
  listRunReports,
  getReport,
  getStudentHistory,
  cancelRun,
  publishRun,
  unpublishRun,
  deleteRun,
  getSettings,
  updateSettings,
  listMyReports,
  getMyLatestReport,
  getMyReport,
};
