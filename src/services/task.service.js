const prisma = require("../config/prisma");
const {
  uploadAttachments,
  deleteAttachments,
} = require("./file.service");
const { getTaskSettings } = require("./settings.service");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");
const { hasPermission, hasRole } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const logger = require("../utils/logger");
const pushService = require("./push.service");
const { getBranch } = require("../config/branchContext");
const {
  TASK_PUSH_EVENTS,
  buildTaskPush,
} = require("../helpers/taskPush.helpers");

// ─── KONSTANTALAR ──────────────────────────────────────────────────

const ACTIVE_STATUSES = ["pending", "extended", "pending_rejected", "pending_review"];
// Ijrochi hali ishlayotgan holatlar (tekshiruvdagi ish bunga kirmaydi)
const WORKING_STATUSES = ["pending", "extended", "pending_rejected"];
const TERMINAL_STATUSES = ["completed", "stopped"];

const TITLE_MAX = 300;
const DESCRIPTION_MAX = 5000;
// Topshiriqning o'z fayllari (admin yuklaydi) — umumiy chegara
const TASK_ATTACHMENTS_MAX = 10;
// Yakunlash fayllari uchun QAT'IY yuqori chegara (sozlama bundan oshmaydi,
// route'dagi multer limiti ham shu son).
const COMPLETION_FILES_HARD_MAX = 10;

const FILE_TYPE_LABELS = {
  image: "rasm",
  video: "video",
  document: "hujjat",
};

const HOUR_MS = 60 * 60 * 1000;

// Bitta so'rovda beriladigan ijrochilar chegarasi (butun sinf / rol uchun yetarli)
const MAX_ASSIGNEES = 500;

// ─── YORDAMCHI FUNKSIYALAR ─────────────────────────────────────────

// Ijrochiga mobil push. ⚠️ KUTILMAYDI: topshiriq allaqachon yozilgan va
// Firebase sekin yoki ishlamay qolsa javob ushlanib qolmasligi kerak.
// Ketma-ket yuboriladi — 50 ijrochili topshiriq platforma bazasiga 50 ta
// parallel so'rov ochmasligi uchun.
const _notifyAssignees = (event, tasks, extra = {}) => {
  const branchId = getBranch()?.id;
  const list = Array.isArray(tasks) ? tasks : [tasks];

  (async () => {
    for (const task of list) {
      await pushService.sendToUsers(
        [task.assignee],
        buildTaskPush(event, task, { ...extra, branchId }),
      );
    }
  })().catch((error) =>
    logger.error(`[task] push yuborilmadi (${event}): ${error.message}`),
  );
};

/** Multer fayl turini sozlamadagi toifaga aylantiradi (file.service bilan bir xil qoida). */
const _fileCategory = (mimeType = "") => {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
};

const _fullName = (user) =>
  user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : "—";

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

/**
 * Fayllarni saqlashdan o'chiradi, lekin BOSHQA topshiriq hali ishora
 * qilayotganlarini qoldiradi. Bir nechta ijrochiga berilgan topshiriqlar
 * bitta faylni bo'lishadi: bittasini o'chirish qolganlarining faylini
 * buzmasligi kerak.
 */
const _deleteUnsharedAttachments = async (attachments, excludeTaskId) => {
  const list = (attachments || []).filter((a) => a && a.key);
  if (!list.length) return;

  const orphaned = [];
  for (const attachment of list) {
    const stillUsed = await prisma.task.count({
      where: {
        id: { not: excludeTaskId },
        attachments: { array_contains: [{ key: attachment.key }] },
      },
    });
    if (stillUsed === 0) orphaned.push(attachment);
  }
  await deleteAttachments(orphaned);
};

const _nextStatusPosition = (taskId) =>
  prisma.taskStatusHistory.count({ where: { taskId } });

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

/**
 * Ijrochiga ko'rsatiladigan yakunlash qoidalari — sozlamadan tayyor shaklda.
 * Panel formasi shu obyekt bo'yicha oldindan tekshiradi, server esa baribir
 * `_assertSubmission` da qayta tekshiradi.
 */
const _submissionRules = (settings) => ({
  minFiles: Math.max(1, settings.minCompletionFiles),
  maxFiles: Math.min(
    COMPLETION_FILES_HARD_MAX,
    Math.max(settings.minCompletionFiles, settings.maxCompletionFiles),
  ),
  requireNote: settings.requireCompletionNote,
  minNoteLength: settings.minCompletionNoteLength,
  fileTypes: settings.completionFileTypes?.length
    ? settings.completionFileTypes
    : ["image", "video", "document"],
  allowLateSubmission: settings.allowLateSubmission,
});

