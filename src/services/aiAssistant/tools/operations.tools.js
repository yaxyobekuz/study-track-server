/**
 * AI YORDAMCHI — "Operatsiyalar" bo'limi o'qish vositalari.
 *
 * Qamrov: topshiriqlar, lidlar (CRM), Telegram tarqatmalari va yetkazish
 * navbati, inventar va moddiy zarar, xodim/ota-ona faolligi, xavfsizlik
 * (seanslar, ogohlantirishlar), o'zgarishlar tarixi, do'kon buyurtmalari.
 *
 * Har bir vosita MAVJUD servisni HTTP controller chaqirgandek chaqiradi
 * (`operations.md` xaritasi) va natijani OQ RO'YXAT bilan ixchamlaydi.
 * Servis qatorini "borligicha" uzatish taqiqlangan: tarqatma qatorlarida
 * Telegram ID lari, seans qatorlarida `meta`, inventar xonasida mas'ulning
 * `telegramIds` bor — model uchun bular shovqin yoki shaxsiy ma'lumot.
 *
 * ⚠️ TELEFON RAQAMI HECH QAYSI RO'YXATDA CHIQMAYDI (lid ro'yxati ham),
 * `design.md` §3.1 qoida 3.
 *
 * ⚠️ "O'QILDI" DEB AYTILMAYDI. Telegram o'qilganlik belgisini bermaydi —
 * navbat faqat "yetkazildi"/"yetkazilmadi" ni biladi. Tavsiflarda shu
 * so'z ataylab ishlatiladi.
 */

const prisma = require("../../../config/prisma");
const platformPrisma = require("../../../config/platformPrisma");
const taskService = require("../../task.service");
const leadService = require("../../lead.service");
const leadSourceService = require("../../leadSource.service");
const leadDirectionService = require("../../leadDirection.service");
const leadCategoryService = require("../../leadCategory.service");
const messageService = require("../../message.service");
const messageQueueService = require("../../messageQueue.service");
const inventoryDashboard = require("../../inventoryDashboard.service");
const inventoryCheckService = require("../../inventoryCheck.service");
const inventoryDamageService = require("../../inventoryDamage.service");
const inventoryReportService = require("../../inventoryReport.service");
const inventorySettingsService = require("../../inventorySettings.service");
const damageChargeService = require("../../damageCharge.service");
const activityDashboard = require("../../activityDashboard.service");
const securityDashboard = require("../../securityDashboard.service");
const changelogService = require("../../changelog.service");
const marketService = require("../../market.service");
const { ROLES } = require("../../../utils/constants");
const { hasRole } = require("../../../utils/permissions");
const { PANELS } = require("../../../helpers/changelogMarkdown.helpers");
const { formatDateUz, formatDateTimeUz } = require("../../../helpers/date.helpers");
const { toDecimal } = require("../../../helpers/money.helpers");
const {
  AiToolError,
  defineTool,
  idSchema,
  monthSchema,
  daySchema,
  limitSchema,
  requireId,
  monthArg,
  dayArg,
  reqLike,
  formatMoneyUz,
  monthLabel,
  sliceList,
  personName,
} = require("../assistant.toolkit");

// ─────────────────────────────────────────────────────────────────────────
// Yorliqlar (admin paneldagi `*.data.js` bilan AYNAN bir xil matn — ega
// ekranda ko'rgan so'zni yordamchi javobida ham ko'rsin)
// ─────────────────────────────────────────────────────────────────────────

const TASK_STATUS_LABELS = {
  pending: "Kutilmoqda",
  extended: "Uzaytirilgan",
  pending_rejected: "Kutilmoqda (Rad etilgan)",
  pending_review: "Yakunlangan (Tasdiq kutilmoqda)",
  completed: "Muvaffaqiyatli yakunlangan",
  stopped: "To'xtatilgan",
};
const TASK_STATUSES = Object.keys(TASK_STATUS_LABELS);
/** Yakuniy holatlar: muddat o'tishi va jarima endi ahamiyatsiz. */
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
const LEAD_STATUSES = Object.keys(LEAD_STATUS_LABELS);
/** `lead.service` analitikasidagi "active" to'plami bilan bir xil. */
const LEAD_ACTIVE_STATUSES = ["new", "contacted", "interested", "visited", "trial", "negotiation", "postponed"];
/** Faol lid shuncha kun harakatsiz tursa "unutilgan" hisoblanadi. */
const LEAD_STALE_DAYS = 14;

const RECIPIENT_TYPE_LABELS = {
  all: "Barcha (o'qituvchi va o'quvchilar ota-onalari)",
  class: "Sinf",
  student: "O'quvchi",
  season: "Test mavsumi",
};

const QUEUE_STATUS_LABELS = {
  pending: "Navbatda",
  processing: "Yuborilmoqda",
  completed: "Yetkazildi",
  failed: "Yetkazilmadi",
  cancelled: "Bekor qilindi",
};

const MARKET_STATUS_LABELS = {
  pending: "Kutilmoqda",
  delivering: "Yetkazilmoqda",
  approved: "Yetkazib berildi",
  rejected: "Rad etilgan",
  cancelled: "Bekor qilingan",
};
const MARKET_STATUSES = Object.keys(MARKET_STATUS_LABELS);

const SEVERITY_LABELS = { low: "Past", medium: "O'rta", high: "Yuqori", critical: "Jiddiy" };
const ALERT_STATUS_LABELS = { open: "Ochiq", acknowledged: "Ko'rib chiqilgan", resolved: "Hal qilingan" };

const PANEL_LABELS = {
  admin: "Admin panel",
  teacher: "O'qituvchi paneli",
  student: "O'quvchi paneli",
  server: "Server",
  bot: "Telegram bot",
};

/** Navbatda "yuborilmoqda" holati shuncha vaqtdan oshsa — qotib qolgan. */
const QUEUE_STUCK_MS = 10 * 60 * 1000;
/** Navbatda "kutilmoqda" holati shuncha vaqtdan oshsa — sikl ishlamayapti. */
const QUEUE_STALE_PENDING_MS = 5 * 60 * 1000;
/** Yetkazilmagan xabarlar tahlili oynasi. */
const QUEUE_FAILURE_WINDOW_DAYS = 7;

const DAY_MS = 86400000;

/**
 * Ro'yxat qatorlari uchun JSON hajmi chegarasi (belgi). `limit` qator SONINI
 * cheklaydi, lekin uzun matnli qatorlar (lid izohi, xabar matni, reliz
 * bandlari) javobni baribir ~15k belgidan oshirib yuborardi.
 */
const LIST_BUDGET_CHARS = 11000;

// ─────────────────────────────────────────────────────────────────────────
// Umumiy yordamchilar
// ─────────────────────────────────────────────────────────────────────────

/** Matnni modelga ixcham uzatish uchun qisqartiradi. */
function clip(text, max) {
  if (text === null || text === undefined) return null;
  const value = String(text).trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/**
 * Qatorlarni JSON hajmi bo'yicha kesadi (tartib saqlanadi, birinchi qator
 * doim qoladi). Chaqiruvchi `truncated` ni `total > items.length` bilan
 * hisoblaydi — kesish jim qolmaydi.
 */
function fitToBudget(rows, maxChars = LIST_BUDGET_CHARS) {
  const items = [];
  let used = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length + 1;
    if (items.length > 0 && used + size > maxChars) break;
    items.push(row);
    used += size;
  }
  return items;
}

