/**
 * XODIM O'ZIGA O'ZI BELGILAGAN TOPSHIRIQLAR — HTTP qatlami.
 *
 * Ikki guruh:
 *
 *   `/self-tasks/*`        — XODIMNING O'ZI (ruxsat kalitisiz, id tokendan).
 *                            Egalik `req.selfScope` orqali va u HAR AMALDA
 *                            qayta tekshiriladi (`task.service.js`).
 *   `/self-tasks/overview` — BOSHQARUVCHI (`tasks.self`): dashboard va
 *   `/self-tasks/all`        ro'yxat, doira `req.selfViewScope` dan.
 *
 * ⚠️ MUTATSIYALAR MAVJUD SERVISGA BORADI (`task.service.js`), ikkinchi
 * nusxa yozilmadi: doira `self` bo'lgani uchun tahrirlash, to'xtatish,
 * muddat surish, qayta ochish va o'chirish AYNI funksiyalarda ishlaydi.
 */

const asyncHandler = require("../middleware/async.middleware");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const taskService = require("../services/task.service");
const selfTaskService = require("../services/selfTask.service");
const taskScheduleService = require("../services/taskSchedule.service");
// So'rov tanasi — YAGONA parser (`taskRequest.helpers.js`): `multipart` da
// massivlar JSON satri bo'lib keladi
const { buildSchedulePayload } = require("../helpers/taskRequest.helpers");

// ─── XODIMNING O'ZI ────────────────────────────────────────────────

/**
 * O'ziga bir martalik topshiriq belgilaydi
 * POST /self-tasks
 */
const createSelfTask = asyncHandler(async (req, res) => {
  if (!req.body.dueDate) throw new BadRequestError("Ijro muddati majburiy");

  const task = await selfTaskService.createSelfTask(req.body, req.user.id, req.files || []);

  return res.status(201).json({
    success: true,
    data: task,
    message: "Topshiriq o'zingizga belgilandi",
  });
});

/**
 * O'ziga doimiy (takrorlanuvchi) ish belgilaydi
 * POST /self-tasks/rules
 */
const createSelfSchedule = asyncHandler(async (req, res) => {
  const schedule = await selfTaskService.createSelfSchedule(
    buildSchedulePayload(req),
    req.user.id,
    req.files || [],
  );

  return res.status(201).json({
    success: true,
    data: schedule,
    message: "Doimiy ish o'zingizga belgilandi",
  });
});

/**
 * O'zi belgilagan topshiriqlari ro'yxati
 * GET /self-tasks
 */
const getSelfTasks = asyncHandler(async (req, res) => {
  const result = await selfTaskService.listSelfTasks(req.user.id, req);
  return res.json(result);
});

/**
 * O'z hisoblagichlari (ro'yxat tepasidagi kartalar)
 * GET /self-tasks/stats
 */
const getSelfStats = asyncHandler(async (req, res) => {
  const data = await selfTaskService.getSelfStats(req.user.id);
  return res.json({ success: true, data });
});

/**
 * O'zi belgilagan doimiy ishlari
 * GET /self-tasks/rules
 */
const getSelfSchedules = asyncHandler(async (req, res) => {
  const result = await selfTaskService.listSelfSchedules(req, req.user.id);
  return res.json(result);
});

/**
 * Bitta shaxsiy topshiriq
 * GET /self-tasks/:id
 */
const getSelfTaskById = asyncHandler(async (req, res) => {
  const task = await taskService.getTaskById(req.params.id, req.user, req.selfScope);
  return res.json({ success: true, data: task });
});

/**
 * YAKUNLASH — "Tekshiruvda" bosqichisiz, darhol "Yakunlangan"
 * (`task.service.js` → `submitTaskCompletion`).
 * PUT /self-tasks/:id/complete
 */