const _assertText = (value, { label, min, max }) => {
  const text = String(value ?? "").trim();
  if (min > 0 && text.length < min) {
    throw new BadRequestError(
      text.length === 0
        ? `${label} majburiy`
        : `${label} kamida ${min} ta belgidan iborat bo'lishi kerak`,
    );
  }
  if (text.length > max) {
    throw new BadRequestError(`${label} ${max} ta belgidan oshmasligi kerak`);
  }
  return text;
};

const _assertPenaltyPoints = (value, settings) => {
  const points = Number(value);
  if (!Number.isInteger(points) || points < 1) {
    throw new BadRequestError("Jarima bali kamida 1 bo'lishi kerak");
  }
  if (points > settings.maxPenaltyPoints) {
    throw new BadRequestError(
      `Jarima bali ${settings.maxPenaltyPoints} dan oshmasligi kerak`,
    );
  }
  return points;
};

const _parseDate = (value, label = "Sana") => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new BadRequestError(`${label} noto'g'ri`);
  }
  return date;
};

const _assertAssignableUsers = async (ids) => {
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, role: true, isArchived: true, firstName: true, lastName: true },
  });
  if (users.length !== ids.length) {
    throw new BadRequestError("Ba'zi foydalanuvchilar topilmadi");
  }
  if (users.some((u) => u.role === "owner")) {
    throw new BadRequestError("Tizim egasiga topshiriq berib bo'lmaydi");
  }
  if (users.some((u) => u.isArchived)) {
    throw new BadRequestError("Arxivlangan foydalanuvchiga topshiriq berib bo'lmaydi");
  }
  return users;
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

  // Bir odam ikki marta tanlansa unga ikki xil topshiriq ketmasin
  assigneeIds = [...new Set(assigneeIds.map(String))];
  if (assigneeIds.length > MAX_ASSIGNEES) {
    throw new BadRequestError(`Bir martada ko'pi bilan ${MAX_ASSIGNEES} ta ijrochiga topshiriq berish mumkin`);
  }

  const settings = await getTaskSettings();

  const cleanTitle = _assertText(title, {
    label: "Sarlavha",
    min: Math.max(1, settings.minTitleLength),
    max: TITLE_MAX,
  });
  const cleanDescription = _assertText(description, {
    label: "Tavsif",
    min: settings.minDescriptionLength,
    max: DESCRIPTION_MAX,
  });

  const due = _parseDate(dueDate, "Ijro muddati");
  const minDue = Date.now() + settings.minLeadHours * HOUR_MS;
  if (due.getTime() <= Date.now()) {
    throw new BadRequestError("Ijro muddati kelajakda bo'lishi kerak");
  }
  if (settings.minLeadHours > 0 && due.getTime() < minDue) {
    throw new BadRequestError(
      `Ijro muddati kamida ${settings.minLeadHours} soatdan keyin bo'lishi kerak`,
    );
  }

  const points = _assertPenaltyPoints(
    penaltyPoints ?? settings.defaultPenaltyPoints,
    settings,
  );

  if (settings.requireCreateAttachments && (!files || files.length === 0)) {
    throw new BadRequestError("Topshiriqqa kamida bitta fayl biriktirish kerak");
  }
  if (files && files.length > TASK_ATTACHMENTS_MAX) {
    throw new BadRequestError(`Ko'pi bilan ${TASK_ATTACHMENTS_MAX} ta fayl biriktirish mumkin`);
  }

  await _assertAssignableUsers(assigneeIds);

  let attachments = [];
  if (files && files.length > 0) {
    attachments = await uploadAttachments(files);
  }

  const now = new Date();
  const initialStatus = "pending";

  // HAR BIR IJROCHIGA ALOHIDA topshiriq: har kimning o'z holati, muddati,
  // natijasi va jarimasi bor. Hammasi BITTA tranzaksiyada — 40 kishidan
  // 25-sida xato chiqsa, yarmi berilgan-yarmi berilmagan holat qolmaydi.
  // ⚠️ Fayllar hamma nusxada UMUMIY (bir marta yuklanadi) — o'chirishda
  // `_deleteUnsharedAttachments` shuni hisobga oladi.
  let tasks;
  try {
    tasks = await prisma.$transaction(
      async (tx) => {
        const created = [];
        for (const assigneeId of assigneeIds) {
          created.push(await tx.task.create({
      data: {
        title: cleanTitle,
        description: cleanDescription,
        dueDate: due,
        penaltyPoints: points,
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
          }));
        }
        return created;
      },
      { timeout: Math.max(15000, assigneeIds.length * 200), maxWait: 10000 },
    );
  } catch (error) {
    // Yozuv bo'lmadi — yuklangan fayllar yetim qolmasin
    await deleteAttachments(attachments);
    throw error;
  }

  _notifyAssignees(TASK_PUSH_EVENTS.CREATED, tasks);

  return tasks;
};