/** Telefon raqamiga o'xshash ketma-ketlik: 9–13 raqam, bo'shliq/qavs/defis bilan. */
const PHONE_LIKE = /\+?\d[\d\s()-]{7,}\d/g;
const ISO_DAY_LIKE = /\d{4}-\d{1,2}-\d{1,2}/;

/**
 * Erkin matndagi telefon raqamlarini yashiradi (`design.md` §3.1 qoida 3:
 * ro'yxat vositalarida telefon YO'Q). Lid izohiga qabulxona "otasi: 90 123
 * 45 67" deb yozadi — maydonni tashlab yubormasdan raqamning o'zi olinadi.
 * Sana ("2026-09-15 14") raqam sanog'iga tushsa ham yashirilmaydi.
 */
function redactPhones(text) {
  if (!text) return text;
  return text.replace(PHONE_LIKE, (match) => {
    const digits = match.replace(/\D/g, "").length;
    return digits >= 9 && digits <= 13 && !ISO_DAY_LIKE.test(match) ? "[telefon yashirildi]" : match;
  });
}

/** "YYYY-MM-DD" (UTC yarim tuni sifatida) → "21-may, 2025". */
const dayLabel = (iso) => formatDateUz(new Date(`${iso}T00:00:00Z`), { utc: true });

/**
 * `from`/`to` kun oralig'ini tekshiradi.
 * @returns {{ from?: string, to?: string, label: string }}
 */
function dayRangeArgs(args) {
  const from = args.from ? dayArg(args.from, "from") : undefined;
  const to = args.to ? dayArg(args.to, "to") : undefined;
  if (from && to && from > to) {
    throw new AiToolError("Boshlanish sanasi tugash sanasidan keyin bo'lmasin");
  }
  let label = "Butun davr";
  if (from && to) label = `${dayLabel(from)} — ${dayLabel(to)}`;
  else if (from) label = `${dayLabel(from)} dan`;
  else if (to) label = `${dayLabel(to)} gacha`;
  return { from, to, label };
}

/** Soft-ref foydalanuvchi id lari → `{ id, name, role }` xaritasi (joriy filial). */
async function loadPeople(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (unique.length === 0) return new Map();
  const rows = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, firstName: true, lastName: true, role: true, isArchived: true },
  });
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Filial id → nom (xavfsizlik jadvallari platformada, filiallar aralash).
 * Arxivlangan filial ham kiradi: eski seans va ogohlantirishlar unga
 * ishora qilishi mumkin.
 */
async function loadBranchNames() {
  const rows = await platformPrisma.branch.findMany({ select: { id: true, name: true } });
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Guruhlangan sanoq obyektini `{ key: n }` ga aylantiradi. */
function countBy(rows, key) {
  const out = {};
  for (const row of rows) out[row[key]] = row._count._all;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// TOPSHIRIQLAR
// ─────────────────────────────────────────────────────────────────────────

/**
 * Topshiriq qatorini ixcham shaklga keltiradi.
 * `assignee`/`createdBy` servisdan obyekt bo'lib yoki xom id bo'lib kelishi
 * mumkin (muddati o'tganlar yo'li xom qatorni o'qiydi).
 */
function serializeTaskRow(task, people, now) {
  const resolve = (ref) => (ref && typeof ref === "object" ? ref : people.get(String(ref)) || null);
  const assignee = resolve(task.assignee);
  const creator = resolve(task.createdBy);
  const overdue = task.dueDate < now && !TASK_TERMINAL.includes(task.status);
  return {
    id: task.id,
    title: clip(task.title, 160),
    status: task.status,
    statusLabel: TASK_STATUS_LABELS[task.status] ?? task.status,
    assignee: assignee ? { id: assignee.id, name: personName(assignee), role: assignee.role } : null,
    createdByName: creator ? personName(creator) : null,
    dueDateLabel: formatDateTimeUz(task.dueDate),
    isOverdue: overdue,
    overdueDays: overdue ? Math.floor((now - task.dueDate) / DAY_MS) : 0,
    penaltyPoints: task.penaltyPoints,
    autopenalized: task.autopenalized,
    createdAtLabel: formatDateTimeUz(task.createdAt),
  };
}

const opsTasks = defineTool({
  name: "ops_tasks",
  toolset: "operations",
  label: "Topshiriqlar ko'rilmoqda",
  description:
    "List staff tasks (topshiriqlar) in the current branch, newest first, or only OVERDUE ones (due date passed and not completed/stopped, oldest deadline first). Filter by status or assignee (resolve the person with search_people first). Returns summary {byStatus counts with labels, overdueCount, awaitingReviewCount} plus items {id, title, statusLabel, assignee, dueDateLabel (Tashkent time), isOverdue, overdueDays, penaltyPoints, autopenalized (hourly job already fined the overdue assignee)}. List is truncated to limit; use total. Use ops_task for history and review details.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: {
        type: "string",
        enum: TASK_STATUSES,
        description:
          "Task status: pending, extended, pending_rejected (sent back), pending_review (assignee submitted, waits for owner), completed, stopped.",
      },
      overdueOnly: {
        type: "boolean",
        default: false,
        description: "Only tasks whose deadline has passed and that are not completed or stopped.",
      },
      assigneeId: idSchema("Only tasks of this assignee (user id)."),
      limit: limitSchema(30),
    },
  },
  async handler(args, ctx) {
    const limit = args.limit ?? 20;
    const assigneeId = args.assigneeId ? requireId(args.assigneeId, "assigneeId") : undefined;
    const now = ctx.now;

    const overdueWhere = { dueDate: { lt: now }, status: { notIn: TASK_TERMINAL } };

    const [statusRows, overdueCount] = await Promise.all([
      prisma.task.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.task.count({ where: overdueWhere }),
    ]);
    const byStatus = countBy(statusRows, "status");

    let rows;
    let total;
    if (args.overdueOnly) {
      if (args.status && TASK_TERMINAL.includes(args.status)) {
        rows = [];
        total = 0;
      } else {
        const where = { ...overdueWhere };
        if (args.status) where.status = args.status;
        if (assigneeId) where.assignee = assigneeId;
        [rows, total] = await Promise.all([
          prisma.task.findMany({ where, orderBy: { dueDate: "asc" }, take: limit }),
          prisma.task.count({ where }),
        ]);
      }
    } else {
      const result = await taskService.getTasks(
        reqLike(ctx, { status: args.status, assigneeId, limit }),
      );
      rows = result.data;
      total = result.pagination.total;
    }

    const people = args.overdueOnly
      ? await loadPeople(rows.flatMap((task) => [task.assignee, task.createdBy]))
      : new Map();
    const items = fitToBudget(rows.map((task) => serializeTaskRow(task, people, now)));

    return {
      summary: {
        byStatus: TASK_STATUSES.map((status) => ({
          status,
          label: TASK_STATUS_LABELS[status],
          count: byStatus[status] ?? 0,
        })),
        overdueCount,
        awaitingReviewCount: byStatus.pending_review ?? 0,
      },
      filter: {
        statusLabel: args.status ? TASK_STATUS_LABELS[args.status] : "Hammasi",
        overdueOnly: Boolean(args.overdueOnly),
        assigneeId: assigneeId ?? null,
      },
      items,
      total,
      truncated: total > items.length,
      ...(total === 0 ? { empty: true, reason: "Tanlangan filtr bo'yicha topshiriq yo'q" } : {}),
    };
  },
});

