/**
 * AI YORDAMCHI — "Operatsiyalar" bo'limi amallari.
 *
 * Qamrov: topshiriqlar (yaratish, tasdiqlash, rad etish, muddatni uzaytirish,
 * to'xtatish), lidlar (yaratish, holat, harakat), Telegram tarqatma,
 * xavfsizlik (seanslarni yopish, ogohlantirish holati) va do'kon buyurtmasi
 * holati.
 *
 * Har bir `execute` HTTP yo'lining aynan nusxasi: controller chaqirgan
 * servisni controller bergan argumentlar bilan chaqiradi (izohda route va
 * controller ko'rsatilgan). `prepare` esa servis rad etadigan holatlarni
 * OLDINDAN tekshiradi va servis JIM bajaradigan oqibatlarni (jarima, coin
 * qaytarish, bildirishnomani o'chirgan ota-onaga ham yuborish) ochiq aytadi.
 *
 * ⚠️ ERKIN MATN 2000 BELGIDAN OSHMAYDI. `escapeHtml` matnni uzaytiradi
 * (`<` → `&lt;`), Telegram xabari esa 4096 belgi bilan cheklangan — 2000
 * belgili chegara kodlangandan keyin ham xabar bitta bo'lib yetib borishini
 * kafolatlaydi. (Amal `args`/`params` yo'qotishsiz saqlanadi —
 * `toStorableJson`.)
 *
 * ⚠️ TELEGRAMGA KETADIGAN MATN `escapeHtml` DAN O'TADI (`design.md` §3.2
 * qoida 8). HTTP yo'lida `xss-clean` `<` ni kodlaydi, to'g'ridan-to'g'ri
 * servis chaqiruvida esa bu qatlam yo'q — xom `<` Telegram'da "can't parse
 * entities" bilan uch marta yiqilib, xabar yetkazilmay qolardi.
 *
 * ⚠️ NIMA YO'Q (ataylab): topshiriq/lid o'chirish, inventar qoldig'i va
 * zarar puli, o'zgarishlar tarixini yuborish, fayl talab qiladigan amallar.
 */

const crypto = require("crypto");
const prisma = require("../../../config/prisma");
const platformPrisma = require("../../../config/platformPrisma");
const { config } = require("../../../config/env.config");
const taskService = require("../../task.service");
const leadService = require("../../lead.service");
const leadActivityService = require("../../leadActivity.service");
const messageService = require("../../message.service");
const securityDashboard = require("../../securityDashboard.service");
const marketService = require("../../market.service");
const { ROLES } = require("../../../utils/constants");
const { hasRole } = require("../../../utils/permissions");
const { mapBranches } = require("../../../helpers/branchIterator");
const { ForbiddenError } = require("../../../utils/errors");
const { escapeHtml } = require("../../../helpers/changelogMessage.helpers");
const { normalizePhone, formatPhoneUz } = require("../../../helpers/phone.helpers");
const { formatDateUz, formatDateTimeUz } = require("../../../helpers/date.helpers");
const {
  AiToolError,
  defineAction,
  idSchema,
  daySchema,
  requireId,
  dayArg,
  personName,
} = require("../assistant.toolkit");

// ─────────────────────────────────────────────────────────────────────────
// Yorliqlar (admin paneldagi matn bilan bir xil)
// ─────────────────────────────────────────────────────────────────────────

const TASK_STATUS_LABELS = {
  pending: "Kutilmoqda",
  extended: "Uzaytirilgan",
  pending_rejected: "Kutilmoqda (Rad etilgan)",
  pending_review: "Yakunlangan (Tasdiq kutilmoqda)",
  completed: "Muvaffaqiyatli yakunlangan",
  stopped: "To'xtatilgan",
};
/** `task.service.stopTask` qabul qiladigan holatlar. */
const TASK_STOPPABLE = ["pending", "extended", "pending_rejected", "pending_review"];
/** `task.service.extendDeadline` rad etadigan holatlar. */
const TASK_TERMINAL = ["completed", "stopped"];

const LEAD_STATUS_LABELS = {
  new: "Yangi",
  contacted: "Bog'lanildi",
  interested: "Qiziqmoqda",
  visited: "Tashrif buyurdi",
  trial: "Sinov darsi",
  negotiation: "Muzokara",
  enrolled: "Ro'yxatdan o'tdi",
  rejected: "Rad etdi",
  lost: "Yo'qoldi",
  postponed: "Keyinga qoldirildi",
};
/** Sabab so'raladigan holatlar — `lead.service` `lostReason` ni faqat shularda saqlaydi. */
const LEAD_EXIT_STATUSES = ["rejected", "lost"];

/**
 * Qo'lda yoziladigan harakat turlari. `status_change` ATAYLAB yo'q: u holat
 * o'zgarganda servis tomonidan yoziladi, qo'lda yozilsa lid holati
 * o'zgarmagan holda tarixda "o'zgardi" deb turardi.
 */
const LEAD_ACTIVITY_LABELS = {
  call: "Qo'ng'iroq",
  meeting: "Uchrashuv",
  note: "Izoh",
  visit: "Tashrif",
};

const RECIPIENT_TYPE_LABELS = {
  all: "Barcha o'qituvchilar va o'quvchilar ota-onalari",
  class: "Sinf o'quvchilari ota-onalari",
  student: "Bitta o'quvchining ota-onalari",
};

const ALERT_STATUS_LABELS = { open: "Ochiq", acknowledged: "Ko'rib chiqilgan", resolved: "Hal qilingan" };
const SEVERITY_LABELS = { low: "Past", medium: "O'rta", high: "Yuqori", critical: "Jiddiy" };

const MARKET_STATUS_LABELS = {
  pending: "Kutilmoqda",
  delivering: "Yetkazilmoqda",
  approved: "Yetkazib berildi",
  rejected: "Rad etilgan",
  cancelled: "Bekor qilingan",
};

const ROLE_WORDS = {
  owner: "tizim egasi",
  teacher: "o'qituvchi",
  student: "o'quvchi",
  reception: "qabulxona",
};

/** Amal kartasida ro'yxat shu chegaradan uzun bo'lsa qisqartiriladi. */
const PREVIEW_LIST_LIMIT = 15;

/** Topshiriq muddati vaqti aytilmasa — ish kuni oxiri (panel namunalari ham 18:00). */
const DEFAULT_DUE_TIME = "18:00";

const TIME_PATTERN = "^([01]\\d|2[0-3]):[0-5]\\d$";

/** `toJsonSafe` satr chegarasi (fayl boshidagi izohga qarang). */
const MAX_FREE_TEXT = 2000;

// ─────────────────────────────────────────────────────────────────────────
// Umumiy yordamchilar
// ─────────────────────────────────────────────────────────────────────────

const timeSchema = (description) => ({ type: "string", pattern: TIME_PATTERN, description });

const textSchema = (description, maxLength, minLength = 1) => ({
  type: "string",
  minLength,
  maxLength,
  description,
});