/**
 * Ro'yxat filtri. `due` — status emas, VAQT kesimi:
 *   overdue  — faol va muddati o'tgan
 *   due_soon — faol va muddati `dueSoonHours` ichida
 */
const _buildListFilter = async (query) => {
  const { status, assigneeId, createdBy, startDate, endDate, search, due } = query;

  const filter = {};
  if (status && status !== "all") filter.status = status;
  if (assigneeId && assigneeId !== "all") filter.assignee = assigneeId;
  if (createdBy && createdBy !== "all") filter.createdBy = createdBy;
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.gte = new Date(`${startDate}T00:00:00+05:00`);
    if (endDate) filter.createdAt.lte = new Date(`${endDate}T23:59:59.999+05:00`);
  }
  if (search && String(search).trim()) {
    filter.OR = [
      { title: { contains: String(search).trim(), mode: "insensitive" } },
      { description: { contains: String(search).trim(), mode: "insensitive" } },
    ];
  }

  const now = new Date();
  if (due === "overdue") {
    filter.dueDate = { lt: now };
    if (!filter.status) filter.status = { in: WORKING_STATUSES };
  } else if (due === "due_soon") {
    const settings = await getTaskSettings();
    filter.dueDate = { gte: now, lte: new Date(now.getTime() + settings.dueSoonHours * HOUR_MS) };
    if (!filter.status) filter.status = { in: WORKING_STATUSES };
  }

  return filter;
};

const LIST_SORTS = {
  newest: { createdAt: "desc" },
  oldest: { createdAt: "asc" },
  due_asc: { dueDate: "asc" },
  due_desc: { dueDate: "desc" },
};

/**
 * Barcha topshiriqlar ro'yxatini qaytaradi (boshqaruv uchun)
 * @param {object} req - Express request (query: page, limit, status, assigneeId, createdBy,
 *   startDate, endDate, search, due, sort)
 * @returns {Promise<object>} Sahifalangan topshiriqlar
 */
const getTasks = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const filter = await _buildListFilter(req.query);
  const orderBy = LIST_SORTS[req.query.sort] || LIST_SORTS.newest;

  const [rows, total] = await Promise.all([
    prisma.task.findMany({
      where: filter,
      orderBy,
      skip,
      take: limit,
      include: { _count: { select: { deadlineHistory: true } } },
    }),
    prisma.task.count({ where: filter }),
  ]);

  const tasks = await _attachListRefs(
    rows.map(({ _count, ...t }) => ({
      ...t,
      extensionsCount: _count.deadlineHistory,
      attachmentsCount: Array.isArray(t.attachments) ? t.attachments.length : 0,
      completionAttachmentsCount: Array.isArray(t.completionAttachments)
        ? t.completionAttachments.length
        : 0,
    })),
    { withAssignee: true },
  );

  return formatPaginationResponse(tasks, total, page, limit);
};

/**
 * "Asosiy" tab tepasidagi jonli hisoblagichlar (davrga bog'liq emas).
 * @returns {Promise<object>}
 */