const opsTask = defineTool({
  name: "ops_task",
  toolset: "operations",
  label: "Topshiriq tafsiloti",
  description:
    "Full detail of ONE task by id: description, assignee, creator, deadline, the 10 latest status and deadline history entries (who changed what and why; totals given), completion note from the assignee, applied penalty, and what the owner can do next: canApprove/canReject (only pending_review), rejectRequiresNewDueDate and rejectWillPenalize (deadline passed and not yet fined), canStop, canExtend. Call before proposing approve/reject/stop/extend.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["taskId"],
    properties: {
      taskId: idSchema("Task id from ops_tasks."),
    },
  },
  async handler(args, ctx) {
    const taskId = requireId(args.taskId, "taskId");
    // Controller: `getTaskById(req.params.id, req.user)` — owner tekshiruvi servis ichida
    const task = await taskService.getTaskById(taskId, ctx.user);
    const now = ctx.now;
    const overdue = task.dueDate < now && !TASK_TERMINAL.includes(task.status);
    const reviewable = task.status === "pending_review";

    return {
      id: task.id,
      title: task.title,
      description: clip(task.description, 1500),
      status: task.status,
      statusLabel: TASK_STATUS_LABELS[task.status] ?? task.status,
      assignee: task.assignee
        ? {
            id: task.assignee.id,
            name: personName(task.assignee),
            role: task.assignee.role,
            penaltyPointsTotal: task.assignee.penaltyPoints,
          }
        : null,
      createdByName: task.createdBy ? personName(task.createdBy) : null,
      createdAtLabel: formatDateTimeUz(task.createdAt),
      dueDateLabel: formatDateTimeUz(task.dueDate),
      isOverdue: overdue,
      penaltyPoints: task.penaltyPoints,
      autopenalized: task.autopenalized,
      appliedPenalty: task.penaltyRef
        ? {
            id: task.penaltyRef.id,
            points: task.penaltyRef.points,
            title: task.penaltyRef.title,
            createdAtLabel: formatDateTimeUz(task.penaltyRef.createdAt),
          }
        : null,
      attachmentCount: Array.isArray(task.attachments) ? task.attachments.length : 0,
      completionNote: clip(task.completionNote, 1000) || null,
      completionAttachmentCount: Array.isArray(task.completionAttachments)
        ? task.completionAttachments.length
        : 0,
      // Eng yangilari birinchi; 10 tadan — tavsif va izoh bilan birga javob ~10k belgida qoladi
      statusHistory: sliceList(
        [...task.statusHistory].reverse().map((entry) => ({
          statusLabel: TASK_STATUS_LABELS[entry.status] ?? entry.status,
          reason: clip(entry.reason, 200),
          byName: entry.changedBy ? personName(entry.changedBy) : null,
          atLabel: formatDateTimeUz(entry.changedAt),
        })),
        10,
      ),
      deadlineHistory: sliceList(
        [...task.deadlineHistory].reverse().map((entry) => ({
          fromLabel: formatDateTimeUz(entry.oldDueDate),
          toLabel: formatDateTimeUz(entry.newDueDate),
          reason: clip(entry.reason, 200),
          withPenalty: entry.withPenalty,
          penaltyPoints: entry.penaltyPoints,
          byName: entry.changedBy ? personName(entry.changedBy) : null,
          atLabel: formatDateTimeUz(entry.changedAt),
        })),
        10,
      ),
      ownerOptions: {
        canApprove: reviewable,
        canReject: reviewable,
        rejectRequiresNewDueDate: reviewable && task.dueDate < now,
        rejectWillPenalize: reviewable && task.dueDate < now && !task.autopenalized,
        canStop: ["pending", "extended", "pending_rejected", "pending_review"].includes(task.status),
        canExtend: !TASK_TERMINAL.includes(task.status),
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// LIDLAR (CRM)
// ─────────────────────────────────────────────────────────────────────────

const namedOptions = (rows) => rows.map((row) => ({ id: row.id, name: row.name }));

const opsLeadsAnalytics = defineTool({
  name: "ops_leads_analytics",
  toolset: "operations",
  label: "Lidlar tahlili",
  description:
    "CRM (leads) analytics for the current branch, optionally for leads CREATED between from and to (YYYY-MM-DD). Returns overview (total, per-status counts with labels, conversionRate % enrolled/total, lossRate % rejected+lost/total), funnel (snapshot of CURRENT status per pipeline stage with dropOff %, not a historical funnel), bySource/byDirection/byCategory (total, enrolled, active, lost, conversionRate), staleActive (active leads with no activity for 14+ days — follow-up gaps), and options: active lead sources, directions and categories {id, name} needed for propose_create_lead.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: daySchema("Start day YYYY-MM-DD (lead creation date). Omit for all time."),
      to: daySchema("End day YYYY-MM-DD inclusive. Omit for all time."),
    },
  },
  async handler(args, ctx) {
    const range = dayRangeArgs(args);
    const query = { startDate: range.from, endDate: range.to };
    const staleCutoff = new Date(ctx.now.getTime() - LEAD_STALE_DAYS * DAY_MS);

    const [overview, funnel, sources, directions, categories, staleCount, sourceOptions, directionOptions, categoryOptions] =
      await Promise.all([
        leadService.getAnalyticsOverview(query),
        leadService.getConversionFunnel(query),
        leadService.getSourceAnalytics(query),
        leadService.getDirectionAnalytics(query),
        leadService.getCategoryAnalytics(query),
        prisma.lead.count({
          where: {
            status: { in: LEAD_ACTIVE_STATUSES },
            createdAt: { lt: staleCutoff },
            activities: { none: { createdAt: { gte: staleCutoff } } },
          },
        }),
        leadSourceService.getAllSources({ active: "true" }),
        leadDirectionService.getAllDirections({ active: "true" }),
        leadCategoryService.getAllCategories({ active: "true" }),
      ]);

    const options = {
      sources: namedOptions(sourceOptions),
      directions: namedOptions(directionOptions),
      categories: namedOptions(categoryOptions),
    };

    if (overview.totalLeads === 0) {
      return {
        period: range.label,
        empty: true,
        reason: "Tanlangan davrda lid yo'q",
        options,
      };
    }

    const stageRow = (row) => ({
      stage: row.stage,
      label: LEAD_STATUS_LABELS[row.stage] ?? row.stage,
      count: row.count,
      percentage: row.percentage,
      ...(row.dropOff !== undefined ? { dropOff: row.dropOff } : {}),
    });

    return {
      period: range.label,
      overview: {
        totalLeads: overview.totalLeads,
        conversionRate: overview.conversionRate,
        lossRate: overview.lossRate,
        byStatus: LEAD_STATUSES.map((status) => ({
          status,
          label: LEAD_STATUS_LABELS[status],
          count: overview.byStatus[status] ?? 0,
        })),
      },
      funnel: {
        pipeline: funnel.pipeline.map(stageRow),
        exits: funnel.exits.map(stageRow),
      },
      bySource: sliceList(
        sources.map((row) => ({
          id: row.id,
          name: row.sourceName,
          total: row.total,
          enrolled: row.enrolled,
          active: row.active,
          lost: row.lost + row.rejected,
          conversionRate: row.conversionRate,
        })),
        20,
      ),
      byDirection: sliceList(
        directions.map((row) => ({
          id: row.id,
          name: row.directionName,
          total: row.total,
          enrolled: row.enrolled,
          active: row.active,
          lost: row.lost,
          conversionRate: row.conversionRate,
        })),
        20,
      ),
      byCategory: sliceList(
        categories.map((row) => ({
          id: row.id,
          name: row.categoryName,
          total: row.total,
          enrolled: row.enrolled,
          active: row.active,
          lost: row.lost,
          conversionRate: row.conversionRate,
        })),
        20,
      ),
      staleActive: {
        days: LEAD_STALE_DAYS,
        count: staleCount,
        note: "Oxirgi 14 kunda birorta harakat (qo'ng'iroq, uchrashuv, izoh) yozilmagan faol lidlar — butun davr bo'yicha",
      },
      options,
    };
  },
});

const opsLeads = defineTool({
  name: "ops_leads",
  toolset: "operations",
  label: "Lidlar ro'yxati",
  description:
    "List CRM leads (potential students), newest first, filtered by status and/or search (first name, last name, phone or parent name). Returns items {id, name, statusLabel, source, direction, category, classInterest, parentName, lostReason, expectedEnrollDateLabel, createdAtLabel, createdByName, lastActivityLabel, daysSinceActivity}. Phone numbers are NOT returned (also masked inside notes). Truncated to limit and to a response size budget; use total. Use the id for propose_update_lead_status or propose_add_lead_activity.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: {
        type: "string",
        enum: LEAD_STATUSES,
        description:
          "Lead status: new, contacted, interested, visited, trial, negotiation, enrolled, rejected, lost, postponed.",
      },
      search: {
        type: "string",
        maxLength: 60,
        description: "Substring of first name, last name, phone or parent name (case-insensitive).",
      },
      limit: limitSchema(50),
    },
  },
  async handler(args, ctx) {
    const limit = args.limit ?? 20;
    // Controller: `getAllLeads(req.query)` — qiymatlar HTTP dagidek satr
    const { leads, pagination } = await leadService.getAllLeads({
      status: args.status,
      search: args.search,
      page: "1",
      limit: String(limit),
    });

    if (pagination.total === 0) {
      return { empty: true, reason: "Filtr bo'yicha lid topilmadi", items: [], total: 0, truncated: false };
    }

    const lastActivity = await prisma.leadActivity.groupBy({
      by: ["leadId"],
      where: { leadId: { in: leads.map((lead) => lead.id) } },
      _max: { createdAt: true },
    });
    const lastById = new Map(lastActivity.map((row) => [row.leadId, row._max.createdAt]));

    // ⚠️ Erkin matn maydonlari (izoh, sabab, ota-ona ismi, qiziqqan sinf)
    // telefon raqamidan tozalanadi — qabulxona ularga raqam yozib qo'yadi.
    const items = fitToBudget(
      leads.map((lead) => {
        const last = lastById.get(lead.id) ?? null;
        return {
          id: lead.id,
          name: `${lead.firstName} ${lead.lastName}`.trim(),
          status: lead.status,
          statusLabel: LEAD_STATUS_LABELS[lead.status] ?? lead.status,
          source: lead.source?.name ?? null,
          direction: lead.direction?.name ?? null,
          category: lead.category?.name ?? null,
          classInterest: redactPhones(clip(lead.classInterest, 60)) || null,
          parentName: redactPhones(clip(lead.parentName, 120)) || null,
          lostReason: redactPhones(clip(lead.lostReason, 200)) || null,
          expectedEnrollDateLabel: lead.expectedEnrollDate ? formatDateUz(lead.expectedEnrollDate) : null,
          notes: redactPhones(clip(lead.notes, 200)) || null,
          createdAtLabel: formatDateTimeUz(lead.createdAt),
          createdByName: lead.createdBy ? personName(lead.createdBy) : null,
          lastActivityLabel: last ? formatDateTimeUz(last) : null,
          daysSinceActivity: last ? Math.floor((ctx.now - last) / DAY_MS) : null,
        };
      }),
    );

    return {
      items,
      total: pagination.total,
      truncated: pagination.total > items.length,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// XABARLAR VA NAVBAT
// ─────────────────────────────────────────────────────────────────────────

const opsMessages = defineTool({
  name: "ops_messages",
  toolset: "operations",
  label: "Xabarlar tarixi",
  description:
    "Recent Telegram broadcasts (Xabarlar) and debt reminders sent from the platform, newest first, with delivery statistics per message: totalRecipients (Telegram accounts), sent (delivered to Telegram), failed (not delivered, with top error reasons such as bot blocked by the user), pending (still in queue), cancelled. Telegram gives no read receipts — say delivered, never read. Text is shortened to 300 characters; the list is cut to limit and a response size budget (use total). Optional filter by recipientType.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      recipientType: {
        type: "string",
        enum: ["all", "class", "student", "season"],
        description: "all = everyone, class = one class, student = one student's parents (also debt reminders), season = test season announcements.",
      },
      limit: limitSchema(30),
    },
  },
  async handler(args, ctx) {
    const limit = args.limit ?? 20;
    // Controller: `getMessages(req.user, req.query)`
    const { data, pagination } = await messageService.getMessages(ctx.user, {
      page: "1",
      limit: String(limit),
      recipientType: args.recipientType,
    });

    const onlyOwn = hasRole(ctx.user, ROLES.TEACHER);

    if (pagination.total === 0) {
      return { empty: true, reason: "Yuborilgan xabar yo'q", items: [], total: 0, truncated: false };
    }

    const items = fitToBudget(
      data.map((message) => {
        const failures = new Map();
        let cancelled = 0;
        for (const delivery of message.deliveryStatus) {
          if (delivery.status === "cancelled") cancelled += 1;
          if (delivery.status === "failed") {
            const key = clip(delivery.errorMessage || "Noma'lum xato", 120);
            failures.set(key, (failures.get(key) ?? 0) + 1);
          }
        }
        return {
          id: message.id,
          text: clip(message.messageText, 300),
          recipientType: message.recipientType,
          recipientTypeLabel: RECIPIENT_TYPE_LABELS[message.recipientType] ?? message.recipientType,
          className: message.classId?.name ?? null,
          studentName: message.studentId ? personName(message.studentId) : null,
          sentByName: message.sentBy ? personName(message.sentBy) : null,
          createdAtLabel: formatDateTimeUz(message.createdAt),
          totalRecipients: message.totalRecipients,
          sent: message.stats.totalSent,
          failed: message.stats.totalFailed,
          pending: message.stats.totalPending,
          cancelled,
          topFailureReasons: [...failures.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([reason, count]) => ({ reason, count })),
        };
      }),
    );

    return {
      ...(onlyOwn
        ? { scopeNote: "Egada qo'shimcha 'o'qituvchi' roli bor — tizim faqat uning o'zi yuborgan xabarlarni ko'rsatadi" }
        : {}),
      items,
      total: pagination.total,
      truncated: pagination.total > items.length,
    };
  },
});