function clip(text, max) {
  if (text === null || text === undefined) return null;
  const value = String(text).trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function joinNames(names, limit = PREVIEW_LIST_LIMIT) {
  if (names.length === 0) return "—";
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")} va yana ${names.length - limit} ta`;
}

const roleWord = (role) => ROLE_WORDS[role] ?? "xodim";

/**
 * Toshkent devor-soatidagi kun + vaqt → aniq lahza.
 *
 * ⚠️ Offset ANIQ yoziladi. Paneldagi `datetime-local` qiymati ("2026-09-20T18:00")
 * serverda `new Date()` bilan HOST vaqt mintaqasida o'qiladi; UTC dagi
 * serverda muddat 5 soat siljirdi. Bu yerda bunday noaniqlik yo'q.
 *
 * @returns {Date}
 */
function tashkentInstant(day, time, label) {
  const iso = dayArg(day, label);
  return new Date(`${iso}T${time || DEFAULT_DUE_TIME}:00+05:00`);
}

/**
 * Servisning oddiy `Error` xabarini (statusCode yo'q) egaga ko'rinadigan
 * xatoga aylantiradi. `market.service` barcha tekshiruvlarni `new Error`
 * bilan otadi — aks holda ular "kutilmagan xato" bo'lib yashirinardi.
 * Prisma va boshqa kutilmagan xatolar o'zgarishsiz qoladi.
 */
function rethrowServiceError(error) {
  if (error && error.constructor === Error && !error.statusCode) {
    throw new AiToolError(error.message);
  }
  throw error;
}

/** Qatorlar ro'yxatining barqaror izi (fingerprint ichida uzun massiv kesilmasligi uchun). */
const hashOf = (values) => crypto.createHash("sha256").update([...values].sort().join("|")).digest("hex");

// ─────────────────────────────────────────────────────────────────────────
// TOPSHIRIQLAR
// ─────────────────────────────────────────────────────────────────────────

/** Topshiriqni owner ko'zi bilan yuklaydi (`GET /tasks/:id` bilan bir xil servis). */
async function loadTask(taskId, ctx) {
  return taskService.getTaskById(requireId(taskId, "taskId"), ctx.user);
}

const taskTarget = (task) =>
  task.assignee
    ? `"${clip(task.title, 120)}" — ${personName(task.assignee)} (${roleWord(task.assignee.role)})`
    : `"${clip(task.title, 120)}" — ijrochi topilmadi`;

/** Topshiriq holatining izi: shu qiymatlar o'zgarsa, ko'rinish eskirgan. */
const taskState = (task) => ({
  id: task.id,
  status: task.status,
  dueDate: task.dueDate,
  autopenalized: task.autopenalized,
  penaltyPoints: task.penaltyPoints,
  assigneeId: task.assignee?.id ?? null,
});

/**
 * Topshiriq jarimasi `task.service._applyPenalty` orqali yoziladi va u
 * jarimalar bo'limining odatiy yo'lidan farq qiladi — ega buni bilishi kerak.
 */
function taskPenaltyWarnings(task, points) {
  const warnings = [
    `Ijrochiga (${personName(task.assignee)}) ${points} ball jarima darhol tasdiqlangan holda yoziladi. Topshiriq jarimasida jarima sozlamalaridagi pul miqdori qo'llanmaydi va xodimga Telegram xabari yuborilmaydi`,
  ];
  if (task.assignee?.role === ROLES.OWNER) {
    warnings.push("Topshiriq tizim egasiga biriktirilgan — jarima egaga yoziladi");
  }
  return warnings;
}

const createTask = defineAction({
  type: "tasks.create",
  toolName: "propose_create_task",
  toolset: "operations",
  title: "Topshiriq yaratish",
  risk: "low",
  permission: "tasks.create",
  description:
    "Propose creating a task (topshiriq) for one or more staff members; one separate task is created per assignee. Resolve assignees with search_people first (never the owner). dueDate is a Tashkent day YYYY-MM-DD and dueTime HH:mm (default 18:00); the deadline must be in the future. penaltyPoints (default 1) is what the hourly job fines each assignee if the deadline passes unsubmitted. Assignees are NOT notified by Telegram; attachments are not supported.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["title", "description", "assigneeIds", "dueDate"],
    properties: {
      title: textSchema("Short task title as the assignee will see it.", 300),
      description: textSchema("What exactly must be done.", 1000),
      assigneeIds: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: idSchema("User id of an assignee."),
        description: "User ids of assignees (staff). Duplicates are removed.",
      },
      dueDate: daySchema("Deadline day in Tashkent, YYYY-MM-DD."),
      dueTime: timeSchema("Deadline time HH:mm in Tashkent. Default 18:00."),
      penaltyPoints: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 1,
        description: "Penalty points applied automatically if the deadline passes. Default 1.",
      },
    },
  },
  async prepare(args, ctx) {
    const assigneeIds = [...new Set(args.assigneeIds.map((id) => requireId(id, "assigneeIds")))].sort();
    const due = tashkentInstant(args.dueDate, args.dueTime, "Ijro muddati");
    if (due <= ctx.now) {
      throw new AiToolError(`Ijro muddati kelajakda bo'lishi kerak (${formatDateTimeUz(due)} o'tib ketgan)`);
    }

    const users = await prisma.user.findMany({
      where: { id: { in: assigneeIds } },
      select: { id: true, firstName: true, lastName: true, role: true, isActive: true, isArchived: true },
      // `id` — teng ismlilar tartibi barqaror bo'lsin (ro'yxat izga kiradi)
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { id: "asc" }],
    });
    if (users.length !== assigneeIds.length) {
      const missing = assigneeIds.length - users.length;
      throw new AiToolError(`${missing} ta ijrochi joriy filialda topilmadi — odamlarni search_people bilan qayta aniqlang`);
    }
    if (users.some((user) => user.role === ROLES.OWNER)) {
      throw new AiToolError("Topshiriq tizim egasiga biriktirilmaydi (panelda ham ega ijrochilar ro'yxatida yo'q)");
    }

    const penaltyPoints = args.penaltyPoints ?? 1;
    const names = users.map((user) => personName(user));
    const archived = users.filter((user) => user.isArchived).map((user) => personName(user));
    const inactive = users.filter((user) => !user.isArchived && !user.isActive).map((user) => personName(user));
    const students = users.filter((user) => user.role === ROLES.STUDENT).map((user) => personName(user));

    const warnings = [];
    if (archived.length) warnings.push(`Arxivlangan foydalanuvchilar: ${joinNames(archived)} — ular panelga kira olmaydi, muddat o'tsa baribir jarima yoziladi`);
    if (inactive.length) warnings.push(`Logini o'chirilgan foydalanuvchilar: ${joinNames(inactive)}`);
    if (students.length) warnings.push(`Ijrochilar orasida o'quvchilar bor: ${joinNames(students)}`);
    if (args.assigneeIds.length !== assigneeIds.length) warnings.push("Takrorlangan ijrochilar bir marta hisoblandi");

    const dueDate = due.toISOString();
    return {
      params: { title: args.title, description: args.description, dueDate, penaltyPoints, assigneeIds },
      preview: {
        summary: `"${clip(args.title, 120)}" topshirig'i ${users.length} ta ijrochiga ${formatDateTimeUz(due)} muddat bilan beriladi`,
        target: users.length === 1 ? `${names[0]} (${roleWord(users[0].role)})` : `${users.length} ta ijrochi`,
        fields: [
          { label: "Sarlavha", before: "—", after: args.title },
          { label: "Tavsif", before: "—", after: clip(args.description, 400) },
          { label: "Ijrochilar", before: "—", after: joinNames(names) },
          { label: "Ijro muddati", before: "—", after: formatDateTimeUz(due) },
          { label: "Jarima bali", before: "—", after: `${penaltyPoints} ball` },
        ],
        effects: [
          users.length > 1
            ? `Har bir ijrochiga alohida topshiriq yaratiladi (${users.length} ta)`
            : "Ijrochiga bitta topshiriq yaratiladi",
          "Ijrochilarga Telegram xabari yuborilmaydi — topshiriq ularning panelida ko'rinadi",
          `Muddat o'tguncha topshirilmasa, soatlik tekshiruv har bir ijrochiga ${penaltyPoints} ball jarima yozadi`,
        ],
        warnings,
      },
      fingerprint: {
        title: args.title,
        description: args.description,
        dueDate,
        penaltyPoints,
        assignees: users.map((user) => [user.id, user.role, user.isActive, user.isArchived]),
      },
    };
  },
  // Mirrors POST /api/tasks — task.routes.js (tasks.create) → task.controller.createTask:
  // title/description/dueDate required, `penaltyPoints ? Number(penaltyPoints) : 1`,
  // `createdBy: req.user.id`, `files: req.files || []` (AI: no files).
  async execute(params, ctx) {
    const tasks = await taskService.createTasks({
      title: params.title,
      description: params.description,
      dueDate: params.dueDate,
      penaltyPoints: params.penaltyPoints ? Number(params.penaltyPoints) : 1,
      assigneeIds: params.assigneeIds,
      createdBy: ctx.user.id,
      files: [],
    });
    return {
      summary: `${tasks.length} ta topshiriq yaratildi`,
      details: [
        { label: "Sarlavha", value: params.title },
        { label: "Ijro muddati", value: formatDateTimeUz(new Date(params.dueDate)) },
      ],
      data: { taskIds: tasks.map((task) => task.id) },
    };
  },
});