const getTaskStats = async () => {
  const settings = await getTaskSettings();
  const now = new Date();
  const soon = new Date(now.getTime() + settings.dueSoonHours * HOUR_MS);

  const [groups, overdue, dueSoon] = await Promise.all([
    prisma.task.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.task.count({
      where: { status: { in: WORKING_STATUSES }, dueDate: { lt: now } },
    }),
    prisma.task.count({
      where: { status: { in: WORKING_STATUSES }, dueDate: { gte: now, lte: soon } },
    }),
  ]);

  const byStatus = {
    pending: 0,
    extended: 0,
    pending_rejected: 0,
    pending_review: 0,
    completed: 0,
    stopped: 0,
  };
  for (const g of groups) byStatus[g.status] = g._count._all;

  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

  return {
    total,
    byStatus,
    inProgress: byStatus.pending + byStatus.extended + byStatus.pending_rejected,
    review: byStatus.pending_review,
    completed: byStatus.completed,
    stopped: byStatus.stopped,
    overdue,
    dueSoon,
    dueSoonHours: settings.dueSoonHours,
  };
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

const _canManage = (user) =>
  hasRole(user, ROLES.OWNER) || hasPermission(user.permissions || [], "tasks.view");

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

  const isAssignee = String(task.assignee) === String(requestingUser.id);
  const canManage = _canManage(requestingUser);

  if (!isAssignee && !canManage) {
    throw new ForbiddenError("Bu topshiriqni ko'rishga ruxsat yo'q");
  }

  // assignee/createdBy/changedBy/penaltyRef — soft ref, qo'lda populate qilamiz
  const userMap = await _loadUserMap(
    [
      task.assignee,
      task.createdBy,
      ...task.statusHistory.map((h) => h.changedBy),
      ...task.deadlineHistory.map((h) => h.changedBy),
    ],
    {
      id: true,
      firstName: true,
      lastName: true,
      role: true,
      penaltyPoints: true,
      },
  );

  const assigneeId = task.assignee;
  task.assignee = userMap.get(String(task.assignee)) || null;
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

  const settings = await getTaskSettings();
  task.submissionRules = _submissionRules(settings);
  task.reviewRules = {
    requireApproveReason: settings.requireApproveReason,
    autoPenaltyEnabled: settings.autoPenaltyEnabled,
    dueSoonHours: settings.dueSoonHours,
  };
  task.maxPenaltyPoints = settings.maxPenaltyPoints;

  // Ijrochining umumiy intizomi — faqat boshqaruvchiga (ijrochi o'zinikini
  // o'z panelida ko'radi).
  if (canManage) {
    const now = new Date();
    const [groups, overdue] = await Promise.all([
      prisma.task.groupBy({
        by: ["status"],
        where: { assignee: assigneeId },
        _count: { _all: true },
      }),
      prisma.task.count({
        where: {
          assignee: assigneeId,
          status: { in: WORKING_STATUSES },
          dueDate: { lt: now },
        },
      }),
    ]);
    const count = (s) => groups.find((g) => g.status === s)?._count._all || 0;
    const total = groups.reduce((a, g) => a + g._count._all, 0);
    const completed = count("completed");
    const stopped = count("stopped");
    const base = total - stopped;
    task.assigneeStats = {
      total,
      completed,
      active: total - completed - stopped,
      overdue,
      completionRate: base > 0 ? Math.round((completed / base) * 100) : null,
    };
  }

  return task;
};

const _assertSubmission = (task, settings, { note, files }) => {
  const rules = _submissionRules(settings);
  const list = files || [];

  if (!rules.allowLateSubmission && task.dueDate < new Date()) {
    throw new BadRequestError(
      "Ijro muddati o'tgan — topshiriqni yakunlash uchun muddat uzaytirilishi kerak",
    );
  }

  if (list.length < rules.minFiles) {
    throw new BadRequestError(
      rules.minFiles === 1
        ? "Topshiriqni yakunlash uchun kamida bitta fayl yuklash kerak"
        : `Topshiriqni yakunlash uchun kamida ${rules.minFiles} ta fayl yuklash kerak`,
    );
  }
  if (list.length > rules.maxFiles) {
    throw new BadRequestError(`Ko'pi bilan ${rules.maxFiles} ta fayl yuklash mumkin`);
  }

  const badFile = list.find((f) => !rules.fileTypes.includes(_fileCategory(f.mimetype)));
  if (badFile) {
    const allowed = rules.fileTypes.map((t) => FILE_TYPE_LABELS[t] || t).join(", ");
    throw new BadRequestError(
      `"${badFile.originalname}" qabul qilinmaydi. Ruxsat etilgan turlar: ${allowed}`,
    );
  }

  const text = String(note ?? "").trim();
  if (rules.requireNote && text.length === 0) {
    throw new BadRequestError("Bajarilgan ish haqida izoh yozish majburiy");
  }
  // Ixtiyoriy izoh bo'sh qolishi mumkin, lekin yozilgan bo'lsa — chegara amal qiladi
  if (text.length > 0 && text.length < rules.minNoteLength) {
    throw new BadRequestError(
      `Izoh kamida ${rules.minNoteLength} ta belgidan iborat bo'lishi kerak`,
    );
  }
  if (text.length > 2000) {
    throw new BadRequestError("Izoh 2000 ta belgidan oshmasligi kerak");
  }

  return text;
};

