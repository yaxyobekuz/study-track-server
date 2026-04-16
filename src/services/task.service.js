const Task = require("../models/task.model");
const Penalty = require("../models/penalty.model");
const User = require("../models/user.model");
const {
  uploadPenaltyAttachments,
  deletePenaltyAttachments,
} = require("./file.service");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");
const logger = require("../utils/logger");

// ─── YORDAMCHI FUNKSIYALAR ─────────────────────────────────────────

const _uploadTaskAttachments = async (files) => {
  return uploadPenaltyAttachments(files);
};

const _deleteTaskAttachments = async (attachments) => {
  return deletePenaltyAttachments(attachments);
};

const _applyPenalty = async (task, points, reason, givenById) => {
  const now = new Date();

  const penalty = await Penalty.create({
    user: task.assignee,
    givenBy: givenById,
    title: `Topshiriq: ${task.title}`,
    description: reason,
    points,
    status: "approved",
    isCustom: true,
    reviewedBy: givenById,
    reviewedAt: now,
  });

  await User.findByIdAndUpdate(task.assignee, {
    $inc: { penaltyPoints: points },
  });

  task.penaltyRef = penalty._id;
  task.autopenalized = true;

  return penalty;
};

// ─── ASOSIY FUNKSIYALAR ────────────────────────────────────────────

const createTasks = async ({
  title,
  description,
  dueDate,
  penaltyPoints,
  assigneeIds,
  createdBy,
  files,
}) => {
  if (!assigneeIds || assigneeIds.length === 0) {
    throw new BadRequestError("Kamida bitta ijrochi tanlash kerak");
  }

  // Assigneelar mavjudligini tekshirish
  const users = await User.find({ _id: { $in: assigneeIds } }).select("_id");
  if (users.length !== assigneeIds.length) {
    throw new BadRequestError("Ba'zi foydalanuvchilar topilmadi");
  }

  let attachments = [];
  if (files && files.length > 0) {
    attachments = await _uploadTaskAttachments(files);
  }

  const now = new Date();
  const initialStatus = "pending";

  const taskDocs = assigneeIds.map((assigneeId) => ({
    title,
    description,
    dueDate: new Date(dueDate),
    penaltyPoints,
    assignee: assigneeId,
    createdBy,
    status: initialStatus,
    attachments,
    statusHistory: [
      {
        status: initialStatus,
        reason: "Topshiriq yaratildi",
        changedBy: createdBy,
        changedAt: now,
      },
    ],
  }));

  const tasks = await Task.insertMany(taskDocs);
  return tasks;
};

/**
 * Barcha topshiriqlar ro'yxatini qaytaradi (owner uchun)
 * @param {object} req - Express request (query: page, limit, status, assigneeId, startDate, endDate)
 * @returns {Promise<object>} Sahifalangan topshiriqlar
 */
const getTasks = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { status, assigneeId, startDate, endDate } = req.query;

  const filter = {};
  if (status && status !== "all") filter.status = status;
  if (assigneeId) filter.assignee = assigneeId;
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate)
      filter.createdAt.$lte = new Date(
        new Date(endDate).setHours(23, 59, 59, 999),
      );
  }

  const [tasks, total] = await Promise.all([
    Task.find(filter)
      .populate("assignee", "firstName lastName role")
      .populate("createdBy", "firstName lastName")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Task.countDocuments(filter),
  ]);

  return formatPaginationResponse(tasks, total, page, limit);
};

const getMyTasks = async (userId, req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { status } = req.query;

  const filter = { assignee: userId };
  if (status && status !== "all") filter.status = status;

  const [tasks, total] = await Promise.all([
    Task.find(filter)
      .populate("createdBy", "firstName lastName")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Task.countDocuments(filter),
  ]);

  return formatPaginationResponse(tasks, total, page, limit);
};

const getTaskById = async (taskId, requestingUser) => {
  const task = await Task.findById(taskId)
    .populate("assignee", "firstName lastName role penaltyPoints")
    .populate("createdBy", "firstName lastName role")
    .populate("statusHistory.changedBy", "firstName lastName role")
    .populate("deadlineHistory.changedBy", "firstName lastName role")
    .populate("penaltyRef", "points title createdAt");

  if (!task) {
    throw new NotFoundError("Topshiriq topilmadi");
  }

  if (
    requestingUser.role !== "owner" &&
    task.assignee._id.toString() !== requestingUser._id.toString()
  ) {
    throw new ForbiddenError("Bu topshiriqni ko'rishga ruxsat yo'q");
  }

  return task;
};

const submitTaskCompletion = async (taskId, userId, { note, files }) => {
  const task = await Task.findById(taskId);
  if (!task) throw new NotFoundError("Topshiriq topilmadi");

  if (task.assignee.toString() !== userId.toString()) {
    throw new ForbiddenError("Bu topshiriqni yangilashga ruxsat yo'q");
  }

  const allowedStatuses = ["pending", "extended", "pending_rejected"];
  if (!allowedStatuses.includes(task.status)) {
    throw new BadRequestError(
      `Joriy status (${task.status}) da topshiriqni yakunlash mumkin emas`,
    );
  }

  // Eski completion fayllarini o'chirish
  if (task.completionAttachments && task.completionAttachments.length > 0) {
    await _deleteTaskAttachments(task.completionAttachments);
  }

  let newAttachments = [];
  if (files && files.length > 0) {
    newAttachments = await _uploadTaskAttachments(files);
  }

  task.completionNote = note || "";
  task.completionAttachments = newAttachments;
  task.status = "pending_review";
  task.statusHistory.push({
    status: "pending_review",
    reason: note || "Topshiriq bajarildi",
    changedBy: userId,
    changedAt: new Date(),
  });

  await task.save();
  return task;
};