const approveTask = defineAction({
  type: "tasks.approve",
  toolName: "propose_approve_task",
  toolset: "operations",
  title: "Topshiriqni tasdiqlash",
  risk: "low",
  permission: "tasks.review",
  description:
    "Propose approving a task that the assignee has submitted (status pending_review) — it becomes completed and can no longer be rejected, extended or stopped. Call ops_task first to read the completion note. reason is the owner's review comment and is required.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "reason"],
    properties: {
      taskId: idSchema("Task id."),
      reason: textSchema("Owner's approval comment (required by the platform).", 1000),
    },
  },
  async prepare(args, ctx) {
    const task = await loadTask(args.taskId, ctx);
    if (task.status !== "pending_review") {
      throw new AiToolError(
        `Faqat ijrochi topshirgan (tasdiq kutilayotgan) topshiriq tasdiqlanadi — hozirgi holati: "${TASK_STATUS_LABELS[task.status] ?? task.status}"`,
      );
    }

    const warnings = [];
    if (task.dueDate < ctx.now) {
      warnings.push(
        task.autopenalized
          ? `Topshiriq muddatidan (${formatDateTimeUz(task.dueDate)}) kech topshirilgan va bu topshiriq uchun jarima allaqachon yozilgan — tasdiqlash jarimani bekor qilmaydi`
          : `Topshiriq muddati (${formatDateTimeUz(task.dueDate)}) o'tgan — tasdiqlansa jarima yozilmaydi`,
      );
    }

    return {
      params: { taskId: task.id, reason: args.reason },
      preview: {
        summary: `"${clip(task.title, 120)}" topshirig'i bajarilgan deb tasdiqlanadi`,
        target: taskTarget(task),
        fields: [
          { label: "Holat", before: TASK_STATUS_LABELS[task.status], after: TASK_STATUS_LABELS.completed },
          { label: "Tasdiq izohi", before: "—", after: args.reason },
        ],
        effects: [
          task.completionNote
            ? `Ijrochi izohi: "${clip(task.completionNote, 400)}"`
            : "Ijrochi topshirishda izoh qoldirmagan",
          "Topshiriq yakunlanadi — keyin uni rad etib, muddatini uzaytirib yoki to'xtatib bo'lmaydi",
        ],
        warnings,
      },
      fingerprint: { ...taskState(task), completionNote: task.completionNote ?? null, reason: args.reason },
    };
  },
  // Mirrors PUT /api/tasks/:id/approve — task.routes.js (validateObjectId, tasks.review) →
  // task.controller.approveTask: `reason` required, `approveTask(id, { reason, approvedBy: req.user.id })`.
  async execute(params, ctx) {
    const task = await taskService.approveTask(params.taskId, { reason: params.reason, approvedBy: ctx.user.id });
    return {
      summary: `"${clip(task.title, 120)}" topshirig'i tasdiqlandi`,
      data: { taskId: task.id, status: task.status },
    };
  },
});

const rejectTask = defineAction({
  type: "tasks.reject",
  toolName: "propose_reject_task",
  toolset: "operations",
  title: "Topshiriqni rad etish",
  risk: "medium",
  permission: "tasks.review",
  description:
    "Propose sending a submitted task (status pending_review) back to the assignee for rework. reason is required. If the deadline has already passed, a new deadline (newDueDate YYYY-MM-DD + newDueTime HH:mm, future) is REQUIRED, and the assignee is fined the task's penalty points unless already auto-fined — the preview states whether a penalty applies. Call ops_task first.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "reason"],
    properties: {
      taskId: idSchema("Task id."),
      reason: textSchema("Why the work is rejected; shown to the assignee.", 1000),
      newDueDate: daySchema("New deadline day YYYY-MM-DD (Tashkent). Required when the current deadline has passed."),
      newDueTime: timeSchema("New deadline time HH:mm (Tashkent). Default 18:00."),
    },
  },
  async prepare(args, ctx) {
    const task = await loadTask(args.taskId, ctx);
    if (task.status !== "pending_review") {
      throw new AiToolError(
        `Faqat ijrochi topshirgan (tasdiq kutilayotgan) topshiriq rad etiladi — hozirgi holati: "${TASK_STATUS_LABELS[task.status] ?? task.status}"`,
      );
    }

    const overdue = task.dueDate < ctx.now;
    if (overdue && !args.newDueDate) {
      throw new AiToolError(
        `Topshiriq muddati (${formatDateTimeUz(task.dueDate)}) o'tgan — rad etish uchun yangi ijro muddati (sana va vaqt) majburiy. Egadan so'rang`,
      );
    }

    let newDue = null;
    if (args.newDueDate) {
      newDue = tashkentInstant(args.newDueDate, args.newDueTime, "Yangi ijro muddati");
      if (newDue <= ctx.now) {
        throw new AiToolError(`Yangi ijro muddati kelajakda bo'lishi kerak (${formatDateTimeUz(newDue)} o'tib ketgan)`);
      }
    }

    // `rejectTask`: muddati o'tgan va hali jarima yozilmagan bo'lsa — jarima
    const willPenalize = overdue && !task.autopenalized;

    const fields = [
      { label: "Holat", before: TASK_STATUS_LABELS[task.status], after: TASK_STATUS_LABELS.pending_rejected },
      { label: "Rad etish sababi", before: "—", after: args.reason },
    ];
    if (newDue) {
      fields.push({ label: "Ijro muddati", before: formatDateTimeUz(task.dueDate), after: formatDateTimeUz(newDue) });
    }
    if (willPenalize) {
      fields.push({ label: "Jarima", before: "—", after: `${task.penaltyPoints} ball` });
    }

    const effects = ["Topshiriq ijrochiga qayta ishlash uchun qaytariladi"];
    if (newDue) {
      effects.push("Yangi muddat o'tguncha qayta topshirilmasa, soatlik tekshiruv yana avtomatik jarima yozadi");
    }

    return {
      params: {
        taskId: task.id,
        reason: args.reason,
        newDueDate: newDue ? newDue.toISOString() : null,
        expectedPenaltyPoints: willPenalize ? task.penaltyPoints : null,
      },
      preview: {
        summary: willPenalize
          ? `"${clip(task.title, 120)}" rad etiladi va ijrochiga ${task.penaltyPoints} ball jarima yoziladi`
          : `"${clip(task.title, 120)}" rad etilib, ijrochiga qaytariladi`,
        target: taskTarget(task),
        fields,
        effects,
        warnings: willPenalize ? taskPenaltyWarnings(task, task.penaltyPoints) : [],
      },
      fingerprint: {
        ...taskState(task),
        overdue,
        willPenalize,
        reason: args.reason,
        newDueDate: newDue ? newDue.toISOString() : null,
      },
    };
  },
  // Mirrors PUT /api/tasks/:id/reject — task.routes.js (validateObjectId, tasks.review) →
  // task.controller.rejectTask: `reason` required,
  // `rejectTask(id, { reason, rejectedBy: req.user.id, newDueDate })` (newDueDate undefined when absent).
  async execute(params, ctx) {
    const task = await taskService.rejectTask(params.taskId, {
      reason: params.reason,
      rejectedBy: ctx.user.id,
      newDueDate: params.newDueDate ?? undefined,
    });
    const details = [{ label: "Ijro muddati", value: formatDateTimeUz(task.dueDate) }];
    if (params.expectedPenaltyPoints) details.push({ label: "Jarima", value: `${params.expectedPenaltyPoints} ball` });
    return {
      summary: `"${clip(task.title, 120)}" rad etildi va ijrochiga qaytarildi`,
      details,
      data: { taskId: task.id, status: task.status },
    };
  },
});