const submitTaskCompletion = async (taskId, userId, { note, files }) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq topilmadi");

  if (String(task.assignee) !== String(userId)) {
    throw new ForbiddenError("Bu topshiriqni yangilashga ruxsat yo'q");
  }

  if (!WORKING_STATUSES.includes(task.status)) {
    throw new BadRequestError(
      "Bu holatdagi topshiriqni yakunlab bo'lmaydi",
    );
  }

  const settings = await getTaskSettings();
  const cleanNote = _assertSubmission(task, settings, { note, files });

  // Yangi fayllar AVVAL yuklanadi: yuklash yiqilsa eski natija joyida qoladi
  const newAttachments = await uploadAttachments(files);

  const position = await _nextStatusPosition(task.id);

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      completionNote: cleanNote,
      completionAttachments: newAttachments,
      status: "pending_review",
      statusHistory: {
        create: {
          status: "pending_review",
          reason: cleanNote || "Topshiriq bajarildi",
          changedBy: userId,
          changedAt: new Date(),
          position,
        },
      },
    },
  });

  // Eski yakunlash fayllari — yangi natija yozilgandan KEYIN o'chiriladi
  if (Array.isArray(task.completionAttachments) && task.completionAttachments.length > 0) {
    await deleteAttachments(task.completionAttachments);
  }

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

  const settings = await getTaskSettings();
  const text = String(reason ?? "").trim();
  if (settings.requireApproveReason && !text) {
    throw new BadRequestError("Tasdiqlash izohi majburiy");
  }

  const position = await _nextStatusPosition(task.id);

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      status: "completed",
      statusHistory: {
        create: {
          status: "completed",
          reason: text || "Topshiriq tasdiqlandi",
          changedBy: approvedBy,
          changedAt: new Date(),
          position,
        },
      },
    },
  });

  _notifyAssignees(TASK_PUSH_EVENTS.COMPLETED, updated, { reason: text });

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
  if (newDueDate && _parseDate(newDueDate, "Yangi ijro muddati") <= now) {
    throw new BadRequestError("Yangi ijro muddati kelajakda bo'lishi kerak");
  }

  const settings = await getTaskSettings();
  const data = {};

  // Muddati o'tgan va hali jarima qo'llanilmagan bo'lsa jarima yoziladi
  // (avtomatik jarima sozlamada o'chirilmagan bo'lsa)
  if (isOverdue && !task.autopenalized && settings.autoPenaltyEnabled) {
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

  const statusPosition = await _nextStatusPosition(task.id);
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

  _notifyAssignees(TASK_PUSH_EVENTS.REJECTED, updated, {
    reason,
    deadlineChanged: Boolean(newDueDate),
    penaltyPoints: data.penaltyRef ? task.penaltyPoints : 0,
  });

  return updated;
};

const stopTask = async (
  taskId,
  { reason, withPenalty, penaltyPoints, stoppedBy },
) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq topilmadi");

  if (!ACTIVE_STATUSES.includes(task.status)) {
    throw new BadRequestError("Bu topshiriqni to'xtatib bo'lmaydi");
  }

  const data = {};
  let appliedPoints = 0;

  if (withPenalty && !task.autopenalized) {
    const settings = await getTaskSettings();
    const points = _assertPenaltyPoints(penaltyPoints || task.penaltyPoints, settings);
    const penalty = await _applyPenalty(task, points, reason, stoppedBy);
    data.penaltyRef = penalty.id;
    data.autopenalized = true;
    appliedPoints = points;
  }

  const position = await _nextStatusPosition(task.id);

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

  _notifyAssignees(TASK_PUSH_EVENTS.STOPPED, updated, {
    reason,
    penaltyPoints: appliedPoints,
  });

  return updated;
};