const completeSelfTask = asyncHandler(async (req, res) => {
  const task = await taskService.submitTaskCompletion(req.params.id, req.user.id, {
    note: req.body.note,
    files: req.files || [],
    scope: req.selfScope,
  });

  return res.json({ success: true, data: task, message: "Topshiriq yakunlandi" });
});

/**
 * Tahrirlash — ijrochi va jarima bali YOPIQ (service rad etadi)
 * PUT /self-tasks/:id
 */
const updateSelfTask = asyncHandler(async (req, res) => {
  const { title, description, kind, startDate, links, removeAttachmentKeys } = req.body;

  let removeKeys = [];
  if (removeAttachmentKeys) {
    try {
      removeKeys = JSON.parse(removeAttachmentKeys);
    } catch {
      throw new BadRequestError("removeAttachmentKeys formati noto'g'ri");
    }
    if (!Array.isArray(removeKeys)) {
      throw new BadRequestError("removeAttachmentKeys formati noto'g'ri");
    }
  }

  const task = await taskService.updateTask(
    req.params.id,
    {
      title,
      description,
      kind,
      startDate,
      links,
      removeAttachmentKeys: removeKeys,
      files: req.files || [],
    },
    req.user.id,
    req.selfScope,
  );

  return res.json({ success: true, data: task, message: "Topshiriq tahrirlandi" });
});

/**
 * MUDDATNI SURISH — jarimasiz (service `selfAssigned` da jarimani rad etadi),
 * sabab majburiy va tarixga yoziladi.
 * PUT /self-tasks/:id/extend
 */
const extendSelfTask = asyncHandler(async (req, res) => {
  const { newDueDate, reason } = req.body;
  if (!newDueDate) throw new BadRequestError("Yangi ijro muddati majburiy");
  if (!reason || !String(reason).trim()) throw new BadRequestError("Sabab majburiy");

  const task = await taskService.extendDeadline(req.params.id, {
    newDueDate,
    reason: String(reason).trim(),
    // ⚠️ Bayroq umuman yuborilmaydi — shaxsiy topshiriqda jarima yo'q
    withPenalty: false,
    extendedBy: req.user.id,
    scope: req.selfScope,
  });

  return res.json({ success: true, data: task, message: "Muddat o'zgartirildi" });
});

/**
 * TO'XTATISH — "kerak bo'lmay qoldi", sabab majburiy
 * PUT /self-tasks/:id/stop
 */
const stopSelfTask = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  if (!reason || !String(reason).trim()) throw new BadRequestError("Sabab majburiy");

  const task = await taskService.stopTask(req.params.id, {
    reason: String(reason).trim(),
    withPenalty: false,
    stoppedBy: req.user.id,
    scope: req.selfScope,
  });

  return res.json({ success: true, data: task, message: "Topshiriq to'xtatildi" });
});

/**
 * QAYTA OCHISH — yangi muddat bilan (adashib yopilgan yoki qaytib kelgan ish)
 * PUT /self-tasks/:id/reopen
 */
const reopenSelfTask = asyncHandler(async (req, res) => {
  const { newDueDate, reason } = req.body;
  if (!newDueDate) throw new BadRequestError("Yangi ijro muddati majburiy");

  const task = await taskService.reopenTask(req.params.id, {
    newDueDate,
    reason: String(reason ?? "").trim() || "O'zi qayta ochdi",
    reopenedBy: req.user.id,
    scope: req.selfScope,
  });

  return res.json({ success: true, data: task, message: "Topshiriq qayta ochildi" });
});

/**
 * O'CHIRISH — o'zining shaxsiy rejasi, tarixga qoldirish majburiyati yo'q
 * DELETE /self-tasks/:id
 */
const deleteSelfTask = asyncHandler(async (req, res) => {
  await taskService.deleteTask(req.params.id, {
    deletedBy: req.user.id,
    scope: req.selfScope,
  });

  return res.json({ success: true, message: "Topshiriq o'chirildi" });
});

// ─── DOIMIY ISH QOIDASI (o'zining) ────────────────────────────────