const extendTaskDeadline = defineAction({
  type: "tasks.extend",
  toolName: "propose_extend_task_deadline",
  toolset: "operations",
  title: "Topshiriq muddatini uzaytirish",
  risk: "medium",
  permission: "tasks.extend",
  description:
    "Propose moving a task deadline LATER (it cannot be shortened) for a task that is not completed or stopped. newDueDate YYYY-MM-DD + newDueTime HH:mm (Tashkent, default 18:00) must be after both the current deadline and now. reason is required. withPenalty=true fines the assignee now (penaltyPoints, default the task's own points) even if the hourly job already fined them. A submitted task (pending_review) goes back to 'extended' and must be resubmitted.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "newDueDate", "reason"],
    properties: {
      taskId: idSchema("Task id."),
      newDueDate: daySchema("New deadline day YYYY-MM-DD (Tashkent)."),
      newDueTime: timeSchema("New deadline time HH:mm (Tashkent). Default 18:00."),
      reason: textSchema("Why the deadline is extended.", 1000),
      withPenalty: {
        type: "boolean",
        default: false,
        description: "Fine the assignee for the delay now. Only when the owner explicitly asks.",
      },
      penaltyPoints: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Penalty points when withPenalty is true. Default: the task's own penalty points.",
      },
    },
  },
  async prepare(args, ctx) {
    const task = await loadTask(args.taskId, ctx);
    if (TASK_TERMINAL.includes(task.status)) {
      throw new AiToolError(
        `"${TASK_STATUS_LABELS[task.status]}" holatidagi topshiriqning muddatini uzaytirib bo'lmaydi`,
      );
    }

    const newDue = tashkentInstant(args.newDueDate, args.newDueTime, "Yangi ijro muddati");
    if (newDue <= task.dueDate) {
      throw new AiToolError(
        `Yangi muddat hozirgi muddatdan (${formatDateTimeUz(task.dueDate)}) keyin bo'lishi kerak — muddatni qisqartirib bo'lmaydi`,
      );
    }
    if (newDue <= ctx.now) {
      throw new AiToolError(`Yangi ijro muddati kelajakda bo'lishi kerak (${formatDateTimeUz(newDue)} o'tib ketgan)`);
    }

    const withPenalty = Boolean(args.withPenalty);
    const points = withPenalty ? args.penaltyPoints ?? task.penaltyPoints : null;
    const nextStatus = ["pending", "pending_rejected", "pending_review"].includes(task.status) ? "extended" : task.status;

    const fields = [
      { label: "Ijro muddati", before: formatDateTimeUz(task.dueDate), after: formatDateTimeUz(newDue) },
      { label: "Holat", before: TASK_STATUS_LABELS[task.status], after: TASK_STATUS_LABELS[nextStatus] },
      { label: "Sabab", before: "—", after: args.reason },
    ];
    if (withPenalty) fields.push({ label: "Jarima", before: "—", after: `${points} ball` });

    const warnings = withPenalty ? taskPenaltyWarnings(task, points) : [];
    if (withPenalty && task.autopenalized) {
      warnings.push("Bu topshiriq uchun jarima allaqachon yozilgan (muddat o'tgani yoki avvalgi qaror bilan) — yangi jarima unga QO'SHIMCHA bo'ladi");
    }
    if (task.status === "pending_review") {
      warnings.push("Ijrochi topshiriqni allaqachon topshirgan — uzaytirilgach u tasdiq kutmaydi va ijrochi uni qayta topshirishi kerak");
    }

    return {
      params: {
        taskId: task.id,
        newDueDate: newDue.toISOString(),
        reason: args.reason,
        withPenalty,
        penaltyPoints: withPenalty ? args.penaltyPoints ?? null : null,
      },
      preview: {
        summary: `"${clip(task.title, 120)}" muddati ${formatDateTimeUz(newDue)} gacha uzaytiriladi${withPenalty ? `, ${points} ball jarima bilan` : ""}`,
        target: taskTarget(task),
        fields,
        effects: [
          "Avtomatik jarima belgisi tozalanadi: yangi muddat o'tguncha topshirilmasa, soatlik tekshiruv yana jarima yozadi",
        ],
        warnings,
      },
      fingerprint: {
        ...taskState(task),
        newDueDate: newDue.toISOString(),
        reason: args.reason,
        withPenalty,
        points,
      },
    };
  },
  // Mirrors PUT /api/tasks/:id/extend — task.routes.js (validateObjectId, tasks.extend) →
  // task.controller.extendDeadline: newDueDate/reason required, `withPenalty: !!withPenalty`,
  // `penaltyPoints: penaltyPoints ? Number(penaltyPoints) : undefined`, `extendedBy: req.user.id`.
  async execute(params, ctx) {
    const task = await taskService.extendDeadline(params.taskId, {
      newDueDate: params.newDueDate,
      reason: params.reason,
      withPenalty: !!params.withPenalty,
      penaltyPoints: params.penaltyPoints ? Number(params.penaltyPoints) : undefined,
      extendedBy: ctx.user.id,
    });
    return {
      summary: `"${clip(task.title, 120)}" muddati ${formatDateTimeUz(task.dueDate)} gacha uzaytirildi`,
      details: params.withPenalty
        ? [{ label: "Jarima", value: `${params.penaltyPoints ?? task.penaltyPoints} ball` }]
        : [],
      data: { taskId: task.id, status: task.status },
    };
  },
});

