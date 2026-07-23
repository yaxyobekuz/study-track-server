const prisma = require("../config/prisma");
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

// assignee/createdBy/changedBy/penaltyRef — soft ref (FK emas), qo'lda yuklaymiz.
// Foydalanuvchilarni bir so'rovda olib, xaritaga solamiz.
const _loadUserMap = async (ids, select) => {
  const uniqueIds = [...new Set(ids.filter(Boolean).map((x) => String(x)))];
  if (uniqueIds.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: uniqueIds } },
    select,
  });
  return new Map(users.map((u) => [u.id, u]));
};

// Ro'yxat topshiriqlariga assignee va createdBy'ni biriktiradi (list populate o'rnida).
const _attachListRefs = async (tasks, { withAssignee } = {}) => {
  const ids = [];
  for (const t of tasks) {
    if (withAssignee) ids.push(t.assignee);
    ids.push(t.createdBy);
  }
  const map = await _loadUserMap(ids, {
    id: true,
    firstName: true,
    lastName: true,
    role: true,
  });
  return tasks.map((t) => ({
    ...t,
    ...(withAssignee ? { assignee: map.get(String(t.assignee)) || null } : {}),
    createdBy: map.get(String(t.createdBy)) || null,
  }));
};

// _applyPenalty jarima yaratadi, foydalanuvchi ballarini oshiradi va jarima hujjatini
// qaytaradi. Chaqiruvchi task.penaltyRef/autopenalized ni o'z update data'siga qo'shadi.
const _applyPenalty = async (task, points, reason, givenById) => {
  const now = new Date();

  const penalty = await prisma.penalty.create({
    data: {
      userId: task.assignee,
      givenBy: givenById,
      title: `Topshiriq: ${task.title}`,
      description: reason,
      points,
      status: "approved",
      isCustom: true,
      reviewedBy: givenById,
      reviewedAt: now,
    },
  });

  await prisma.user.update({
    where: { id: task.assignee },
    data: { penaltyPoints: { increment: points } },
  });

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
  const users = await prisma.user.findMany({
    where: { id: { in: assigneeIds } },
    select: { id: true },
  });
  if (users.length !== assigneeIds.length) {
    throw new BadRequestError("Ba'zi foydalanuvchilar topilmadi");
  }

  let attachments = [];
  if (files && files.length > 0) {
    attachments = await _uploadTaskAttachments(files);
  }

  const now = new Date();
  const initialStatus = "pending";

  const tasks = [];
  for (const assigneeId of assigneeIds) {
    const task = await prisma.task.create({
      data: {
        title,
        description,
        dueDate: new Date(dueDate),
        penaltyPoints,
        assignee: assigneeId,
        createdBy,
        status: initialStatus,
        attachments,
        statusHistory: {
          create: [
            {
              status: initialStatus,
              reason: "Topshiriq yaratildi",
              changedBy: createdBy,
              changedAt: now,
              position: 0,
            },
          ],
        },
      },
    });
    tasks.push(task);
  }

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
    if (startDate) filter.createdAt.gte = new Date(startDate);
    if (endDate)
      filter.createdAt.lte = new Date(
        new Date(endDate).setHours(23, 59, 59, 999),
      );
  }

  const [rows, total] = await Promise.all([
    prisma.task.findMany({
      where: filter,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.task.count({ where: filter }),
  ]);

  const tasks = await _attachListRefs(rows, { withAssignee: true });

  return formatPaginationResponse(tasks, total, page, limit);
};

const getMyTasks = async (userId, req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { status } = req.query;

  const filter = { assignee: userId };
  if (status && status !== "all") filter.status = status;

  const [rows, total] = await Promise.all([
    prisma.task.findMany({
      where: filter,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.task.count({ where: filter }),
  ]);

  const tasks = await _attachListRefs(rows, { withAssignee: false });

  return formatPaginationResponse(tasks, total, page, limit);
};

const getTaskById = async (taskId, requestingUser) => {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      statusHistory: { orderBy: { position: "asc" } },
      deadlineHistory: { orderBy: { position: "asc" } },
    },
  });

  if (!task) {
    throw new NotFoundError("Topshiriq topilmadi");
  }

  // assignee/createdBy/changedBy/penaltyRef — soft ref, qo'lda populate qilamiz
  const userMap = await _loadUserMap(
    [
      task.assignee,
      task.createdBy,
      ...task.statusHistory.map((h) => h.changedBy),
      ...task.deadlineHistory.map((h) => h.changedBy),
    ],
    { id: true, firstName: true, lastName: true, role: true, penaltyPoints: true },
  );

  const assignee = userMap.get(String(task.assignee)) || null;
  task.assignee = assignee;
  task.createdBy = userMap.get(String(task.createdBy)) || null;
  task.statusHistory = task.statusHistory.map((h) => ({
    ...h,
    changedBy: h.changedBy ? userMap.get(String(h.changedBy)) || null : null,
  }));
  task.deadlineHistory = task.deadlineHistory.map((h) => ({
    ...h,
    changedBy: h.changedBy ? userMap.get(String(h.changedBy)) || null : null,
  }));

  // penaltyRef — soft ref
  task.penaltyRef = task.penaltyRef
    ? await prisma.penalty.findUnique({
        where: { id: task.penaltyRef },
        select: { id: true, points: true, title: true, createdAt: true },
      })
    : null;

  if (
    requestingUser.role !== "owner" &&
    (!assignee || String(assignee.id) !== String(requestingUser._id))
  ) {
    throw new ForbiddenError("Bu topshiriqni ko'rishga ruxsat yo'q");
  }

  return task;
};

