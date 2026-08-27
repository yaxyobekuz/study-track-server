/**
 * Dars jadvalini rejalashtirish — kontroller.
 *
 * Ingichka qobiq: butun mantiq `planner*.service.js` fayllarida.
 */

const asyncHandler = require("../middleware/async.middleware");
const ExcelService = require("../services/excel.service");
const loadService = require("../services/plannerLoad.service");
const availabilityService = require("../services/plannerAvailability.service");
const settingsService = require("../services/plannerSettings.service");
const generatorService = require("../services/plannerGenerator.service");
const runService = require("../services/plannerRun.service");

// ── YUKLAMA ("Asosiy" tab) ──

/** GET /api/planner/loads */
exports.getLoads = asyncHandler(async (req, res) => {
  const data = await loadService.getLoads();
  return res.json({ success: true, data });
});

/** PUT /api/planner/loads */
exports.saveLoad = asyncHandler(async (req, res) => {
  const data = await loadService.saveLoad(req.body);
  return res.json({ success: true, message: "Saqlandi", data });
});

// ── BANDLIK ──

/** GET /api/planner/availability */
exports.getAvailability = asyncHandler(async (req, res) => {
  const data = await availabilityService.getAvailability();
  return res.json({ success: true, data });
});

/** PUT /api/planner/availability/:teacherId */
exports.setAvailability = asyncHandler(async (req, res) => {
  const data = await availabilityService.setAvailability(
    req.params.teacherId,
    req.body.slots,
  );
  return res.json({ success: true, message: "Saqlandi", data });
});

/** PATCH /api/planner/availability/:teacherId/toggle */
exports.toggleSlot = asyncHandler(async (req, res) => {
  const data = await availabilityService.toggleSlot(
    req.params.teacherId,
    req.body.day,
    req.body.order,
  );
  return res.json({ success: true, data });
});

/** POST /api/planner/availability/:teacherId/from-work-schedule */
exports.fillFromWorkSchedule = asyncHandler(async (req, res) => {
  const { filled, availability } = await availabilityService.fillFromWorkSchedule(
    req.params.teacherId,
  );
  return res.json({
    success: true,
    message: `${filled} ta katak band deb belgilandi`,
    data: availability,
  });
});

// ── SOZLAMALAR ──

/** GET /api/planner/settings */
exports.getSettings = asyncHandler(async (req, res) => {
  const [settings, grid] = await Promise.all([
    settingsService.getSettings(),
    settingsService.getGrid(),
  ]);
  return res.json({
    success: true,
    data: { settings, days: grid.days, periods: grid.periods },
  });
});

/** PUT /api/planner/settings */
exports.updateSettings = asyncHandler(async (req, res) => {
  const settings = await settingsService.updateSettings(req.body, req.user.id);
  return res.json({ success: true, message: "Sozlamalar saqlandi", data: settings });
});

// ── SHAKLLANTIRISH ──

/** GET /api/planner/preflight */
exports.getPreflight = asyncHandler(async (req, res) => {
  const data = await generatorService.getPreflight();
  return res.json({ success: true, data });
});

/** POST /api/planner/runs */
exports.generate = asyncHandler(async (req, res) => {
  const data = await generatorService.generate(req.body, req.user.id);
  return res.status(201).json({
    success: true,
    message: "Jadval shakllantirildi",
    data,
  });
});

// ── VARIANTLAR ──

/** GET /api/planner/runs */
exports.listRuns = asyncHandler(async (req, res) => {
  const data = await runService.listRuns();
  return res.json({ success: true, data });
});

/** GET /api/planner/runs/:id */
exports.getRun = asyncHandler(async (req, res) => {
  const data = await runService.getRun(req.params.id);
  return res.json({ success: true, data });
});

/** PATCH /api/planner/runs/:id */
exports.renameRun = asyncHandler(async (req, res) => {
  const data = await runService.renameRun(req.params.id, req.body.name);
  return res.json({ success: true, message: "Nom o'zgartirildi", data });
});

/** DELETE /api/planner/runs/:id */
exports.deleteRun = asyncHandler(async (req, res) => {
  const data = await runService.deleteRun(req.params.id);
  return res.json({ success: true, message: "Variant o'chirildi", data });
});

/** GET /api/planner/runs/:id/export */
exports.exportRun = asyncHandler(async (req, res) => {
  const { run, data } = await runService.getRunForExport(req.params.id);

  const workbook = ExcelService.createExcel({
    sheetName: "Dars jadvali",
    columns: [
      { header: "Sinf", key: "className", width: 12 },
      { header: "Kun", key: "day", width: 14 },
      { header: "Dars", key: "order", width: 8 },
      { header: "Vaqt", key: "time", width: 16 },
      { header: "Fan", key: "subject", width: 28 },
      { header: "O'qituvchi", key: "teacher", width: 26 },
    ],
    data,
    headerStyle: { bgColor: ExcelService.COLORS.HEADER_PURPLE },
  });

  const filename = ExcelService.generateFileName(`dars_jadvali_rejasi_${run.name}`);
  await ExcelService.sendWorkbook(res, workbook, filename);
});

// ── VARIANTDAGI DARSLAR (qo'lda tuzatish) ──

/** POST /api/planner/runs/:id/lessons */
exports.addLesson = asyncHandler(async (req, res) => {
  const data = await runService.addLesson(req.params.id, req.body);
  return res.status(201).json({ success: true, message: "Dars qo'shildi", data });
});

/** PATCH /api/planner/runs/:id/lessons/:lessonId */
exports.updateLesson = asyncHandler(async (req, res) => {
  const { id, lessonId } = req.params;

  if (req.body.isPinned !== undefined && req.body.day === undefined) {
    const data = await runService.setPinned(id, lessonId, req.body.isPinned);
    return res.json({ success: true, data });
  }

  const data = await runService.moveLesson(id, lessonId, req.body);
  return res.json({ success: true, message: "Dars ko'chirildi", data });
});

/** DELETE /api/planner/runs/:id/lessons/:lessonId */
exports.removeLesson = asyncHandler(async (req, res) => {
  const data = await runService.removeLesson(req.params.id, req.params.lessonId);
  return res.json({ success: true, message: "Dars olib tashlandi", data });
});