const stopTask = defineAction({
  type: "tasks.stop",
  toolName: "propose_stop_task",
  toolset: "operations",
  title: "Topshiriqni to'xtatish",
  risk: "medium",
  permission: "tasks.stop",
  description:
    "Propose stopping a task permanently (final status 'stopped'; it cannot be reopened). Allowed for pending, extended, pending_rejected and pending_review tasks. reason is required. withPenalty=true fines the assignee (penaltyPoints, default the task's own points) — but NOT if the hourly job already auto-fined this task; the preview says which applies.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "reason"],
    properties: {
      taskId: idSchema("Task id."),
      reason: textSchema("Why the task is stopped.", 1000),
      withPenalty: {
        type: "boolean",
        default: false,
        description: "Fine the assignee when stopping. Only when the owner explicitly asks.",
      },
      penaltyPoints: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Penalty points when withPenalty is true. Default: the task's own penalty points.",
      },
    },
  },
  async prepare(args, ctx) {
    const task = await loadTask(args.taskId, ctx);
    if (!TASK_STOPPABLE.includes(task.status)) {
      throw new AiToolError(`"${TASK_STATUS_LABELS[task.status] ?? task.status}" holatidagi topshiriqni to'xtatib bo'lmaydi`);
    }

    const withPenalty = Boolean(args.withPenalty);
    // `stopTask`: jarima faqat `withPenalty && !autopenalized` bo'lsa yoziladi
    const penaltyApplies = withPenalty && !task.autopenalized;
    const points = penaltyApplies ? args.penaltyPoints ?? task.penaltyPoints : null;

    const fields = [
      { label: "Holat", before: TASK_STATUS_LABELS[task.status], after: TASK_STATUS_LABELS.stopped },
      { label: "Sabab", before: "—", after: args.reason },
    ];
    if (penaltyApplies) fields.push({ label: "Jarima", before: "—", after: `${points} ball` });

    const warnings = penaltyApplies ? taskPenaltyWarnings(task, points) : [];
    if (withPenalty && !penaltyApplies) {
      warnings.push("Jarima yozilmaydi: bu topshiriq uchun jarima avval yozilgan (muddat o'tgani yoki avvalgi qaror bilan)");
    }

    return {
      params: {
        taskId: task.id,
        reason: args.reason,
        withPenalty,
        penaltyPoints: withPenalty ? args.penaltyPoints ?? null : null,
        expectedPenaltyPoints: points,
      },
      preview: {
        summary: `"${clip(task.title, 120)}" topshirig'i to'xtatiladi${penaltyApplies ? `, ${points} ball jarima bilan` : ""}`,
        target: taskTarget(task),
        fields,
        effects: ["Topshiriq yakuniy \"To'xtatilgan\" holatiga o'tadi — uni qayta ochib bo'lmaydi"],
        warnings,
      },
      fingerprint: { ...taskState(task), reason: args.reason, withPenalty, penaltyApplies, points },
    };
  },
  // Mirrors PUT /api/tasks/:id/stop — task.routes.js (validateObjectId, tasks.stop) →
  // task.controller.stopTask: `reason` required, `withPenalty: !!withPenalty`,
  // `penaltyPoints: penaltyPoints ? Number(penaltyPoints) : undefined`, `stoppedBy: req.user.id`.
  async execute(params, ctx) {
    const task = await taskService.stopTask(params.taskId, {
      reason: params.reason,
      withPenalty: !!params.withPenalty,
      penaltyPoints: params.penaltyPoints ? Number(params.penaltyPoints) : undefined,
      stoppedBy: ctx.user.id,
    });
    return {
      summary: `"${clip(task.title, 120)}" topshirig'i to'xtatildi`,
      details: params.expectedPenaltyPoints ? [{ label: "Jarima", value: `${params.expectedPenaltyPoints} ball` }] : [],
      data: { taskId: task.id, status: task.status },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// LIDLAR
// ─────────────────────────────────────────────────────────────────────────

/** Lidni yuklaydi yoki egaga tushunarli xato beradi. */
async function loadLead(leadId) {
  const lead = await prisma.lead.findUnique({ where: { id: requireId(leadId, "leadId") } });
  if (!lead) throw new AiToolError("Lid topilmadi — ro'yxatdan (ops_leads) qayta tanlang");
  return lead;
}

const leadName = (lead) => `${lead.firstName} ${lead.lastName}`.trim();

/** Telefonni saqlash shakliga keltiradi (`+998901234567`). */
function phoneArg(value, label) {
  if (value === undefined) return undefined;
  try {
    return normalizePhone(value) ?? undefined;
  } catch (err) {
    throw new AiToolError(`${label}: ${err.message}`);
  }
}

/** Lid katalog yozuvi (manba/yo'nalish/toifa) — mavjud bo'lishi shart. */
async function loadTaxonomy(model, id, label) {
  const row = await prisma[model].findUnique({
    where: { id: requireId(id, label) },
    select: { id: true, name: true, isActive: true },
  });
  if (!row) throw new AiToolError(`${label} topilmadi — ops_leads_analytics javobidagi options ro'yxatidan tanlang`);
  return row;
}

const createLead = defineAction({
  type: "leads.create",
  toolName: "propose_create_lead",
  toolset: "operations",
  title: "Yangi lid qo'shish",
  risk: "low",
  permission: "leads.create",
  description:
    "Propose adding a CRM lead (potential student). Required: firstName, lastName, phone (Uzbek number, 9 or 12 digits), sourceId, directionId, categoryId — take ids from ops_leads_analytics options. Optional parent, class interest, address, notes and expected enrollment day. The lead starts in status 'new'; existing leads with the same phone are flagged.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["firstName", "lastName", "phone", "sourceId", "directionId", "categoryId"],
    properties: {
      firstName: textSchema("Lead (child) first name.", 60),
      lastName: textSchema("Lead (child) last name.", 60),
      phone: textSchema("Main contact phone, e.g. +998 90 123 45 67.", 32),
      additionalPhone: textSchema("Second phone.", 32),
      sourceId: idSchema("Lead source id (where the lead came from)."),
      directionId: idSchema("Lead direction id (program of interest)."),
      categoryId: idSchema("Lead category id."),
      classInterest: textSchema("Class or grade the family is interested in, e.g. '5-sinf'.", 60),
      parentName: textSchema("Parent full name.", 120),
      parentPhone: textSchema("Parent phone.", 32),
      address: textSchema("Address.", 300),
      notes: textSchema("Free notes.", 1000),
      expectedEnrollDate: daySchema("Expected enrollment day YYYY-MM-DD."),
    },
  },
  async prepare(args, ctx) {
    const phone = phoneArg(args.phone, "Telefon");
    const additionalPhone = phoneArg(args.additionalPhone, "Qo'shimcha telefon");
    const parentPhone = phoneArg(args.parentPhone, "Ota-ona telefoni");
    const expectedEnrollDate = args.expectedEnrollDate ? dayArg(args.expectedEnrollDate, "Kutilayotgan qabul sanasi") : undefined;

    const [source, direction, category] = await Promise.all([
      loadTaxonomy("leadSource", args.sourceId, "Lid manbasi"),
      loadTaxonomy("leadDirection", args.directionId, "Lid yo'nalishi"),
      loadTaxonomy("leadCategory", args.categoryId, "Lid toifasi"),
    ]);

    // Telefonlar bazada kiritilganidek (bo'shliq, +, qavslar bilan) turadi —
    // takrorni faqat raqamlar bo'yicha solishtirish ishonchli.
    const phoneDigits = phone.slice(-9);
    const duplicates = await prisma.$queryRaw`
      SELECT first_name AS "firstName", last_name AS "lastName", status::text AS status
      FROM leads
      WHERE regexp_replace(phone, '\\D', '', 'g') LIKE ${`%${phoneDigits}`}
      ORDER BY created_at DESC
      LIMIT 5`;

    const warnings = [];
    if (duplicates.length) {
      warnings.push(
        `Shu telefon raqami bilan lid allaqachon bor: ${duplicates
          .map((row) => `${row.firstName} ${row.lastName} (${LEAD_STATUS_LABELS[row.status] ?? row.status})`)
          .join(", ")}`,
      );
    }
    for (const row of [source, direction, category]) {
      if (!row.isActive) warnings.push(`"${row.name}" nofaol — panelda yangi lid uchun tanlanmaydi`);
    }
    if (expectedEnrollDate && expectedEnrollDate < ctx.today) {
      warnings.push("Kutilayotgan qabul sanasi o'tib ketgan");
    }

    const optional = {
      additionalPhone,
      classInterest: args.classInterest,
      parentName: args.parentName,
      parentPhone,
      address: args.address,
      notes: args.notes,
      expectedEnrollDate,
    };
    const data = {
      firstName: args.firstName,
      lastName: args.lastName,
      phone,
      source: source.id,
      direction: direction.id,
      category: category.id,
    };
    for (const [key, value] of Object.entries(optional)) {
      if (value !== undefined) data[key] = value;
    }

    const fields = [
      { label: "Ism familiya", before: "—", after: `${args.firstName} ${args.lastName}` },
      { label: "Telefon", before: "—", after: formatPhoneUz(phone) },
      { label: "Manba", before: "—", after: source.name },
      { label: "Yo'nalish", before: "—", after: direction.name },
      { label: "Toifa", before: "—", after: category.name },
    ];
    if (additionalPhone) fields.push({ label: "Qo'shimcha telefon", before: "—", after: formatPhoneUz(additionalPhone) });
    if (args.classInterest) fields.push({ label: "Qiziqqan sinf", before: "—", after: args.classInterest });
    if (args.parentName) fields.push({ label: "Ota-ona", before: "—", after: args.parentName });
    if (parentPhone) fields.push({ label: "Ota-ona telefoni", before: "—", after: formatPhoneUz(parentPhone) });
    if (args.address) fields.push({ label: "Manzil", before: "—", after: args.address });
    if (args.notes) fields.push({ label: "Izoh", before: "—", after: clip(args.notes, 400) });
    if (expectedEnrollDate) {
      fields.push({
        label: "Kutilayotgan qabul",
        before: "—",
        after: formatDateUz(new Date(`${expectedEnrollDate}T00:00:00Z`), { utc: true }),
      });
    }

    return {
      params: { data },
      preview: {
        summary: `${args.firstName} ${args.lastName} yangi lid sifatida qo'shiladi`,
        target: `Lid — ${source.name}`,
        fields,
        effects: [
          `Lid "${LEAD_STATUS_LABELS.new}" holatida yaratiladi`,
          "Lid tarixiga \"Yangi lead yaratildi\" izohi yoziladi",
        ],
        warnings,
      },
    };
  },
  // Mirrors POST /api/leads — lead.routes.js (leads.create) →
  // lead.controller.createLead: `createLead(req.body, req.user.id)` (empty optional fields omitted,
  // as LeadFormModal does).
  async execute(params, ctx) {
    const lead = await leadService.createLead(params.data, ctx.user.id);
    return {
      summary: `${leadName(lead)} lid sifatida qo'shildi`,
      details: [{ label: "Manba", value: lead.source?.name ?? "—" }],
      data: { leadId: lead.id },
    };
  },
});

const updateLeadStatus = defineAction({
  type: "leads.update_status",
  toolName: "propose_update_lead_status",
  toolset: "operations",
  title: "Lid holatini o'zgartirish",
  risk: "low",
  permission: "leads.status",
  description:
    "Propose moving a CRM lead to another pipeline status (any status to any status). lostReason is REQUIRED for rejected and lost. Moving to 'enrolled' does NOT create a student — that stays a separate manual step. description is an optional history note.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["leadId", "status"],
    properties: {
      leadId: idSchema("Lead id from ops_leads."),
      status: {
        type: "string",
        enum: Object.keys(LEAD_STATUS_LABELS),
        description: "New status: new, contacted, interested, visited, trial, negotiation, enrolled, rejected, lost, postponed.",
      },
      lostReason: textSchema("Why the family refused or was lost. Required for rejected and lost.", 500),
      description: textSchema("Optional note written to the lead history.", 1000),
    },
  },
  async prepare(args) {
    const lead = await loadLead(args.leadId);
    if (lead.status === args.status) {
      throw new AiToolError(`Lid allaqachon "${LEAD_STATUS_LABELS[args.status]}" holatida`);
    }
    const isExit = LEAD_EXIT_STATUSES.includes(args.status);
    if (isExit && !args.lostReason) {
      throw new AiToolError(`"${LEAD_STATUS_LABELS[args.status]}" holati uchun sabab (lostReason) majburiy — egadan so'rang`);
    }

    const fields = [
      { label: "Holat", before: LEAD_STATUS_LABELS[lead.status] ?? lead.status, after: LEAD_STATUS_LABELS[args.status] },
    ];
    if (isExit) fields.push({ label: "Sabab", before: lead.lostReason || "—", after: args.lostReason });
    if (args.description) fields.push({ label: "Izoh", before: "—", after: args.description });

    const warnings = [];
    if (args.status === "enrolled") {
      warnings.push("O'quvchi avtomatik yaratilmaydi — uni Foydalanuvchilar bo'limida alohida qo'shish kerak");
    }

    return {
      params: {
        leadId: lead.id,
        status: args.status,
        lostReason: isExit ? args.lostReason : null,
        description: args.description ?? null,
      },
      preview: {
        summary: `${leadName(lead)} lidi "${LEAD_STATUS_LABELS[args.status]}" holatiga o'tkaziladi`,
        target: `Lid — ${leadName(lead)}`,
        fields,
        effects: ["Lid tarixiga holat o'zgarishi yoziladi"],
        warnings,
      },
      fingerprint: {
        leadId: lead.id,
        current: lead.status,
        currentReason: lead.lostReason ?? null,
        status: args.status,
        lostReason: isExit ? args.lostReason : null,
        description: args.description ?? null,
      },
    };
  },
  // Mirrors PUT /api/leads/:id/status — lead.routes.js (validateObjectId, leads.status) →
  // lead.controller.updateLeadStatus: `updateLeadStatus(id, status, description, lostReason, req.user.id)`.
  async execute(params, ctx) {
    const lead = await leadService.updateLeadStatus(
      params.leadId,
      params.status,
      params.description ?? undefined,
      params.lostReason ?? undefined,
      ctx.user.id,
    );
    return {
      summary: `${leadName(lead)} lidi "${LEAD_STATUS_LABELS[lead.status]}" holatiga o'tkazildi`,
      data: { leadId: lead.id, status: lead.status },
    };
  },
});