const submitTaskCompletion = async (taskId, userId, { note, files }) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq topilmadi");

  if (String(task.assignee) !== String(userId)) {
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

  const position = await prisma.taskStatusHistory.count({
    where: { taskId: task.id },
  });

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      completionNote: note || "",
      completionAttachments: newAttachments,
      status: "pending_review",
      statusHistory: {
        create: {
          status: "pending_review",
          reason: note || "Topshiriq bajarildi",
          changedBy: userId,
          changedAt: new Date(),
          position,
        },
      },
    },
  });

  return updated;
};

const approveTask = async (taskId, { reason, approvedBy }) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq topilmadi");

  if (task.status !== "pending_review") {
    throw new BadRequestError(
      "Faqat tasdiq kutilayotgan topshiriqni tasdiqlash mumkin",
    );
  }

  const position = await prisma.taskStatusHistory.count({
    where: { taskId: task.id },
  });

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      status: "completed",
      statusHistory: {
        create: {
          status: "completed",
          reason: reason || "Topshiriq tasdiqlandi",
          changedBy: approvedBy,
          changedAt: new Date(),
          position,
        },
      },
    },
  });

  return updated;
};

const rejectTask = async (taskId, { reason, rejectedBy, newDueDate }) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
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

  const data = {};

  // Muddati o'tgan va hali jarima qo'llanilmagan bo'lsa jarima yoziladi
  if (isOverdue && !task.autopenalized) {
    const penalty = await _applyPenalty(
      task,
      task.penaltyPoints,
      reason,
      rejectedBy,
    );
    data.penaltyRef = penalty.id;
    data.autopenalized = true;
  }

  data.status = "pending_rejected";

  const statusPosition = await prisma.taskStatusHistory.count({
    where: { taskId: task.id },
  });
  const statusHistoryCreate = [
    {
      status: "pending_rejected",
      reason,
      changedBy: rejectedBy,
      changedAt: now,
      position: statusPosition,
    },
  ];

  if (newDueDate) {
    const deadlinePosition = await prisma.taskDeadlineHistory.count({
      where: { taskId: task.id },
    });
    data.deadlineHistory = {
      create: {
        oldDueDate: task.dueDate,
        newDueDate: new Date(newDueDate),
        reason,
        changedBy: rejectedBy,
        changedAt: now,
        withPenalty: false,
        position: deadlinePosition,
      },
    };
    data.dueDate = new Date(newDueDate);
    // Yangi muddat = yangi imkoniyat, jarima qayta qo'llanilmasligi uchun
    data.autopenalized = false;
  }

  data.statusHistory = { create: statusHistoryCreate };

  const updated = await prisma.task.update({
    where: { id: task.id },
    data,
  });

  return updated;
};

const stopTask = async (
  taskId,
  { reason, withPenalty, penaltyPoints, stoppedBy },
) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
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

  const data = {};

  if (withPenalty && !task.autopenalized) {
    const points = penaltyPoints || task.penaltyPoints;
    const penalty = await _applyPenalty(task, points, reason, stoppedBy);
    data.penaltyRef = penalty.id;
    data.autopenalized = true;
  }

  const position = await prisma.taskStatusHistory.count({
    where: { taskId: task.id },
  });

  data.status = "stopped";
  data.statusHistory = {
    create: {
      status: "stopped",
      reason,
      changedBy: stoppedBy,
      changedAt: new Date(),
      position,
    },
  };

  const updated = await prisma.task.update({
    where: { id: task.id },
    data,
  });

  return updated;
};

const extendDeadline = async (
  taskId,
  { newDueDate, reason, withPenalty, penaltyPoints, extendedBy },
) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
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

  const data = {};

  if (withPenalty) {
    const points = penaltyPoints || task.penaltyPoints;
    const penalty = await _applyPenalty(task, points, reason, extendedBy);
    data.penaltyRef = penalty.id;
    data.autopenalized = true;
  }

  const deadlinePosition = await prisma.taskDeadlineHistory.count({
    where: { taskId: task.id },
  });
  data.deadlineHistory = {
    create: {
      oldDueDate: task.dueDate,
      newDueDate: new Date(newDueDate),
      reason,
      changedBy: extendedBy,
      changedAt: now,
      withPenalty: !!withPenalty,
      penaltyPoints: withPenalty ? penaltyPoints || task.penaltyPoints : 0,
      position: deadlinePosition,
    },
  };

  // pending, pending_rejected va pending_review statuslarida "extended" ga o'tkaziladi
  let nextStatus = task.status;
  if (["pending", "pending_rejected", "pending_review"].includes(task.status)) {
    nextStatus = "extended";
  }
  data.status = nextStatus;

  data.dueDate = new Date(newDueDate);
  // Yangi muddat = yangi imkoniyat
  data.autopenalized = false;

  const statusPosition = await prisma.taskStatusHistory.count({
    where: { taskId: task.id },
  });
  data.statusHistory = {
    create: {
      status: nextStatus,
      reason: `Ijro muddati uzaytirildi: ${reason}`,
      changedBy: extendedBy,
      changedAt: now,
      position: statusPosition,
    },
  };

  const updated = await prisma.task.update({
    where: { id: task.id },
    data,
  });

  return updated;
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