const extendDeadline = async (
  taskId,
  { newDueDate, reason, withPenalty, penaltyPoints, extendedBy },
) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq topilmadi");

  if (TERMINAL_STATUSES.includes(task.status)) {
    throw new BadRequestError(
      "Yakunlangan yoki to'xtatilgan topshiriqning muddatini uzaytirish mumkin emas",
    );
  }

  const nextDue = _parseDate(newDueDate, "Yangi ijro muddati");
  if (nextDue <= task.dueDate) {
    throw new BadRequestError(
      "Yangi muddat eski muddatdan keyin bo'lishi kerak",
    );
  }

  const now = new Date();

  const data = {};
  let appliedPoints = 0;

  if (withPenalty) {
    const settings = await getTaskSettings();
    appliedPoints = _assertPenaltyPoints(penaltyPoints || task.penaltyPoints, settings);
    const penalty = await _applyPenalty(task, appliedPoints, reason, extendedBy);
    data.penaltyRef = penalty.id;
    data.autopenalized = true;
  }

  const deadlinePosition = await prisma.taskDeadlineHistory.count({
    where: { taskId: task.id },
  });
  data.deadlineHistory = {
    create: {
      oldDueDate: task.dueDate,
      newDueDate: nextDue,
      reason,
      changedBy: extendedBy,
      changedAt: now,
      withPenalty: !!withPenalty,
      penaltyPoints: appliedPoints,
      position: deadlinePosition,
    },
  };

  // Tekshiruvdagi ish tekshiruvda qoladi — ijrochi allaqachon topshirgan,
  // uni "ishlanmoqda" ga qaytarish natijani ko'rib chiqish navbatidan
  // jimgina chiqarib yuborardi.
  let nextStatus = task.status;
  if (["pending", "pending_rejected"].includes(task.status)) {
    nextStatus = "extended";
  }
  data.status = nextStatus;

  data.dueDate = nextDue;
  // Yangi muddat = yangi imkoniyat
  data.autopenalized = false;

  const statusPosition = await _nextStatusPosition(task.id);
  data.statusHistory = {
    create: {
      status: nextStatus,
      kind: "deadline",
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

/**
 * Topshiriqni tahrirlaydi: sarlavha, tavsif, jarima bali, ijrochi va fayllar.
 *
 * ⚠️ Yakunlangan topshiriq tahrirlanmaydi — tasdiqlangan natija nimaga
 * nisbatan qabul qilingani o'zgarib qolmasligi kerak (avval qayta ochiladi).
 * ⚠️ Ijrochi faqat ish hali topshirilmagan va jarima yozilmagan bo'lsa
 * almashtiriladi: aks holda jarima yoki natija boshqa odamga tegishli
 * bo'lib qolardi.
 *
 * Har bir tahrir tarixga `kind: "edit"` bilan, o'zgargan maydonlar
 * ro'yxati (`meta`) bilan yoziladi.
 */
const updateTask = async (
  taskId,
  { title, description, penaltyPoints, assigneeId, removeAttachmentKeys = [], files = [] },
  editorId,
) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq topilmadi");

  if (task.status === "completed") {
    throw new BadRequestError(
      "Yakunlangan topshiriqni tahrirlab bo'lmaydi — avval uni qayta oching",
    );
  }

  const settings = await getTaskSettings();
  const data = {};
  const changes = [];

  if (title !== undefined) {
    const next = _assertText(title, {
      label: "Sarlavha",
      min: Math.max(1, settings.minTitleLength),
      max: TITLE_MAX,
    });
    if (next !== task.title) {
      data.title = next;
      changes.push({ field: "title", label: "Sarlavha", from: task.title, to: next });
    }
  }

  if (description !== undefined) {
    const next = _assertText(description, {
      label: "Tavsif",
      min: settings.minDescriptionLength,
      max: DESCRIPTION_MAX,
    });
    if (next !== task.description) {
      data.description = next;
      changes.push({ field: "description", label: "Tavsif", from: null, to: null });
    }
  }

  if (penaltyPoints !== undefined && penaltyPoints !== null && penaltyPoints !== "") {
    const next = _assertPenaltyPoints(penaltyPoints, settings);
    if (next !== task.penaltyPoints) {
      data.penaltyPoints = next;
      changes.push({
        field: "penaltyPoints",
        label: "Jarima bali",
        from: String(task.penaltyPoints),
        to: String(next),
      });
    }
  }

  let reassignedTo = null;
  let removedCompletion = [];
  if (assigneeId && String(assigneeId) !== String(task.assignee)) {
    if (!WORKING_STATUSES.includes(task.status)) {
      throw new BadRequestError(
        "Ijrochini faqat ish topshirilmagan faol topshiriqda almashtirish mumkin",
      );
    }
    if (task.penaltyRef) {
      throw new BadRequestError(
        "Jarima yozilgan topshiriqda ijrochini almashtirib bo'lmaydi",
      );
    }
    const [nextUser] = await _assertAssignableUsers([assigneeId]);
    if (nextUser.role === "owner") {
      throw new BadRequestError("Ownerga topshiriq berib bo'lmaydi");
    }
    const prevMap = await _loadUserMap([task.assignee], { id: true, firstName: true, lastName: true });
    data.assignee = nextUser.id;
    // Oldingi ijrochining rad etilgan natijasi yangi ijrochiga o'tmaydi
    data.completionNote = null;
    data.completionAttachments = [];
    removedCompletion = Array.isArray(task.completionAttachments) ? task.completionAttachments : [];
    reassignedTo = nextUser;
    changes.push({
      field: "assignee",
      label: "Ijrochi",
      from: _fullName(prevMap.get(String(task.assignee))),
      to: _fullName(nextUser),
    });
  }

  // Fayllar: olib tashlanganlar + yangilari
  const current = Array.isArray(task.attachments) ? task.attachments : [];
  const removeSet = new Set((removeAttachmentKeys || []).map(String));
  const removed = current.filter((a) => removeSet.has(String(a.key)));
  const kept = current.filter((a) => !removeSet.has(String(a.key)));

  if (kept.length + (files?.length || 0) > TASK_ATTACHMENTS_MAX) {
    throw new BadRequestError(`Ko'pi bilan ${TASK_ATTACHMENTS_MAX} ta fayl biriktirish mumkin`);
  }
  if (
    settings.requireCreateAttachments &&
    (removed.length > 0 || files?.length > 0) &&
    kept.length + (files?.length || 0) === 0
  ) {
    throw new BadRequestError("Topshiriqda kamida bitta fayl qolishi kerak");
  }

  if (removed.length > 0 || files?.length > 0) {
    const added = await uploadAttachments(files);
    data.attachments = [...kept, ...added];
    changes.push({
      field: "attachments",
      label: "Fayllar",
      from: String(current.length),
      to: String(kept.length + added.length),
    });
  }

  if (changes.length === 0) {
    throw new BadRequestError("Hech narsa o'zgartirilmadi");
  }

  const position = await _nextStatusPosition(task.id);
  data.statusHistory = {
    create: {
      status: task.status,
      kind: "edit",
      reason: `Tahrirlandi: ${changes.map((c) => c.label.toLowerCase()).join(", ")}`,
      meta: changes,
      changedBy: editorId,
      changedAt: new Date(),
      position,
    },
  };

  const updated = await prisma.task.update({ where: { id: task.id }, data });

  if (removed.length > 0) await _deleteUnsharedAttachments(removed, task.id);
  if (removedCompletion.length > 0) await deleteAttachments(removedCompletion);

  if (reassignedTo) {
    _notifyAssignees(TASK_PUSH_EVENTS.CREATED, updated);
  }

  return updated;
};

/**
 * To'xtatilgan yoki yakunlangan topshiriqni yangi muddat bilan qayta ochadi.
 * Holat `pending` ga qaytadi, avtomatik jarima bayrog'i tushiriladi (yangi
 * muddat — yangi imkoniyat, `extendDeadline` bilan bir xil qoida).
 */
const reopenTask = async (taskId, { newDueDate, reason, reopenedBy }) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq topilmadi");

  if (!TERMINAL_STATUSES.includes(task.status)) {
    throw new BadRequestError(
      "Faqat yakunlangan yoki to'xtatilgan topshiriqni qayta ochish mumkin",
    );
  }

  const text = _assertText(reason, { label: "Sabab", min: 1, max: 1000 });
  const nextDue = _parseDate(newDueDate, "Yangi ijro muddati");
  const now = new Date();
  if (nextDue <= now) {
    throw new BadRequestError("Yangi ijro muddati kelajakda bo'lishi kerak");
  }

  const [statusPosition, deadlinePosition] = await Promise.all([
    _nextStatusPosition(task.id),
    prisma.taskDeadlineHistory.count({ where: { taskId: task.id } }),
  ]);

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      status: "pending",
      dueDate: nextDue,
      autopenalized: false,
      deadlineHistory: {
        create: {
          oldDueDate: task.dueDate,
          newDueDate: nextDue,
          reason: text,
          changedBy: reopenedBy,
          changedAt: now,
          withPenalty: false,
          position: deadlinePosition,
        },
      },
      statusHistory: {
        create: {
          status: "pending",
          reason: `Qayta ochildi: ${text}`,
          changedBy: reopenedBy,
          changedAt: now,
          position: statusPosition,
        },
      },
    },
  });

  _notifyAssignees(TASK_PUSH_EVENTS.REOPENED, updated, {
    reason: text,
    deadlineChanged: true,
  });

  return updated;
};