const addLeadActivity = defineAction({
  type: "leads.add_activity",
  toolName: "propose_add_lead_activity",
  toolset: "operations",
  title: "Lidga harakat yozish",
  risk: "low",
  permission: "leads.activities",
  description:
    "Propose recording a follow-up activity on a CRM lead: call, meeting, note or visit, with a description of what happened. It does not change the lead status (use propose_update_lead_status for that).",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["leadId", "type", "description"],
    properties: {
      leadId: idSchema("Lead id from ops_leads."),
      type: {
        type: "string",
        enum: Object.keys(LEAD_ACTIVITY_LABELS),
        description: "call, meeting, note or visit.",
      },
      description: textSchema("What happened (e.g. result of the call).", 1000),
    },
  },
  async prepare(args) {
    const lead = await loadLead(args.leadId);
    return {
      params: { leadId: lead.id, type: args.type, description: args.description },
      preview: {
        summary: `${leadName(lead)} lidiga "${LEAD_ACTIVITY_LABELS[args.type]}" harakati yoziladi`,
        target: `Lid — ${leadName(lead)} (${LEAD_STATUS_LABELS[lead.status] ?? lead.status})`,
        fields: [
          { label: "Harakat turi", before: "—", after: LEAD_ACTIVITY_LABELS[args.type] },
          { label: "Tavsif", before: "—", after: args.description },
        ],
        effects: ["Lid holati o'zgarmaydi"],
        warnings: [],
      },
    };
  },
  // Mirrors POST /api/leads/:id/activities — lead.routes.js (validateObjectId, leads.activities) →
  // lead.controller.createLeadActivity: `createActivity(req.params.id, req.body, req.user.id)`.
  async execute(params, ctx) {
    const activity = await leadActivityService.createActivity(
      params.leadId,
      { type: params.type, description: params.description },
      ctx.user.id,
    );
    return {
      summary: `Lidga "${LEAD_ACTIVITY_LABELS[activity.type] ?? activity.type}" harakati yozildi`,
      data: { leadId: params.leadId, activityId: activity.id },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// TELEGRAM TARQATMA
// ─────────────────────────────────────────────────────────────────────────

/** "~3 daqiqa" — navbat filial bo'yicha ketma-ket, har xabar orasida `messageRateLimitMs`. */
function deliveryEta(count) {
  const seconds = Math.ceil((count * config.messageRateLimitMs) / 1000);
  if (seconds < 60) return `taxminan ${seconds} soniyada`;
  return `taxminan ${Math.ceil(seconds / 60)} daqiqada`;
}

const sendMessage = defineAction({
  type: "messages.send",
  toolName: "propose_send_message",
  toolset: "operations",
  title: "Telegram xabar yuborish",
  risk: "critical",
  permission: "messages.create",
  description:
    "Propose a Telegram broadcast from the platform bot. recipientType: 'class' (parents of every student in classId), 'student' (parents of one student, studentId) or 'all' (every teacher and every student's parents in the branch). Recipients are the Telegram accounts linked in the bot; the broadcast ignores parents' notification opt-out and archived status — the preview counts them. text is plain text up to 2000 characters (HTML is escaped). Irreversible once delivered; attachments are not supported.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["recipientType", "text"],
    properties: {
      recipientType: {
        type: "string",
        enum: Object.keys(RECIPIENT_TYPE_LABELS),
        description: "all, class or student.",
      },
      classId: idSchema("Class id — required when recipientType is class."),
      studentId: idSchema("Student user id — required when recipientType is student."),
      text: textSchema("Exact message text in Uzbek, as the owner approved it. Plain text, no HTML.", MAX_FREE_TEXT),
    },
  },
  async prepare(args, ctx) {
    const { recipientType } = args;

    try {
      messageService.assertCanSend(ctx.user, recipientType);
    } catch (err) {
      if (err instanceof ForbiddenError) {
        throw new AiToolError(
          recipientType === "all"
            ? "Profilingizda qo'shimcha \"o'qituvchi\" roli bor — tizim bunday hisobdan barchaga tarqatma yuborishni taqiqlaydi. Sinf yoki o'quvchi bo'yicha yuboring"
            : "Bu hisobdan tarqatma yuborishga ruxsat yo'q",
        );
      }
      throw err;
    }
    if (recipientType === "class" && !args.classId) {
      throw new AiToolError("Sinfga yuborish uchun sinf (classId) kerak — people_classes bilan aniqlang");
    }
    if (recipientType === "student" && !args.studentId) {
      throw new AiToolError("O'quvchiga yuborish uchun o'quvchi (studentId) kerak — search_people bilan aniqlang");
    }

    const classId = recipientType === "class" ? requireId(args.classId, "classId") : null;
    const studentId = recipientType === "student" ? requireId(args.studentId, "studentId") : null;

    const resolved = await messageService.resolveRecipients({
      recipientType,
      classId: classId ?? undefined,
      studentId: studentId ?? undefined,
    });
    const { recipients, recipientIds } = resolved;

    // Servis `student` turida rolni tekshirmaydi — xodimning eski Telegram
    // ID siga "o'quvchi ota-onasi" nomi ostida xabar ketib qolmasin.
    if (recipientType === "student" && recipients[0].role !== ROLES.STUDENT) {
      throw new AiToolError(`${personName(recipients[0])} o'quvchi emas — o'quvchi bo'yicha tarqatma faqat o'quvchi ota-onalariga yuboriladi`);
    }

    const [classRow, notificationsOff, inactiveAccounts] = await Promise.all([
      classId ? prisma.class.findUnique({ where: { id: classId }, select: { name: true } }) : null,
      prisma.tgUser.count({ where: { telegramId: { in: recipientIds }, notificationsEnabled: false } }),
      prisma.tgUser.count({ where: { telegramId: { in: recipientIds }, isActive: false } }),
    ]);

    const teacherCount = recipients.filter((user) => user.role !== ROLES.STUDENT).length;
    const studentCount = recipients.length - teacherCount;
    const archivedCount = recipients.filter((user) => user.isArchived).length;
    const uniqueAccounts = new Set(recipientIds).size;

    let audience = RECIPIENT_TYPE_LABELS[recipientType];
    if (classRow) audience = `${classRow.name} sinfi o'quvchilari ota-onalari`;
    if (studentId) audience = `O'quvchi ota-onalari: ${personName(recipients[0])}`;

    const fields = [
      { label: "Kimga", before: "—", after: audience },
      {
        label: "Qamrov",
        before: "—",
        after: teacherCount
          ? `${studentCount} ta o'quvchi va ${teacherCount} ta o'qituvchi`
          : `${studentCount} ta o'quvchi`,
      },
      { label: "Telegram hisoblari", before: "—", after: `${recipientIds.length} ta` },
      { label: "Matn", before: "—", after: args.text },
    ];

    const warnings = [];
    if (/[<>]/.test(args.text)) {
      warnings.push("Matndagi < va > belgilari formatlash sifatida emas, oddiy belgi bo'lib ko'rinadi");
    }
    if (notificationsOff > 0) {
      warnings.push(`Bildirishnomalarni o'chirgan ${notificationsOff} ta ota-ona ham xabarni oladi — tarqatma bu sozlamani hisobga olmaydi`);
    }
    if (inactiveAccounts > 0) {
      warnings.push(`${inactiveAccounts} ta hisob botda nofaol — ularga yetkazilmasligi mumkin`);
    }
    if (archivedCount > 0) {
      warnings.push(`Qabul qiluvchilar orasida ${archivedCount} ta arxivlangan foydalanuvchi bor — tarqatma arxiv bo'yicha filtrlamaydi`);
    }
    if (uniqueAccounts < recipientIds.length) {
      warnings.push(`${recipientIds.length - uniqueAccounts} ta takroriy yuborish: bir nechta farzandi bor ota-ona xabarni har farzandi uchun alohida oladi`);
    }
    if (teacherCount > 0) {
      warnings.push(`${teacherCount} ta o'qituvchining Telegram ID si qo'lda kiritilgan eski yozuv — ular ham oladi`);
    }

    return {
      params: { recipientType, classId, studentId, text: args.text },
      preview: {
        summary: `Telegram xabar ${recipientIds.length} ta hisobga yuboriladi (${audience})`,
        target: audience,
        fields,
        effects: [
          `Xabar navbatga qo'yiladi va ${deliveryEta(recipientIds.length)} yetkaziladi`,
          "Yetkazilgan xabarni qaytarib olib bo'lmaydi; hali navbatda turganlarini Xabarlar bo'limida to'xtatish mumkin",
          "Telegram o'qilganlik belgisini bermaydi — natijani \"yetkazildi\" soni bilan kuzating",
        ],
        warnings,
      },
      fingerprint: {
        recipientType,
        classId,
        studentId,
        text: args.text,
        recipients: hashOf(recipientIds),
        recipientCount: recipientIds.length,
        notificationsOff,
        inactiveAccounts,
        archivedCount,
      },
    };
  },
  // Mirrors POST /api/messages — message.routes.js (messages section + messages.create) →
  // message.controller.sendMessage → `messageService.sendMessage({ actor: req.user, messageText,
  // recipientType, classId, studentId, file: req.file || null })`. The HTTP body arrives through
  // xss-clean; here the text is escaped with escapeHtml instead (Telegram HTML parse mode).
  async execute(params, ctx) {
    const message = await messageService.sendMessage({
      actor: ctx.user,
      messageText: escapeHtml(params.text),
      recipientType: params.recipientType,
      classId: params.classId ?? undefined,
      studentId: params.studentId ?? undefined,
      file: null,
    });
    return {
      summary: `Xabar ${message.totalRecipients} ta Telegram hisobiga yuborish uchun navbatga qo'yildi`,
      details: [{ label: "Yetkazish holati", value: "Xabarlar bo'limida yoki ops_messages orqali kuzatiladi" }],
      data: { messageId: message.id, totalRecipients: message.totalRecipients },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// XAVFSIZLIK
// ─────────────────────────────────────────────────────────────────────────

const revokeUserSessions = defineAction({
  type: "security.revoke_user_sessions",
  toolName: "propose_revoke_user_sessions",
  toolset: "operations",
  title: "Foydalanuvchi seanslarini yopish",
  risk: "high",
  permission: "security.revoke",
  description:
    "Propose force-closing ALL open login sessions of one user in every branch (e.g. suspected leaked password or a shared account). The user is logged out within about 2 minutes; the password is NOT changed, so they can log in again. Never allowed for the owner's own account. Call ops_security_user first.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["userId"],
    properties: {
      userId: idSchema("User id whose sessions are closed."),
    },
  },
  async prepare(args, ctx) {
    const userId = requireId(args.userId, "userId");
    if (userId === ctx.user.id) {
      throw new AiToolError("O'zingizning seanslaringizni yopib bo'lmaydi — bu yordamchi bilan ishlayotgan seansni ham uzib qo'yadi");
    }

    const [entry, localUser, sessions, branches, branchRoles] = await Promise.all([
      platformPrisma.userDirectory.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true, username: true, role: true },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true, role: true, extraRoles: true },
      }),
      platformPrisma.userSession.findMany({
        where: { userId, endReason: "active" },
        orderBy: { lastSeenAt: "desc" },
        select: { id: true, branchId: true, device: true, ip: true, lastSeenAt: true, expiresAt: true },
      }),
      platformPrisma.branch.findMany({ select: { id: true, name: true } }),
      // Seanslar BARCHA filiallarda yopiladi — ega huquqi ham barcha filiallardagi
      // qatorlardan tekshiriladi: odam bir filialda xodim, boshqasida EGA roli
      // bilan biriktirilgan (yoki qo'shimcha roli ega) bo'lishi mumkin.
      mapBranches(
        () => prisma.user.findUnique({ where: { id: userId }, select: { role: true, extraRoles: true } }),
        { label: "[AiRevokeSessions]" },
      ),
    ]);

    const person = entry ?? localUser;
    if (!person) throw new AiToolError("Foydalanuvchi topilmadi");
    const failedBranches = branchRoles.filter((row) => row.error).map((row) => row.branch.name);
    if (failedBranches.length > 0) {
      throw new AiToolError(
        `Foydalanuvchining rolini ${failedBranches.join(", ")} filialida tekshirib bo'lmadi — ega hisobi emasligi tasdiqlanmaguncha seanslar yopilmaydi`,
      );
    }
    const ownerLike =
      person.role === ROLES.OWNER ||
      hasRole(localUser, ROLES.OWNER) ||
      branchRoles.some((row) => row.value && hasRole(row.value, ROLES.OWNER));
    if (ownerLike) {
      throw new AiToolError("Tizim egasining (yoki ega rolidagi hisobning) seanslari bu amal bilan yopilmaydi");
    }
    if (sessions.length === 0) {
      throw new AiToolError(`Foydalanuvchida (${personName(person)}) ochiq seans yo'q — yopadigan narsa yo'q`);
    }

    const branchNames = new Map(branches.map((row) => [row.id, row.name]));
    const live = sessions.filter((session) => session.expiresAt > ctx.now);
    const lines = sessions.slice(0, 10).map(
      (session) =>
        `${session.device || "Noma'lum qurilma"} · ${session.ip || "IP noma'lum"} · ${branchNames.get(session.branchId) ?? "noma'lum filial"} — oxirgi faollik ${formatDateTimeUz(session.lastSeenAt)}`,
    );
    if (sessions.length > lines.length) lines.push(`va yana ${sessions.length - lines.length} ta seans`);

    return {
      params: { userId },
      preview: {
        summary: `Foydalanuvchining ${sessions.length} ta ochiq seansi yopiladi: ${personName(person)}`,
        target: `${personName(person)} (${roleWord(person.role)})`,
        fields: [{ label: "Ochiq seanslar", before: `${sessions.length} ta`, after: "0" }],
        effects: [
          "Barcha filiallardagi seanslar yopiladi; foydalanuvchi ko'pi bilan 2 daqiqa ichida tizimdan chiqariladi",
          ...lines,
        ],
        warnings: [
          "Parol o'zgarmaydi — foydalanuvchi qayta kira oladi. Parol tarqalgan bo'lsa, uni Foydalanuvchilar bo'limida almashtiring",
          ...(live.length < sessions.length
            ? [`${sessions.length - live.length} ta seansning muddati allaqachon tugagan — ular ham yopilgan deb belgilanadi`]
            : []),
        ],
      },
      // `lastSeenAt` har so'rovda yangilanadi — izga faqat seanslar TO'PLAMI kiradi
      fingerprint: { userId, role: person.role, sessionIds: sessions.map((session) => session.id).sort() },
    };
  },
  // Mirrors DELETE /api/security/users/:userId/sessions — security.routes.js (security.revoke) →
  // security.controller.revokeUserSessions: `revokeUserSessions(req.params.userId, req.user, req.branch)`.
  async execute(params, ctx) {
    const { closed } = await securityDashboard.revokeUserSessions(params.userId, ctx.user, ctx.branch);
    return { summary: `${closed} ta seans tugatildi`, data: { closed } };
  },
});

const updateSecurityAlert = defineAction({
  type: "security.update_alert",
  toolName: "propose_update_security_alert",
  toolset: "operations",
  title: "Xavfsizlik ogohlantirishi holati",
  risk: "low",
  permission: "security.alerts",
  description:
    "Propose changing the status of one security alert (ids from ops_security_overview or ops_security_user): acknowledged (seen, under review), resolved (closed) or open (reopen), with an optional owner note. It does not end any session.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["alertId", "status"],
    properties: {
      alertId: idSchema("Security alert id."),
      status: {
        type: "string",
        enum: Object.keys(ALERT_STATUS_LABELS),
        description: "open, acknowledged or resolved.",
      },
      note: textSchema("Optional owner note stored on the alert (replaces the previous note).", MAX_FREE_TEXT),
    },
  },
  async prepare(args) {
    const alert = await platformPrisma.securityAlert.findUnique({ where: { id: requireId(args.alertId, "alertId") } });
    if (!alert) throw new AiToolError("Ogohlantirish topilmadi");

    const noteChanges = args.note !== undefined && args.note !== (alert.note ?? "");
    if (alert.status === args.status && !noteChanges) {
      throw new AiToolError(`Ogohlantirish allaqachon "${ALERT_STATUS_LABELS[args.status]}" holatida`);
    }

    const branch = alert.branchId
      ? await platformPrisma.branch.findUnique({ where: { id: alert.branchId }, select: { name: true } })
      : null;
    const typeLabel = securityDashboard.ALERT_META[alert.type]?.label ?? alert.type;

    const fields = [
      { label: "Holat", before: ALERT_STATUS_LABELS[alert.status] ?? alert.status, after: ALERT_STATUS_LABELS[args.status] },
    ];
    if (args.note !== undefined) fields.push({ label: "Izoh", before: alert.note || "—", after: args.note });

    const effects = [];
    if (args.status === "resolved") effects.push("Ogohlantirish ochiq ro'yxatdan chiqadi");
    if (args.status === "open") effects.push("Ko'rib chiqilgan va hal qilingan belgilari tozalanadi");
    effects.push("Seanslar yopilmaydi — faqat ogohlantirish holati o'zgaradi");

    const warnings = [];
    if (args.status === "resolved" && ["high", "critical"].includes(alert.severity)) {
      warnings.push(`Bu "${SEVERITY_LABELS[alert.severity]}" darajali ogohlantirish — yopishdan oldin foydalanuvchining ochiq seanslarini tekshiring`);
    }

    return {
      params: { alertId: alert.id, status: args.status, note: args.note ?? null },
      preview: {
        summary: `"${clip(alert.title, 120)}" ogohlantirishi "${ALERT_STATUS_LABELS[args.status]}" holatiga o'tkaziladi`,
        target: `${typeLabel} — ${SEVERITY_LABELS[alert.severity] ?? alert.severity}${branch ? `, ${branch.name}` : ""}`,
        fields,
        effects,
        warnings,
      },
      // `hitCount`/`lastSeenAt` qoida qayta ishlaganda o'zgaradi — ular qarorga ta'sir qilmaydi
      fingerprint: {
        alertId: alert.id,
        current: alert.status,
        currentNote: alert.note ?? null,
        status: args.status,
        note: args.note ?? null,
      },
    };
  },
  // Mirrors PUT /api/security/alerts/:id — security.routes.js (security.alerts) →
  // security.controller.updateAlert: `updateAlert(id, { status, note: req.body.note, actor: req.user, branch: req.branch })`.
  async execute(params, ctx) {
    const alert = await securityDashboard.updateAlert(params.alertId, {
      status: params.status,
      note: params.note ?? undefined,
      actor: ctx.user,
      branch: ctx.branch,
    });
    return {
      summary: `Ogohlantirish "${ALERT_STATUS_LABELS[alert.status]}" holatiga o'tkazildi`,
      data: { alertId: alert.id, status: alert.status },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// DO'KON
// ─────────────────────────────────────────────────────────────────────────

/** `market.service.updateOrderStatusByOwner` ruxsat beradigan o'tishlar. */
const MARKET_TRANSITIONS = { delivering: "pending", rejected: "pending", approved: "delivering" };

const updateMarketOrderStatus = defineAction({
  type: "market.update_order_status",
  toolName: "propose_update_market_order_status",
  toolset: "operations",
  title: "Do'kon buyurtmasi holati",
  risk: "medium",
  permission: "market.fulfill",
  description:
    "Propose moving a coin-shop order along the owner flow (ids from ops_market_orders): pending → delivering, delivering → approved (delivered), or pending → rejected. Rejecting REFUNDS the coins to the student and returns the items to stock; rejectReason (min 3 characters) is required. A delivery photo cannot be attached here.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["orderId", "status"],
    properties: {
      orderId: idSchema("Market order id."),
      status: {
        type: "string",
        enum: Object.keys(MARKET_TRANSITIONS),
        description: "delivering, approved or rejected.",
      },
      rejectReason: textSchema("Reason shown to the student. Required for rejected.", 500, 3),
    },
  },
  async prepare(args) {
    const order = await prisma.marketOrder.findUnique({ where: { id: requireId(args.orderId, "orderId") } });
    if (!order) throw new AiToolError("Buyurtma topilmadi");

    const expected = MARKET_TRANSITIONS[args.status];
    if (order.status !== expected) {
      throw new AiToolError(
        `"${MARKET_STATUS_LABELS[order.status] ?? order.status}" holatidagi buyurtmani "${MARKET_STATUS_LABELS[args.status]}" ga o'tkazib bo'lmaydi — faqat "${MARKET_STATUS_LABELS[expected]}" holatidan`,
      );
    }
    const isReject = args.status === "rejected";
    if (isReject && !args.rejectReason) {
      throw new AiToolError("Rad etish sababi (kamida 3 belgi) majburiy — egadan so'rang");
    }

    const [student, product] = await Promise.all([
      prisma.user.findUnique({ where: { id: order.studentId }, select: { firstName: true, lastName: true, coinBalance: true } }),
      prisma.marketProduct.findUnique({ where: { id: order.productId }, select: { name: true, quantity: true } }),
    ]);
    if (isReject && (!student || !product)) {
      throw new AiToolError("Buyurtmaning o'quvchisi yoki mahsuloti bazada yo'q — coin va qoldiqni qaytarib bo'lmaydi, rad etish mumkin emas");
    }

    const productName = product?.name ?? order.productSnapshot?.name ?? "Noma'lum mahsulot";
    const studentName = student ? personName(student) : "Noma'lum o'quvchi";

    const fields = [
      { label: "Holat", before: MARKET_STATUS_LABELS[order.status], after: MARKET_STATUS_LABELS[args.status] },
    ];
    const effects = [];
    const warnings = [];
    if (isReject) {
      fields.push(
        { label: "Rad etish sababi", before: "—", after: args.rejectReason },
        { label: "O'quvchi coin balansi", before: `${student.coinBalance} coin`, after: `${student.coinBalance + order.totalPrice} coin` },
        { label: "Mahsulot qoldig'i", before: `${product.quantity} ta`, after: `${product.quantity + order.quantity} ta` },
      );
      effects.push(`${order.totalPrice} coin o'quvchiga qaytariladi va ${order.quantity} ta mahsulot omborga qaytadi`);
      warnings.push("Coin qaytarish va holatni yangilash alohida bosqichlarda yoziladi — xato chiqsa, natijani Do'kon bo'limida tekshiring");
    } else if (args.status === "delivering") {
      effects.push("O'quvchi buyurtmasi \"Yetkazilmoqda\" deb ko'radi va uni endi bekor qila olmaydi");
    } else {
      effects.push("Buyurtma yakunlanadi; yetkazish rasmini Do'kon bo'limida qo'shish mumkin");
    }

    return {
      params: {
        orderId: order.id,
        fromStatus: order.status,
        status: args.status,
        rejectReason: isReject ? args.rejectReason : null,
      },
      preview: {
        summary: `${studentName} buyurtmasi (${productName}) "${MARKET_STATUS_LABELS[args.status]}" holatiga o'tkaziladi`,
        target: `${studentName} — ${productName} × ${order.quantity} (${order.totalPrice} coin)`,
        fields,
        effects,
        warnings,
      },
      fingerprint: {
        orderId: order.id,
        current: order.status,
        status: args.status,
        rejectReason: isReject ? args.rejectReason : null,
        totalPrice: order.totalPrice,
        quantity: order.quantity,
        coinBalance: isReject ? student.coinBalance : null,
        stock: isReject ? product.quantity : null,
      },
    };
  },
  // Mirrors PATCH /api/market/admin/orders/:orderId/status — market.routes.js (validateObjectId,
  // market.fulfill) → market.controller.updateOrderStatusByOwner:
  // `updateOrderStatusByOwner(req.params.orderId, req.body, req.user.id, req.file || null)` (AI: no file).
  async execute(params, ctx) {
    // Holat bevosita yozishdan oldin QAYTA o'qiladi: rad etishda coin qaytarish
    // holat yangilanishidan OLDIN va alohida yoziladi, parallel ikkinchi qaror
    // coinni ikki marta qaytarmasligi uchun eng kech tekshiruv shu yerda.
    const current = await prisma.marketOrder.findUnique({ where: { id: params.orderId }, select: { status: true } });
    if (!current) throw new AiToolError("Buyurtma topilmadi");
    if (current.status !== params.fromStatus) {
      throw new AiToolError(
        `Buyurtma holati o'zgargan ("${MARKET_STATUS_LABELS[current.status] ?? current.status}") — amal bajarilmadi`,
      );
    }

    let order;
    try {
      order = await marketService.updateOrderStatusByOwner(
        params.orderId,
        { status: params.status, rejectReason: params.rejectReason ?? "" },
        ctx.user.id,
        null,
      );
    } catch (error) {
      rethrowServiceError(error);
    }
    return {
      summary: `Buyurtma "${MARKET_STATUS_LABELS[order.status] ?? order.status}" holatiga o'tkazildi`,
      data: { orderId: order.id, status: order.status },
    };
  },
});

module.exports = [
  createTask,
  approveTask,
  rejectTask,
  extendTaskDeadline,
  stopTask,
  createLead,
  updateLeadStatus,
  addLeadActivity,
  sendMessage,
  revokeUserSessions,
  updateSecurityAlert,
  updateMarketOrderStatus,
];
