const asyncHandler = require("../middleware/async.middleware");
const { BadRequestError } = require("../utils/errors");
const taskService = require("../services/task.service");

/**
 * Bir nechta foydalanuvchiga topshiriq yaratadi
 * POST /tasks
 */
const createTask = asyncHandler(async (req, res) => {
  const { title, description, dueDate, penaltyPoints, assigneeIds } = req.body;

  if (!title) throw new BadRequestError("Sarlavha majburiy");
  if (!description) throw new BadRequestError("Tavsif majburiy");
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
    penaltyPoints: penaltyPoints ? Number(penaltyPoints) : 1,
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
  const { reason } = req.body;
  if (!reason) throw new BadRequestError("Sabab majburiy");

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

module.exports = {
  createTask,
  getTasks,
  getMyTasks,
  getTaskById,
  submitCompletion,
  approveTask,
  rejectTask,
  stopTask,
  extendDeadline,
};