/** PUT /self-tasks/rules/:id */
const updateSelfSchedule = asyncHandler(async (req, res) => {
  const data = await taskScheduleService.updateSchedule(
    req.params.id,
    buildSchedulePayload(req),
    req.user.id,
    req.selfScope,
  );
  return res.json({ success: true, data, message: "Doimiy ish yangilandi" });
});

/** PUT /self-tasks/rules/:id/stop */
const stopSelfSchedule = asyncHandler(async (req, res) => {
  const data = await taskScheduleService.stopSchedule(
    req.params.id,
    { reason: req.body.reason, userId: req.user.id },
    req.selfScope,
  );
  return res.json({ success: true, data, message: "Doimiy ish to'xtatildi" });
});

/** PUT /self-tasks/rules/:id/resume */
const resumeSelfSchedule = asyncHandler(async (req, res) => {
  const data = await taskScheduleService.resumeSchedule(
    req.params.id,
    req.user.id,
    req.selfScope,
  );
  return res.json({ success: true, data, message: "Doimiy ish qayta yoqildi" });
});

/** DELETE /self-tasks/rules/:id */
const deleteSelfSchedule = asyncHandler(async (req, res) => {
  await taskScheduleService.deleteSchedule(req.params.id, req.user.id, req.selfScope);
  return res.json({ success: true, message: "Doimiy ish o'chirildi" });
});

// ─── BOSHQARUVCHI (`tasks.self`) ──────────────────────────────────

/**
 * DASHBOARD — Lavozimlar markazidagi hisobot dvigatelining O'ZI, shaxsiy
 * oqim kesimida.
 * GET /self-tasks/overview?period=day|week|month|year
 */
const getSelfOverview = asyncHandler(async (req, res) => {
  selfTaskService.assertSelfViewScope(req.selfViewScope);

  const data = await selfTaskService.getSelfOverview(req.query, req.selfViewScope);
  return res.json({ success: true, data });
});

/**
 * Barcha xodimlarning shaxsiy topshiriqlari ro'yxati (doira bo'yicha)
 * GET /self-tasks/all
 */
const getAllSelfTasks = asyncHandler(async (req, res) => {
  selfTaskService.assertSelfViewScope(req.selfViewScope);

  const result = await selfTaskService.listAllSelfTasks(req, req.selfViewScope);
  return res.json(result);
});

/**
 * Boshqaruvchi bitta shaxsiy topshiriqni ochadi (faqat KO'RISH — amallar
 * qator egasida qoladi).
 * GET /self-tasks/all/:id
 */
const getAnySelfTaskById = asyncHandler(async (req, res) => {
  selfTaskService.assertSelfViewScope(req.selfViewScope);

  const task = await taskService.getTaskById(req.params.id, req.user, req.selfViewScope);

  // ⚠️ OQIM TEKSHIRUVI SHU YERDA: `tasks.self` — SHAXSIY topshiriqlar
  // kaliti, Lavozimlar markazi registrining kaliti EMAS. Usiz faqat shu
  // kalit berilgan odam oddiy (rahbar bergan) topshiriqni ham id bo'yicha
  // o'qib olardi — ya'ni `tasks.view` jimgina tarqalib ketardi.
  if (!task.selfAssigned) {
    throw new NotFoundError("Shaxsiy topshiriq topilmadi");
  }

  return res.json({ success: true, data: task });
});

module.exports = {
  createSelfTask,
  createSelfSchedule,
  getSelfTasks,
  getSelfStats,
  getSelfSchedules,
  getSelfTaskById,
  completeSelfTask,
  updateSelfTask,
  extendSelfTask,
  stopSelfTask,
  reopenSelfTask,
  deleteSelfTask,
  updateSelfSchedule,
  stopSelfSchedule,
  resumeSelfSchedule,
  deleteSelfSchedule,
  getSelfOverview,
  getAllSelfTasks,
  getAnySelfTaskById,
};
