const asyncHandler = require("../middleware/async.middleware");
const { BadRequestError } = require("../utils/errors");
const taskService = require("../services/task.service");
const taskReportService = require("../services/taskReport.service");
const { getTaskSettings: loadTaskSettings } = require("../services/settings.service");

/**
 * Bir nechta foydalanuvchiga topshiriq yaratadi
 * POST /tasks
 */
const createTask = asyncHandler(async (req, res) => {
  const { title, description, dueDate, penaltyPoints, assigneeIds } = req.body;

  // Sarlavha/tavsif uzunligi sozlamaga bog'liq — service tekshiradi
  if (!dueDate) throw new BadRequestError("Ijro muddati majburiy");

  let parsedAssigneeIds;
  try {
    parsedAssigneeIds = JSON.parse(assigneeIds);
  } catch {
    throw new BadRequestError("assigneeIds formati noto'g'ri");
  }

  if (!Array.isArray(parsedAssigneeIds) || parsedAssigneeIds.length === 0) {
    throw new BadRequestError("Kamida bitta ijrochi tanlash kerak");
  }

  const tasks = await taskService.createTasks({
    title,
    description,
    dueDate,
    // Berilmasa — sozlamadagi standart ball
    penaltyPoints: penaltyPoints ? Number(penaltyPoints) : undefined,
    assigneeIds: parsedAssigneeIds,
    createdBy: req.user.id,
    files: req.files || [],
  });

  return res.status(201).json({
    success: true,
    data: tasks,
    message: `${tasks.length} ta topshiriq yaratildi`,
  });
});

/**
 * Barcha topshiriqlar ro'yxatini qaytaradi (owner)
 * GET /tasks
 */
const getTasks = asyncHandler(async (req, res) => {
  const result = await taskService.getTasks(req);
  return res.json(result);
});

/**
 * Foydalanuvchining o'z topshiriqlari
 * GET /tasks/my
 */
const getMyTasks = asyncHandler(async (req, res) => {
  const result = await taskService.getMyTasks(req.user.id, req);
  return res.json(result);
});

/**
 * Bitta topshiriq tafsilotlari
 * GET /tasks/:id
 */
const getTaskById = asyncHandler(async (req, res) => {
  const task = await taskService.getTaskById(req.params.id, req.user);
  return res.json({ success: true, data: task });
});

/**
 * Ijrochi topshiriqni bajarildi deb belgilaydi
 * PUT /tasks/:id/submit
 */
const submitCompletion = asyncHandler(async (req, res) => {
  const { note } = req.body;
  const task = await taskService.submitTaskCompletion(
    req.params.id,
    req.user.id,
    { note, files: req.files || [] },
  );
  return res.json({ success: true, data: task, message: "Topshiriq ko'rib chiqishga yuborildi" });
});

/**
 * Owner topshiriqni tasdiqlaydi
 * PUT /tasks/:id/approve
 */
const approveTask = asyncHandler(async (req, res) => {
  // Izoh majburiyligi sozlamaga bog'liq (`requireApproveReason`) — service tekshiradi
  const { reason } = req.body;

  const task = await taskService.approveTask(req.params.id, {
    reason,
    approvedBy: req.user.id,
  });
  return res.json({ success: true, data: task, message: "Topshiriq tasdiqlandi" });
});

/**
 * Owner topshiriqni rad etadi
 * PUT /tasks/:id/reject
 */
const rejectTask = asyncHandler(async (req, res) => {
  const { reason, newDueDate } = req.body;
  if (!reason) throw new BadRequestError("Sabab majburiy");

  const task = await taskService.rejectTask(req.params.id, {
    reason,
    rejectedBy: req.user.id,
    newDueDate,
  });
  return res.json({ success: true, data: task, message: "Topshiriq rad etildi" });
});

/**
 * Owner topshiriqni to'xtatadi
 * PUT /tasks/:id/stop
 */