/**
 * Topshiriqni butunlay o'chiradi (xato yaratilganlar uchun).
 * ⚠️ Jarima yozilgan topshiriq o'chirilmaydi: jarima yozuvi manbasiz qolardi
 * — bunday topshiriq to'xtatiladi.
 */
const deleteTask = async (taskId) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq topilmadi");

  if (task.penaltyRef) {
    throw new BadRequestError(
      "Jarima yozilgan topshiriqni o'chirib bo'lmaydi — uni to'xtating",
    );
  }

  await prisma.task.delete({ where: { id: task.id } });

  // Topshiriq fayllari boshqa ijrochilarning nusxalari bilan umumiy bo'lishi mumkin;
  // yakunlash fayllari esa faqat shu ijrochiniki
  await _deleteUnsharedAttachments(task.attachments, task.id);
  await deleteAttachments(
    Array.isArray(task.completionAttachments) ? task.completionAttachments : [],
  );

  return { id: task.id };
};

// ─── SOZLAMALAR ────────────────────────────────────────────────────

const SETTINGS_INT_FIELDS = {
  minTitleLength: { min: 1, max: 100, label: "Sarlavhaning minimal uzunligi" },
  minDescriptionLength: { min: 0, max: 2000, label: "Tavsifning minimal uzunligi" },
  minLeadHours: { min: 0, max: 720, label: "Minimal muddat (soat)" },
  defaultPenaltyPoints: { min: 1, max: 100, label: "Standart jarima bali" },
  maxPenaltyPoints: { min: 1, max: 100, label: "Maksimal jarima bali" },
  minCompletionFiles: { min: 1, max: COMPLETION_FILES_HARD_MAX, label: "Minimal fayllar soni" },
  maxCompletionFiles: { min: 1, max: COMPLETION_FILES_HARD_MAX, label: "Maksimal fayllar soni" },
  minCompletionNoteLength: { min: 0, max: 2000, label: "Izohning minimal uzunligi" },
  dueSoonHours: { min: 1, max: 168, label: "\"Muddati yaqin\" oynasi (soat)" },
};