const opsMessageQueue = defineTool({
  name: "ops_message_queue",
  toolset: "operations",
  label: "Yetkazish navbati holati",
  description:
    "Health of the Telegram delivery queue in the current branch: counts per queue status, whether the sender loop is running now, stuck items ('processing' for 10+ minutes — never auto-recovered), stale pending items (waiting 5+ minutes, loop not running), failures of the last 7 days grouped by error reason, the 10 latest failures, and the separate penalty-notification queue counts. Also returns a diagnosis list in Uzbek. Use for 'are messages reaching parents' questions.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async handler(args, ctx) {
    const now = ctx.now.getTime();
    const stuckBefore = new Date(now - QUEUE_STUCK_MS);
    const staleBefore = new Date(now - QUEUE_STALE_PENDING_MS);
    const failureSince = new Date(now - QUEUE_FAILURE_WINDOW_DAYS * DAY_MS);

    const [stats, stuck, stalePending, oldestPending, failureGroups, recentFailures, penaltyQueue] =
      await Promise.all([
        messageQueueService.getQueueStats(),
        prisma.messageQueue.count({ where: { status: "processing", updatedAt: { lt: stuckBefore } } }),
        prisma.messageQueue.count({ where: { status: "pending", createdAt: { lt: staleBefore } } }),
        prisma.messageQueue.findFirst({
          where: { status: "pending" },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        }),
        prisma.messageQueue.groupBy({
          by: ["errorMessage"],
          where: { status: "failed", processedAt: { gte: failureSince } },
          _count: { _all: true },
        }),
        prisma.messageQueue.findMany({
          where: { status: "failed" },
          orderBy: { processedAt: "desc" },
          take: 10,
          select: { messageId: true, errorMessage: true, attempts: true, processedAt: true },
        }),
        prisma.penaltyNotificationQueue.groupBy({ by: ["status"], _count: { _all: true } }),
      ]);

    const isProcessing = messageQueueService.isBusy();
    const failedLastWeek = failureGroups.reduce((sum, row) => sum + row._count._all, 0);

    const diagnosis = [];
    if (stuck > 0) {
      diagnosis.push(
        `${stuck} ta xabar 10 daqiqadan beri "yuborilmoqda" holatida qotib qolgan — navbat bunday qatorlarni o'zi qayta tiklamaydi`,
      );
    }
    if (stalePending > 0 && !isProcessing) {
      diagnosis.push(
        `${stalePending} ta xabar 5 daqiqadan ortiq navbatda turibdi va yuborish sikli hozir ishlamayapti — keyingi yangi xabar yoki server qayta ishga tushishi uni uyg'otadi`,
      );
    }
    if (failedLastWeek > 0) {
      diagnosis.push(`Oxirgi 7 kunda ${failedLastWeek} ta xabar yetkazilmadi`);
    }
    if (diagnosis.length === 0) diagnosis.push("Navbatda muammo aniqlanmadi");

    return {
      queue: Object.keys(QUEUE_STATUS_LABELS).map((status) => ({
        status,
        label: QUEUE_STATUS_LABELS[status],
        count: stats[status] ?? 0,
      })),
      isProcessing,
      stuckProcessing: stuck,
      stalePending,
      oldestPendingLabel: oldestPending ? formatDateTimeUz(oldestPending.createdAt) : null,
      failuresLast7Days: {
        total: failedLastWeek,
        byReason: failureGroups
          .map((row) => ({ reason: clip(row.errorMessage || "Noma'lum xato", 160), count: row._count._all }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 8),
      },
      recentFailures: recentFailures.map((row) => ({
        messageId: row.messageId,
        reason: clip(row.errorMessage || "Noma'lum xato", 160),
        attempts: row.attempts,
        atLabel: formatDateTimeUz(row.processedAt),
      })),
      penaltyNotificationQueue: countBy(penaltyQueue, "status"),
      diagnosis,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// INVENTAR
// ─────────────────────────────────────────────────────────────────────────

/** Dashboard KPI si: qiymat, oldingi oy va o'zgarish (pul bo'lsa yorliq bilan). */
function kpiRow(metric, label) {
  const money = metric.unit === "money";
  return {
    label,
    value: money ? formatMoneyUz(metric.value) : metric.value,
    previous: money ? formatMoneyUz(metric.previous) : metric.previous,
    change: metric.change,
    changeUnit: metric.changeUnit,
  };
}

const opsInventoryOverview = defineTool({
  name: "ops_inventory_overview",
  toolset: "operations",
  label: "Inventar manzarasi",
  description:
    "Inventory dashboard for a month (compared with the previous month): health (share of serviceable stock value), monitoring discipline (submitted daily checks / expected), recovery rate (damage payments / charged), KPIs (base value, quantities, damage amount and count, recovered money), base composition, damage flow (charged/waived/pending/outstanding), damage reasons, categories, worst locations by damage, items with highest failure rate, 6-month trend, today's monitoring summary and damage debtors summary. Money values are pre-formatted Uzbek labels. Past-month stock is reconstructed from the ledger.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema(),
    },
  },
  async handler(args) {
    const month = monthArg(args.month);
    // Controller: `getOverview(req.query)`
    const data = await inventoryDashboard.getOverview({ month });

    if (data.base.itemCount === 0 && data.base.stockRows === 0) {
      return {
        period: { monthLabel: data.period.monthLabel },
        empty: true,
        reason: "Inventar katalogi va xatlov bo'sh — bo'lim hali ishlatilmagan",
      };
    }

    const ring = (value) => ({ value: value.value, previous: value.previous, label: value.label });

    return {
      period: {
        month: data.period.month,
        monthLabel: data.period.monthLabel,
        compareMonthLabel: data.period.compareMonthLabel,
      },
      rates: {
        health: ring(data.rings.health),
        discipline: {
          ...ring(data.rings.discipline),
          submitted: data.rings.discipline.detail.submitted,
          expected: data.rings.discipline.detail.expected,
        },
        recovery: ring(data.rings.recovery),
        unit: "%",
      },
      kpi: [
        kpiRow(data.kpi.baseValue, "Baza qiymati"),
        kpiRow(data.kpi.totalQuantity, "Jami buyumlar"),
        kpiRow(data.kpi.brokenQuantity, "Yaroqsiz buyumlar"),
        kpiRow(data.kpi.damageAmount, "Oy zarari"),
        kpiRow(data.kpi.damageCount, "Zarar holatlari"),
        kpiRow(data.kpi.recoveredAmount, "Undirilgan summa"),
      ],
      base: {
        totalQuantity: data.base.totalQuantity,
        brokenQuantity: data.base.brokenQuantity,
        baseValue: formatMoneyUz(data.base.baseValue),
        brokenValue: formatMoneyUz(data.base.brokenValue),
        itemCount: data.base.itemCount,
        categoryCount: data.base.categoryCount,
        locationCount: data.base.locationCount,
      },
      damageFlow: {
        total: formatMoneyUz(data.flow.total),
        charged: formatMoneyUz(data.flow.charged),
        waived: formatMoneyUz(data.flow.waived),
        pendingUncharged: formatMoneyUz(data.flow.pending),
        recovered: formatMoneyUz(data.flow.recovered),
        outstanding: formatMoneyUz(data.flow.outstanding),
      },
      reasons: data.reasons.map((row) => ({
        label: row.label,
        count: row.count,
        quantity: row.quantity,
        amount: formatMoneyUz(row.amount),
        share: row.share,
      })),
      categories: sliceList(
        data.categories.map((row) => ({
          name: row.name,
          quantity: row.quantity,
          brokenQuantity: row.brokenQuantity,
          value: formatMoneyUz(row.value),
          healthRate: row.healthRate,
        })),
        10,
      ),
      worstLocations: sliceList(
        data.locations.byDamage
          .filter((row) => row.damageCount > 0)
          .map((row) => ({
            id: row.locationId,
            name: row.name,
            typeLabel: row.typeLabel,
            damageCount: row.damageCount,
            damageAmount: formatMoneyUz(row.damageAmount),
            healthRate: row.healthRate,
            checkRate: row.checkRate,
          })),
        8,
      ),
      topFailingItems: sliceList(
        data.items.map((row) => ({
          name: row.name,
          categoryName: row.categoryName,
          damagedQuantity: row.quantity,
          stockQuantity: row.stockQuantity,
          failureRate: row.failureRate,
          amount: formatMoneyUz(row.amount),
        })),
        8,
      ),
      trend: data.trend.slice(-6).map((row) => ({
        monthLabel: monthLabel(row.month),
        damageAmount: formatMoneyUz(row.damageAmount),
        recoveredAmount: formatMoneyUz(row.recoveredAmount),
        damageCount: row.damageCount,
      })),
      monitoringToday: {
        enabled: data.monitoring.enabled,
        reminderTime: data.monitoring.reminderTime,
        totalLocations: data.monitoring.totalLocations,
        submitted: data.monitoring.submittedToday,
        drafts: data.monitoring.draftToday,
        pending: data.monitoring.pendingToday,
      },
      debtors: {
        count: data.debtors.count,
        total: formatMoneyUz(data.debtors.total),
        overdueCount: data.debtors.overdueCount,
        overdueAmount: formatMoneyUz(data.debtors.overdueAmount),
      },
    };
  },
});

const opsInventoryIssues = defineTool({
  name: "ops_inventory_issues",
  toolset: "operations",
  label: "Inventar muammolari",
  description:
    "Actionable inventory problems right now: locations that have NOT submitted today's daily check (with responsible staff name), overdue damage charges (people who owe for damaged property past the due date), top damage debtors by remaining amount, and damages still pending (nobody charged and not waived). Also monitoring settings (daily check enabled, reminder time, photo required). Lists are bounded with totals.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async handler(args, ctx) {
    // ⚠️ `getCharges`/`getDamages` dagi `totals` holat filtrini e'tiborsiz
    // qoldiradi (aggregate `status` ni `not cancelled` bilan almashtiradi):
    // "muddati o'tgan" sanog'iga to'langanlari, "kutilayotgan zarar"
    // summasiga kechirilgan va undirilganlari qo'shilib ketadi. Shuning
    // uchun son `pagination.total` dan, kutilayotgan zarar summasi alohida
    // aggregate dan olinadi.
    const [pending, overdue, debtors, pendingDamages, pendingDamageSum, settings] = await Promise.all([
      inventoryCheckService.getPendingLocations(),
      damageChargeService.getCharges(reqLike(ctx, { overdue: "true", limit: 25 })),
      inventoryReportService.getDebtors({ limit: "15" }),
      inventoryDamageService.getDamages(reqLike(ctx, { status: "pending", limit: 15 })),
      prisma.inventoryDamage.aggregate({
        where: { status: "pending" },
        _sum: { amount: true, chargedAmount: true },
      }),
      inventorySettingsService.getSettings(),
    ]);
    const pendingDamageAmount = toDecimal(pendingDamageSum._sum.amount ?? 0).minus(
      toDecimal(pendingDamageSum._sum.chargedAmount ?? 0),
    );

    const pendingList = sliceList(pending.locations, 30);

    return {
      settings: {
        dailyCheckEnabled: settings.dailyCheckEnabled,
        reminderEnabled: settings.reminderEnabled,
        reminderTime: settings.reminderTime,
        requirePhoto: settings.requirePhoto,
      },
      dailyChecksToday: {
        dateLabel: pending.dateLabel,
        totalLocations: pending.totalLocations,
        submitted: pending.submittedCount,
        pendingCount: pending.pendingCount,
        pendingLocations: pendingList.items.map((location) => ({
          id: location.id,
          name: location.name,
          responsibleName: location.responsible ? personName(location.responsible) : null,
        })),
        truncated: pendingList.truncated,
      },
      overdueCharges: {
        count: overdue.pagination.total,
        remainingAmount: formatMoneyUz(overdue.totals.remainingAmount),
        items: overdue.data.map((charge) => ({
          id: charge.id,
          personId: charge.personId,
          personName: charge.personName,
          role: charge.personRole,
          statusLabel: charge.statusLabel,
          remainingAmount: formatMoneyUz(charge.remainingAmount),
          dueDateLabel: formatDateUz(charge.dueDate, { utc: true }),
          itemName: charge.damage?.itemName ?? null,
          locationName: charge.damage?.locationName ?? null,
        })),
        truncated: overdue.pagination.total > overdue.data.length,
      },
      debtors: {
        count: debtors.totals.count,
        totalRemaining: formatMoneyUz(debtors.totals.amount),
        items: debtors.items.map((row) => ({
          personId: row.personId,
          personName: row.personName,
          role: row.role,
          className: row.className,
          chargeCount: row.chargeCount,
          remainingAmount: formatMoneyUz(row.remainingAmount),
        })),
        truncated: debtors.totals.count > debtors.items.length,
      },
      unchargedDamages: {
        count: pendingDamages.pagination.total,
        unchargedAmount: formatMoneyUz(pendingDamageAmount),
        items: pendingDamages.data.map((damage) => ({
          id: damage.id,
          itemName: damage.itemName,
          locationName: damage.locationName,
          kindLabel: damage.kindLabel,
          reasonLabel: damage.reasonLabel,
          quantity: damage.quantity,
          amount: formatMoneyUz(damage.amount),
          occurredAtLabel: formatDateTimeUz(damage.occurredAt),
        })),
        truncated: pendingDamages.pagination.total > pendingDamages.data.length,
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// FAOLLIK
// ─────────────────────────────────────────────────────────────────────────

const opsActivityOverview = defineTool({
  name: "ops_activity_overview",
  toolset: "operations",
  label: "Faollik manzarasi",
  description:
    "Platform usage by staff and parents: bot coverage, student coverage (students with a linked parent Telegram), staff panel activity, silent staff (no login in the period, with names), classes with the lowest parent activity, channels, most used actions, parents summary (linked, active, silent, unlinked students, notifications turned off), delivery rates of broadcasts and daily reports, and rosters: students without any linked parent and silent parents. granularity day allows count 7/14/30/90 (default 30), week 4/8/12/26, month 3/6/12/24. collecting=true means history started inside the period, so low rates are not a real drop.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      granularity: {
        type: "string",
        enum: ["day", "week", "month"],
        description: "Period unit. Default day.",
      },
      count: {
        type: "integer",
        enum: [3, 4, 6, 7, 8, 12, 14, 24, 26, 30, 90],
        description: "Number of units for the granularity (see allowed combinations in the tool description).",
      },
    },
  },
  async handler(args) {
    // Controller: `getOverview({ days, granularity, count, withRoster })`; owner → withRoster
    const data = await activityDashboard.getOverview({
      granularity: args.granularity,
      count: args.count !== undefined ? String(args.count) : undefined,
      withRoster: true,
    });

    const unlinked = sliceList(data.roster.unlinked, 30);
    const silentParents = sliceList(data.roster.silentParents, 20);

    return {
      period: data.period.rangeLabel,
      collecting: data.collecting,
      historySince: data.sinceLabel,
      today: data.today,
      metrics: data.metrics.map((metric) => ({
        key: metric.key,
        label: metric.label,
        value: metric.value,
        previous: metric.previous,
        unit: metric.unit,
        hint: metric.hint,
        higherIsBetter: metric.higherIsBetter,
      })),
      channels: data.channels,
      lowestClasses: sliceList(
        data.classes.map((row) => ({
          id: row.id,
          name: row.name,
          students: row.students,
          linkedStudents: row.linkedStudents,
          linkRate: row.linkRate,
          activeParentRate: row.rate,
          silentParents: row.silent,
        })),
        8,
      ),
      topActions: data.actions
        .filter((action) => !action.outbound)
        .slice(0, 8)
        .map((action) => ({ label: action.label, count: action.count })),
      staff: {
        total: data.staff.total,
        silentTotal: data.staff.silentTotal,
        silent: data.staff.silent.map((row) => ({ id: row.id, name: row.name, role: row.role })),
        mostActive: data.staff.active.slice(0, 5).map((row) => ({
          id: row.id,
          name: row.name,
          role: row.role,
          activeDays: row.days,
          lastSeenLabel: row.lastSeenLabel,
        })),
      },
      parents: data.parents,
      delivery: data.delivery,
      studentsWithoutParentTelegram: {
        total: data.roster.unlinkedTotal,
        items: unlinked.items.map((row) => ({ id: row.id, name: row.name, className: row.className })),
        truncated: data.roster.unlinkedTotal > unlinked.items.length,
      },
      silentParents: {
        total: data.roster.silentParentsTotal,
        items: silentParents.items.map((row) => ({
          contactName: row.contactName,
          studentId: row.studentId,
          studentName: row.studentName,
          className: row.className,
          notificationsEnabled: row.notificationsEnabled,
          lastSeenLabel: row.lastSeenLabel,
          daysSince: row.daysSince,
        })),
        truncated: data.roster.silentParentsTotal > silentParents.items.length,
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// XAVFSIZLIK
// ─────────────────────────────────────────────────────────────────────────

/** Bitta foydalanuvchi kartasidagi seans (egasi `user` da — har qatorda takrorlanmaydi). */
function serializeSession(session, branchNames) {
  return {
    id: session.id,
    branchName: branchNames.get(session.branchId) ?? null,
    channel: session.channel,
    device: session.device,
    ip: session.ip,
    startedLabel: session.createdLabel,
    lastSeenLabel: session.lastSeenLabel,
    endReasonLabel: session.endReasonLabel,
    isLive: session.isLive,
  };
}

function serializeAlert(alert, branchNames) {
  return {
    id: alert.id,
    typeLabel: alert.typeLabel,
    severity: alert.severity,
    severityLabel: SEVERITY_LABELS[alert.severity] ?? alert.severity,
    status: alert.status,
    statusLabel: ALERT_STATUS_LABELS[alert.status] ?? alert.status,
    userId: alert.userId,
    name: alert.name,
    branchName: branchNames.get(alert.branchId) ?? null,
    title: alert.title,
    detail: clip(alert.detail, 300),
    hitCount: alert.hitCount,
    firstSeenLabel: alert.firstSeenLabel,
    lastSeenLabel: alert.lastSeenLabel,
    // Izoh 2000 belgigacha bo'lishi mumkin — ro'yxatda 12–15 ta ogohlantirish bor
    note: clip(alert.note, 300) || null,
  };
}

/** Kirish urinishidagi login: noma'lum foydalanuvchi urinishida u erkin matn (ko'pincha telefon). */
const attemptUsername = (username) => redactPhones(clip(username, 60)) || null;

const SECURITY_DAYS = securityDashboard.PERIODS;

const opsSecurityOverview = defineTool({
  name: "ops_security_overview",
  toolset: "operations",
  label: "Xavfsizlik manzarasi",
  description:
    "Login security across ALL branches (owner scope) for the last N days: metrics (live sessions, accounts with several simultaneous sessions, failed login rate, open alerts, devices, logins), alert counts by status/severity/type, the 12 most severe open or acknowledged alerts (with id for propose_update_security_alert; see counts for the rest), up to 10 accounts with multiple live sessions, up to 12 live sessions (device, IP, branch), login attempts by reason, top IPs and recent FAILED attempts. The platform only records and alerts; it never blocks logins by itself.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      days: {
        type: "integer",
        enum: SECURITY_DAYS,
        description: "Period in days: 7, 14, 30 or 90. Default 30.",
      },
    },
  },
  async handler(args, ctx) {
    // Controller: `getOverview({ days, actor: req.user, branch: req.branch, withDetails })`; owner → withDetails
    const [data, branchNames] = await Promise.all([
      securityDashboard.getOverview({
        days: args.days,
        actor: ctx.user,
        branch: ctx.branch,
        withDetails: true,
      }),
      loadBranchNames(),
    ]);

    // Ogohlantirishlar servisda jiddiylik bo'yicha saralangan — kesilganda
    // eng muhimlari qoladi. Ro'yxat chegaralari javobni ~10k belgida ushlaydi.
    const alerts = sliceList(data.alerts.items, 12);
    const live = sliceList(data.sessions.live, 12);
    // Servis ro'yxatni cheklamaydi (har bir hisob + uning barcha seanslari)
    const multiSession = sliceList(data.sessions.multiSession, 10);
    const failedAttempts = data.attempts.recent.filter((row) => !row.success).slice(0, 15);

    return {
      period: `${data.period.fromLabel} — ${data.period.toLabel}`,
      collecting: data.collecting,
      metrics: data.metrics.map((metric) => ({
        key: metric.key,
        label: metric.label,
        value: metric.value,
        unit: metric.unit,
        hint: metric.hint,
      })),
      alerts: {
        counts: data.alerts.counts,
        severity: data.alerts.severity,
        byType: data.alerts.byType.filter((row) => row.count > 0).map((row) => ({ label: row.label, count: row.count })),
        items: alerts.items.map((alert) => serializeAlert(alert, branchNames)),
        truncated: alerts.truncated,
      },
      multiSession: {
        total: data.sessions.multiSessionCount,
        items: multiSession.items.map((row) => ({
          userId: row.userId,
          name: row.name,
          role: row.role,
          sessions: row.sessions,
          origins: row.origins,
          devices: row.items.slice(0, 6).map((session) => `${session.device} (${session.ip || "IP noma'lum"})`),
        })),
        truncated: multiSession.truncated,
      },
      liveSessions: {
        total: data.sessions.total,
        items: live.items.map((session) => ({
          id: session.id,
          userId: session.userId,
          name: session.name,
          role: session.role,
          branchName: branchNames.get(session.branchId) ?? null,
          channel: session.channel,
          device: session.device,
          ip: session.ip,
          lastSeenLabel: session.lastSeenLabel,
        })),
        truncated: data.sessions.total > live.items.length,
      },
      attempts: {
        success: data.attempts.success,
        failed: data.attempts.failed,
        byReason: data.attempts.byReason.map((row) => ({ label: row.label, count: row.count })),
        topIps: data.attempts.topIps,
        recentFailed: failedAttempts.map((row) => ({
          username: attemptUsername(row.username),
          // Hisob topilmagan urinishda servis `name` o'rniga kiritilgan loginni qo'yadi
          name: row.userId ? row.name : attemptUsername(row.username),
          reasonLabel: row.reasonLabel,
          ip: row.ip,
          device: row.device,
          atLabel: row.createdLabel,
        })),
      },
    };
  },
});

const opsSecurityUser = defineTool({
  name: "ops_security_user",
  toolset: "operations",
  label: "Foydalanuvchi xavfsizligi",
  description:
    "Security card of ONE user (resolve with search_people first): live sessions across branches (device, IP, branch, last seen), ended sessions history (last 50 sessions, live ones excluded) with end reasons, devices used, login attempts in the period (success/failure reason, IP) and security alerts. Use before propose_revoke_user_sessions.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["userId"],
    properties: {
      userId: idSchema("User id."),
      days: {
        type: "integer",
        enum: SECURITY_DAYS,
        description: "Login attempts period in days: 7, 14, 30 or 90. Default 30.",
      },
    },
  },
  async handler(args, ctx) {
    const userId = requireId(args.userId, "userId");
    const [data, branchNames] = await Promise.all([
      securityDashboard.getUserSecurity(userId, { actor: ctx.user, branch: ctx.branch, days: args.days }),
      loadBranchNames(),
    ]);

    // Tarix ochiq seanslarni ham o'z ichiga oladi — ular `liveSessions` da
    // bor, takrorlash modelga bir seansni ikki marta sanatib qo'yardi.
    const live = sliceList(data.live, 20);
    const history = sliceList(data.history.filter((session) => !session.isLive), 15);
    const attempts = sliceList(data.attempts, 20);
    const alerts = sliceList(data.alerts, 15);

    return {
      user: {
        id: data.user.id,
        name: data.user.name,
        username: data.user.username ?? null,
        role: data.user.role ?? null,
      },
      isCurrentOwner: data.user.id === ctx.user.id,
      liveSessions: {
        items: live.items.map((session) => serializeSession(session, branchNames)),
        total: live.total,
        truncated: live.truncated,
      },
      history: {
        items: history.items.map((session) => serializeSession(session, branchNames)),
        total: history.total,
        truncated: history.truncated,
      },
      devices: data.devices.map((row) => ({
        device: row.device,
        sessions: row.count,
        lastLabel: formatDateTimeUz(row.lastAt),
      })),
      attempts: {
        items: attempts.items.map((row) => ({
          success: row.success,
          reasonLabel: row.reasonLabel,
          ip: row.ip,
          device: row.device,
          atLabel: row.createdLabel,
        })),
        total: attempts.total,
        truncated: attempts.truncated,
      },
      alerts: {
        items: alerts.items.map((alert) => serializeAlert(alert, branchNames)),
        total: alerts.total,
        truncated: alerts.truncated,
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// O'ZGARISHLAR TARIXI
// ─────────────────────────────────────────────────────────────────────────

const opsChangelogRecent = defineTool({
  name: "ops_changelog_recent",
  toolset: "operations",
  label: "O'zgarishlar tarixi",
  description:
    "Recent platform release notes (changelog, shared by all branches), newest first: panel, version, date, title and the change items in plain Uzbek business language. Optional panel filter (admin, teacher, student, server, bot). Use for 'what changed in the system recently'.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      panel: {
        type: "string",
        enum: PANELS,
        description: "Only this panel's releases.",
      },
      limit: limitSchema(30, "Maximum releases to return."),
    },
  },
  async handler(args, ctx) {
    const result = await changelogService.getChangelogs(
      reqLike(ctx, { panel: args.panel, limit: args.limit ?? 10 }),
    );

    if (result.pagination.total === 0) {
      return { empty: true, reason: "O'zgarishlar tarixida yozuv yo'q", items: [], total: 0, truncated: false };
    }

    const items = fitToBudget(
      result.data.map((entry) => ({
        panel: entry.panel,
        panelLabel: PANEL_LABELS[entry.panel] ?? entry.panel,
        version: entry.version,
        dateLabel: formatDateUz(entry.date, { utc: true }),
        title: entry.title || null,
        items: (entry.items || []).slice(0, 10).map((item) => clip(item, 240)),
        moreItems: Math.max(0, (entry.items || []).length - 10),
      })),
    );

    return {
      items,
      total: result.pagination.total,
      truncated: result.pagination.total > items.length,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// DO'KON
// ─────────────────────────────────────────────────────────────────────────

const opsMarketOrders = defineTool({
  name: "ops_market_orders",
  toolset: "operations",
  label: "Do'kon buyurtmalari",
  description:
    "Coin shop (market) orders placed by students, newest first, optionally by status. Prices are in COINS, not so'm. Returns counts per status (with pendingCoins held by pending/delivering orders) and items {id, statusLabel, student {id, name, classNames, coinBalance}, product {id, name, stockLeft}, quantity, totalPrice, rejectReason, createdAtLabel, lastChangeLabel}. Owner flow: pending → delivering → approved, or pending → rejected (refunds coins and restocks).",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: {
        type: "string",
        enum: MARKET_STATUSES,
        description: "pending, delivering, approved (delivered), rejected, cancelled (by the student).",
      },
      limit: limitSchema(50),
    },
  },
  async handler(args) {
    const limit = args.limit ?? 20;
    const [result, statusRows, held] = await Promise.all([
      // Controller: `getAdminOrders(req.query)`
      marketService.getAdminOrders({ page: "1", limit: String(limit), status: args.status ?? "" }),
      prisma.marketOrder.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.marketOrder.aggregate({
        where: { status: { in: ["pending", "delivering"] } },
        _sum: { totalPrice: true },
      }),
    ]);
    const counts = countBy(statusRows, "status");
    const items = marketItems(result.data);

    return {
      summary: {
        byStatus: MARKET_STATUSES.map((status) => ({
          status,
          label: MARKET_STATUS_LABELS[status],
          count: counts[status] ?? 0,
        })),
        pendingCoins: held._sum.totalPrice ?? 0,
      },
      items,
      total: result.pagination.totalItems,
      truncated: result.pagination.totalItems > items.length,
      ...(result.pagination.totalItems === 0 ? { empty: true, reason: "Filtr bo'yicha buyurtma yo'q" } : {}),
    };
  },
});

/** Buyurtmalar ro'yxati — hajm byudjeti ichida (rad etish sababi erkin matn). */
function marketItems(orders) {
  return fitToBudget(
    orders.map((order) => {
      const last = order.statusHistory[order.statusHistory.length - 1];
      return {
        id: order.id,
        status: order.status,
        statusLabel: MARKET_STATUS_LABELS[order.status] ?? order.status,
        student: order.student
          ? {
              id: order.student.id,
              name: personName(order.student),
              classNames: order.student.classes.map((cls) => cls.name),
              coinBalance: order.student.coinBalance,
            }
          : null,
        product: {
          id: order.productId,
          name: order.product?.name ?? order.productSnapshot?.name ?? "Noma'lum mahsulot",
          stockLeft: order.product?.quantity ?? null,
        },
        quantity: order.quantity,
        unitPrice: order.unitPrice,
        totalPrice: order.totalPrice,
        rejectReason: clip(order.rejectReason || null, 200),
        createdAtLabel: formatDateTimeUz(order.createdAt),
        lastChangeLabel: last ? formatDateTimeUz(last.changedAt) : null,
      };
    }),
  );
}

module.exports = [
  opsTasks,
  opsTask,
  opsLeadsAnalytics,
  opsLeads,
  opsMessages,
  opsMessageQueue,
  opsInventoryOverview,
  opsInventoryIssues,
  opsActivityOverview,
  opsSecurityOverview,
  opsSecurityUser,
  opsChangelogRecent,
  opsMarketOrders,
];