const stopTask = asyncHandler(async (req, res) => {
  const { reason, withPenalty, penaltyPoints } = req.body;
  if (!reason) throw new BadRequestError("Sabab majburiy");

  const task = await taskService.stopTask(req.params.id, {
    reason,
    withPenalty: !!withPenalty,
    penaltyPoints: penaltyPoints ? Number(penaltyPoints) : undefined,
    stoppedBy: req.user.id,
  });
  return res.json({ success: true, data: task, message: "Topshiriq to'xtatildi" });
});

/**
 * Owner topshiriqning ijro muddatini uzaytiradi
 * PUT /tasks/:id/extend
 */
const extendDeadline = asyncHandler(async (req, res) => {
  const { newDueDate, reason, withPenalty, penaltyPoints } = req.body;
  if (!newDueDate) throw new BadRequestError("Yangi ijro muddati majburiy");
  if (!reason) throw new BadRequestError("Sabab majburiy");

  const task = await taskService.extendDeadline(req.params.id, {
    newDueDate,
    reason,
    withPenalty: !!withPenalty,
    penaltyPoints: penaltyPoints ? Number(penaltyPoints) : undefined,
    extendedBy: req.user.id,
  });
  return res.json({ success: true, data: task, message: "Ijro muddati uzaytirildi" });
});

/**
 * Jonli hisoblagichlar ("Asosiy" tab tepasi)
 * GET /tasks/stats
 */
const getTaskStats = asyncHandler(async (req, res) => {
  const data = await taskService.getTaskStats();
  return res.json({ success: true, data });
});

/**
 * Hisobot (davr bo'yicha)
 * GET /tasks/reports?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
const getTaskReport = asyncHandler(async (req, res) => {
  const data = await taskReportService.getTaskReport({
    from: req.query.from,
    to: req.query.to,
  });
  return res.json({ success: true, data });
});

/**
 * Topshiriq qoidalari
 * GET /tasks/settings
 */
const getTaskSettings = asyncHandler(async (req, res) => {
  const data = await loadTaskSettings();
  return res.json({ success: true, data });
});

/**
 * Topshiriq qoidalarini saqlash
 * PUT /tasks/settings
 */
const updateTaskSettings = asyncHandler(async (req, res) => {
  const data = await taskService.updateTaskSettings(req.body || {}, req.user.id);
  return res.json({ success: true, data, message: "Sozlamalar saqlandi" });
});

/**
 * Topshiriqni tahrirlash (multipart: yangi fayllar + olib tashlanadigan kalitlar)
 * PUT /tasks/:id
 */
const updateTask = asyncHandler(async (req, res) => {
  const { title, description, penaltyPoints, assigneeId, removeAttachmentKeys } = req.body;

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
      penaltyPoints,
      assigneeId,
      removeAttachmentKeys: removeKeys,
      files: req.files || [],
    },
    req.user.id,
  );
  return res.json({ success: true, data: task, message: "Topshiriq yangilandi" });
});

/**
 * Yakunlangan / to'xtatilgan topshiriqni qayta ochish
 * PUT /tasks/:id/reopen
 */
const reopenTask = asyncHandler(async (req, res) => {
  const { newDueDate, reason } = req.body;
  if (!newDueDate) throw new BadRequestError("Yangi ijro muddati majburiy");

  const task = await taskService.reopenTask(req.params.id, {
    newDueDate,
    reason,
    reopenedBy: req.user.id,
  });
  return res.json({ success: true, data: task, message: "Topshiriq qayta ochildi" });
});

/**
 * Topshiriqni o'chirish
 * DELETE /tasks/:id
 */
const deleteTask = asyncHandler(async (req, res) => {
  const data = await taskService.deleteTask(req.params.id);
  return res.json({ success: true, data, message: "Topshiriq o'chirildi" });
});

module.exports = {
  createTask,
  getTasks,
  getTaskStats,
  getTaskReport,
  getTaskSettings,
  updateTaskSettings,
  updateTask,
  reopenTask,
  deleteTask,
  getMyTasks,
  getTaskById,
  submitCompletion,
  approveTask,
  rejectTask,
  stopTask,
  extendDeadline,
};