const SETTINGS_BOOL_FIELDS = [
  "requireCreateAttachments",
  "requireCompletionNote",
  "allowLateSubmission",
  "requireApproveReason",
  "autoPenaltyEnabled",
];

const COMPLETION_FILE_TYPES = ["image", "video", "document"];

const updateTaskSettings = async (body, userId) => {
  const current = await getTaskSettings();
  const data = {};

  for (const [field, rule] of Object.entries(SETTINGS_INT_FIELDS)) {
    if (body[field] === undefined) continue;
    const value = Number(body[field]);
    if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
      throw new BadRequestError(`${rule.label} ${rule.min} dan ${rule.max} gacha butun son bo'lishi kerak`);
    }
    data[field] = value;
  }

  for (const field of SETTINGS_BOOL_FIELDS) {
    if (body[field] === undefined) continue;
    data[field] = Boolean(body[field]);
  }

  if (body.completionFileTypes !== undefined) {
    const types = [...new Set(Array.isArray(body.completionFileTypes) ? body.completionFileTypes : [])];
    if (types.length === 0 || types.some((t) => !COMPLETION_FILE_TYPES.includes(t))) {
      throw new BadRequestError("Kamida bitta fayl turi tanlanishi kerak");
    }
    data.completionFileTypes = types;
  }

  const merged = { ...current, ...data };
  if (merged.maxCompletionFiles < merged.minCompletionFiles) {
    throw new BadRequestError("Maksimal fayllar soni minimaldan kam bo'lmasligi kerak");
  }
  if (merged.defaultPenaltyPoints > merged.maxPenaltyPoints) {
    throw new BadRequestError("Standart jarima bali maksimaldan oshmasligi kerak");
  }

  return prisma.taskSettings.update({
    where: { id: current.id },
    data: { ...data, updatedBy: userId },
  });
};

module.exports = {
  ACTIVE_STATUSES,
  WORKING_STATUSES,
  COMPLETION_FILES_HARD_MAX,
  TASK_ATTACHMENTS_MAX,
  createTasks,
  getTasks,
  getTaskStats,
  getMyTasks,
  getTaskById,
  submitTaskCompletion,
  approveTask,
  rejectTask,
  stopTask,
  extendDeadline,
  updateTask,
  reopenTask,
  deleteTask,
  updateTaskSettings,
};