const approveTask = async (taskId, { reason, approvedBy }) => {
  const task = await Task.findById(taskId);
  if (!task) throw new NotFoundError("Topshiriq topilmadi");

  if (task.status !== "pending_review") {
    throw new BadRequestError(
      "Faqat tasdiq kutilayotgan topshiriqni tasdiqlash mumkin",
    );
  }

  task.status = "completed";
  task.statusHistory.push({
    status: "completed",
    reason: reason || "Topshiriq tasdiqlandi",
    changedBy: approvedBy,
    changedAt: new Date(),
  });

  await task.save();
  return task;
};

const rejectTask = async (taskId, { reason, rejectedBy, newDueDate }) => {
  const task = await Task.findById(taskId);
  if (!task) throw new NotFoundError("Topshiriq topilmadi");

  if (task.status !== "pending_review") {
    throw new BadRequestError(
      "Faqat tasdiq kutilayotgan topshiriqni rad etish mumkin",
    );
  }

  const now = new Date();
  const isOverdue = task.dueDate < now;

  if (isOverdue && !newDueDate) {
    throw new BadRequestError(
      "Muddati o'tganligi sababli yangi ijro muddati majburiy",
    );
  }

  // Muddati o'tgan va hali jarima qo'llanilmagan bo'lsa jarima yoziladi
  if (isOverdue && !task.autopenalized) {
    await _applyPenalty(task, task.penaltyPoints, reason, rejectedBy);
  }

  task.status = "pending_rejected";
  task.statusHistory.push({
    status: "pending_rejected",
    reason,
    changedBy: rejectedBy,
    changedAt: now,
  });

  if (newDueDate) {
    task.deadlineHistory.push({
      oldDueDate: task.dueDate,
      newDueDate: new Date(newDueDate),
      reason,
      changedBy: rejectedBy,
      changedAt: now,
      withPenalty: false,
    });
    task.dueDate = new Date(newDueDate);
    // Yangi muddat = yangi imkoniyat, jarima qayta qo'llanilmasligi uchun
    task.autopenalized = false;
  }

  await task.save();
  return task;
};

const stopTask = async (
  taskId,
  { reason, withPenalty, penaltyPoints, stoppedBy },
) => {
  const task = await Task.findById(taskId);
  if (!task) throw new NotFoundError("Topshiriq topilmadi");

  const activeStatuses = [
    "pending",
    "extended",
    "pending_rejected",
    "pending_review",
  ];
  if (!activeStatuses.includes(task.status)) {
    throw new BadRequestError("Bu topshiriqni to'xtatib bo'lmaydi");
  }

  if (withPenalty && !task.autopenalized) {
    const points = penaltyPoints || task.penaltyPoints;
    await _applyPenalty(task, points, reason, stoppedBy);
  }

  task.status = "stopped";
  task.statusHistory.push({
    status: "stopped",
    reason,
    changedBy: stoppedBy,
    changedAt: new Date(),
  });

  await task.save();
  return task;
};

const extendDeadline = async (
  taskId,
  { newDueDate, reason, withPenalty, penaltyPoints, extendedBy },
) => {
  const task = await Task.findById(taskId);
  if (!task) throw new NotFoundError("Topshiriq topilmadi");

  const terminalStatuses = ["completed", "stopped"];
  if (terminalStatuses.includes(task.status)) {
    throw new BadRequestError(
      "Yakunlangan yoki to'xtatilgan topshiriqning muddatini uzaytirish mumkin emas",
    );
  }

  if (new Date(newDueDate) <= task.dueDate) {
    throw new BadRequestError(
      "Yangi muddat eski muddatdan keyin bo'lishi kerak",
    );
  }

  const now = new Date();

  if (withPenalty) {
    const points = penaltyPoints || task.penaltyPoints;
    await _applyPenalty(task, points, reason, extendedBy);
  }

  task.deadlineHistory.push({
    oldDueDate: task.dueDate,
    newDueDate: new Date(newDueDate),
    reason,
    changedBy: extendedBy,
    changedAt: now,
    withPenalty: !!withPenalty,
    penaltyPoints: withPenalty ? penaltyPoints || task.penaltyPoints : 0,
  });

  // pending, pending_rejected va pending_review statuslarida "extended" ga o'tkaziladi
  if (["pending", "pending_rejected", "pending_review"].includes(task.status)) {
    task.status = "extended";
  }

  task.dueDate = new Date(newDueDate);
  // Yangi muddat = yangi imkoniyat
  task.autopenalized = false;

  task.statusHistory.push({
    status: task.status,
    reason: `Ijro muddati uzaytirildi: ${reason}`,
    changedBy: extendedBy,
    changedAt: now,
  });

  await task.save();
  return task;
};

module.exports = {
  createTasks,
  getTasks,
  getMyTasks,
  getTaskById,
  submitTaskCompletion,
  approveTask,
  rejectTask,
  stopTask,
  extendDeadline,
};
