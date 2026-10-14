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
const { config } = require("../config/env.config");
const pushService = require("./push.service");
// ⚠️ BIR TOMONLAMA ZANJIR: bu modul `issue.service` ni import QILMAYDI,
// ko'prik esa `task.service` ni — aks holda aylanma import paydo bo'lardi
// (sabab `issueTask.service.js` boshidagi izohda).
const issueTaskService = require("./issueTask.service");
const { getBranch } = require("../config/branchContext");
const {
  TASK_PUSH_EVENTS,
  buildTaskPush,
} = require("../helpers/taskPush.helpers");
// Vaqt oynasi, tur va havolalar — YAGONA manba (`taskWindow.helpers.js`):
// ro'yxat, dashboard, ijrochi paneli va "Men ketdim" darvozasi shundan o'qiydi.
const {
  WORKING_STATUSES,
  TASK_KINDS,
  normalizeKind,
  normalizeLinks,
  resolveTimeState,
  buildStateWhere,
} = require("../helpers/taskWindow.helpers");
const taskScopeService = require("./taskScope.service");
// Sana MATNI — yagona manba (`dates.md` §2). `dueDate`/`startDate` — INSTANT,
// shuning uchun `utc` bayrog'isiz.
const { formatDateTimeUz } = require("../helpers/date.helpers");

// ─── KONSTANTALAR ──────────────────────────────────────────────────

const ACTIVE_STATUSES = ["pending", "extended", "pending_rejected", "pending_review"];
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
    // ⚠️ DOIMIY TOPSHIRIQ QOIDASI HAM SHU FAYLGA ISHORA QILADI. Faqat
    // topshiriqlar sanalsa, qoidadan yaratilgan yagona topshiriqni
    // o'chirish qoidaning namuna faylini saqlashdan BUTUNLAY o'chirib
    // yuborardi — keyingi hafta yoziladigan topshiriqlar esa o'lik
    // havolaga ishora qilib qolardi.
    const [usedByTask, usedBySchedule] = await Promise.all([
      prisma.task.count({
        where: {
          id: { not: excludeTaskId },
          attachments: { array_contains: [{ key: attachment.key }] },
        },
      }),
      prisma.taskSchedule.count({
        where: { attachments: { array_contains: [{ key: attachment.key }] } },
      }),
    ]);
    if (usedByTask === 0 && usedBySchedule === 0) orphaned.push(attachment);
  }
  await deleteAttachments(orphaned);
};

const _nextStatusPosition = (taskId) =>
  prisma.taskStatusHistory.count({ where: { taskId } });

// _applyPenalty jarima yaratadi, foydalanuvchi ballarini oshiradi va jarima hujjatini
// qaytaradi. Chaqiruvchi task.penaltyRef/autopenalized ni o'z update data'siga qo'shadi.
const _applyPenalty = async (task, points, reason, givenById) => {
  // ⚠️ SHAXSIY TOPSHIRIQDA JARIMA YO'Q (biznes qarori) — va tekshiruv AYNAN
  // SHU YERDA, chaqiruvchida emas: jarima yozadigan yo'l bitta bo'lgani
  // uchun yangi yo'l qo'shilganda ham qoida o'z-o'zidan amal qiladi
  // (`postEntry` doktrinasi). Chaqiruvchilar baribir oldindan to'sadi,
  // bu — zaxira qavat.
  if (task.selfAssigned) {
    throw new BadRequestError("O'ziga belgilagan topshiriq uchun jarima yozilmaydi");
  }

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
  // ⚠️ HAJM CHEGARASI PANELGA HAM BERILADI. Usiz panel katta faylni
  // yuborib qo'yardi va foydalanuvchi "CORS xatosi" ni ko'rardi: hajm
  // chegarasiga urilgan so'rovni oldingi qavat (proksi) rad etadi va
  // uning javobida CORS sarlavhalari bo'lmaydi — brauzer esa haqiqiy
  // sababni o'qiy olmaydi.
  maxFileSizeMb: config.maxUploadFileSizeMb,
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

/** Ixtiyoriy sana: bo'sh qiymat — `null` (maydon berilmagan). */
const _parseOptionalDate = (value, label) => {
  if (value === undefined || value === null || value === "") return null;
  return _parseDate(value, label);
};

const _assertKind = (value) => {
  if (value === undefined || value === null || value === "") return "main";
  const kind = String(value);
  if (!TASK_KINDS.includes(kind)) {
    throw new BadRequestError("Topshiriq turi noto'g'ri");
  }
  return kind;
};

/**
 * Ro'yxatga/javobga qo'shiladigan HOSILA maydon: topshiriq hozir qaysi
 * bosqichda (`taskWindow.helpers.js`). Saqlanmaydi — har o'qishda
 * hisoblanadi, shuning uchun muddat uzaytirilishi bilan ✗ o'z-o'zidan
 * yo'qoladi.
 */
const _withTimeState = (task, now) => ({
  ...task,
  timeState: resolveTimeState(task, now),
});

/**
 * @param {string[]} ids
 * @param {{ self?: boolean }} [options] - `self: true` — xodim O'ZIGA
 *   yozyapti. U paytda "ownerga topshiriq berib bo'lmaydi" sharti
 *   QO'LLANMAYDI: o'sha shart owner IJROCHI emas, TOPSHIRIQ BERUVCHI
 *   bo'lgani uchun bor — o'zi o'ziga yozgan rejada esa beruvchi ham,
 *   ijrochi ham o'sha odam. Arxivlangan shart joyida qoladi (zaxira
 *   qavat: arxivlangan odam tizimga kira olmaydi).
 */
const _assertAssignableUsers = async (ids, { self = false } = {}) => {
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, role: true, isArchived: true, firstName: true, lastName: true },
  });
  if (users.length !== ids.length) {
    throw new BadRequestError("Ba'zi foydalanuvchilar topilmadi");
  }
  if (!self && users.some((u) => u.role === "owner")) {
    throw new BadRequestError("Tizim egasiga topshiriq berib bo'lmaydi");
  }
  if (users.some((u) => u.isArchived)) {
    throw new BadRequestError("Arxivlangan foydalanuvchiga topshiriq berib bo'lmaydi");
  }
  return users;
};

// ─── ASOSIY FUNKSIYALAR ────────────────────────────────────────────

/**
 * TOPSHIRIQ QATORLARINI YOZADIGAN YAGONA JOY.
 *
 * Qo'lda berilgan topshiriq ham, doimiy qoidadan avtomat yaratilgani ham
 * (`taskSchedule.service.js`) shu yerdan o'tadi: qator shakli, boshlang'ich
 * holat va vaqt chizig'ining birinchi qatori bir xil bo'lishi kerak. Ikkita
 * yozuvchi bo'lsa, avtomat topshiriqlar tarixsiz paydo bo'lardi.
 *
 * HAR BIR IJROCHIGA ALOHIDA topshiriq: har kimning o'z holati, muddati,
 * natijasi va jarimasi bor. ⚠️ Fayllar hamma nusxada UMUMIY (bir marta
 * yuklanadi) — o'chirishda `_deleteUnsharedAttachments` shuni hisobga oladi.
 *
 * @param {object} params
 * @param {string[]} params.assigneeIds
 * @param {string} params.createdBy
 * @param {object} params.fields - qatorning qolgan maydonlari
 * @param {boolean} [params.atomic=true] - `true`: hammasi bitta
 *   tranzaksiyada (40 kishidan 25-sida xato chiqsa, yarmi berilgan holat
 *   qolmaydi). `false`: har qator alohida — cron uchun, bitta buzuq qator
 *   butun passni orqaga qaytarmasligi kerak.
 * @param {boolean} [params.skipDuplicates=false] - takrorni (yagona indeks)
 *   xato emas, "allaqachon bor" deb o'tkazadi — cron idempotentligi.
 * @returns {Promise<object[]>} yozilgan qatorlar
 */
const writeTaskRows = async ({
  assigneeIds,
  createdBy,
  fields,
  atomic = true,
  skipDuplicates = false,
  now = new Date(),
}) => {
  const data = (assigneeId) => ({
    ...fields,
    assignee: assigneeId,
    createdBy,
    status: "pending",
    statusHistory: {
      create: [
        {
          status: "pending",
          reason: "Topshiriq yaratildi",
          changedBy: createdBy,
          changedAt: now,
          position: 0,
        },
      ],
    },
  });

  if (atomic) {
    return prisma.$transaction(
      async (tx) => {
        const created = [];
        for (const assigneeId of assigneeIds) {
          created.push(await tx.task.create({ data: data(assigneeId) }));
        }
        return created;
      },
      { timeout: Math.max(15000, assigneeIds.length * 200), maxWait: 10000 },
    );
  }

  const created = [];
  for (const assigneeId of assigneeIds) {
    try {
      created.push(await prisma.task.create({ data: data(assigneeId) }));
    } catch (error) {
      // P2002 — yagona indeks: shu kunga topshiriq allaqachon yozilgan
      if (skipDuplicates && error?.code === "P2002") continue;
      throw error;
    }
  }
  return created;
};

const createTasks = async ({
  title,
  description,
  // VAQT ORALIG'I: `startDate` ixtiyoriy. Berilmasa topshiriq avvalgidek
  // "shu vaqtgacha bajaring" bo'lib qoladi (`taskWindow.helpers.js`).
  startDate,
  dueDate,
  // "main" (asosiy) | "extra" (qo'shimcha)
  kind,
  // [{ url, label }] — fayl bilan bir qatorda tashqi manba
  links,
  penaltyPoints,
  assigneeIds,
  createdBy,
  files,
  // KIM BERYAPTI — `tasks.team` bo'lsa faqat o'z bo'limiga (taskScope).
  // `undefined` → tekshirilmaydi (ichki chaqiruv: muammodan topshiriq).
  scope,
  // MANBA MUAMMO — botdan kelgan muammoni hal qilish uchun berilgan
  // topshiriqda to'ladi (`issue.service#assignTasks`). Oddiy topshiriqda
  // `undefined` va ustun `null` bo'lib qoladi: topshiriqlar bo'limining
  // o'z oqimi o'zgarmaydi.
  issueId,
  // XODIM O'ZIGA O'ZI YOZYAPTI (`selfTask.service.js`). Uchta farqni
  // AYNAN SHU YERDA majburlaydi: ijrochi yaratuvchining O'ZI, jarima bali
  // 0 va push yo'q. Panel yoki chaqiruvchiga ishonilmaydi.
  selfAssigned = false,
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

  // ⚠️ BOSHLANISH VAQTI O'TMISHDA BO'LISHI MUMKIN: "soat 13:00 dan 15:00
  // gacha" degan topshiriq 13:20 da ham beriladi. Yagona shart — oraliq
  // teskari bo'lmasligi. Minimal muddat (`minLeadHours`) FAQAT `dueDate` ga
  // tegishli: haqiqiy muddat o'sha (`taskWindow.helpers.js`).
  const start = _parseOptionalDate(startDate, "Boshlanish vaqti");
  if (start && start.getTime() >= due.getTime()) {
    throw new BadRequestError("Boshlanish vaqti ijro muddatidan oldin bo'lishi kerak");
  }

  const taskKind = _assertKind(kind);
  const taskLinks = normalizeLinks(links, (msg) => new BadRequestError(msg));

  // ⚠️ SHAXSIY TOPSHIRIQDA JARIMA BALI 0 — sozlamadagi standart ball ham,
  // panel yuborgan qiymat ham olinmaydi. `_assertPenaltyPoints` kamida 1
  // ni talab qiladi (rahbar bergan ish uchun to'g'ri), shuning uchun u
  // umuman chaqirilmaydi.
  const points = selfAssigned
    ? 0
    : _assertPenaltyPoints(penaltyPoints ?? settings.defaultPenaltyPoints, settings);

  if (settings.requireCreateAttachments && (!files || files.length === 0)) {
    throw new BadRequestError("Topshiriqqa kamida bitta fayl biriktirish kerak");
  }
  if (files && files.length > TASK_ATTACHMENTS_MAX) {
    throw new BadRequestError(`Ko'pi bilan ${TASK_ATTACHMENTS_MAX} ta fayl biriktirish mumkin`);
  }

  // ⚠️ SHAXSIY TOPSHIRIQ — FAQAT O'ZIGA. Ro'yxat bitta va u aynan
  // yaratuvchi bo'lishi shart: aks holda "o'ziga belgilash" yo'li
  // ruxsatlarni chetlab o'tib birovga jarimasiz topshiriq berish yo'liga
  // aylanardi.
  if (selfAssigned) {
    if (assigneeIds.length !== 1 || String(assigneeIds[0]) !== String(createdBy)) {
      throw new BadRequestError("O'ziga belgilanadigan topshiriqni faqat o'zingizga yozishingiz mumkin");
    }
  }

  const [actor] = await _assertAssignableUsers(assigneeIds, { self: selfAssigned });

  // ⚠️ O'QUVCHI SHAXSIY TOPSHIRIQ YOZMAYDI: bu bo'lim XODIMLARNING o'z
  // ishi uchun (dashboard ham "xodimlar o'ziga belgilagan" deb o'qiladi) va
  // o'quvchi tomonida tanga/jarima bilan ishlaydigan boshqa mexanizmlar bor.
  if (selfAssigned && actor?.role === ROLES.STUDENT) {
    throw new ForbiddenError("O'quvchi o'ziga topshiriq belgilay olmaydi");
  }

  // Rahbar (`tasks.team`) faqat o'z bo'limiga — ro'yxat har yaratishda
  // qayta tekshiriladi, panel tugmasiga ishonilmaydi. Shaxsiy yo'lda doira
  // umuman berilmaydi: ijrochi baribir o'zining o'zi.
  if (scope && !selfAssigned) taskScopeService.assertCanAssign(assigneeIds, scope);

  let attachments = [];
  if (files && files.length > 0) {
    attachments = await uploadAttachments(files);
  }

  let tasks;
  try {
    tasks = await writeTaskRows({
      assigneeIds,
      createdBy,
      fields: {
        title: cleanTitle,
        description: cleanDescription,
        startDate: start,
        dueDate: due,
        kind: taskKind,
        links: taskLinks,
        penaltyPoints: points,
        attachments,
        issueId: issueId ?? null,
        selfAssigned,
      },
    });
  } catch (error) {
    // Yozuv bo'lmadi — yuklangan fayllar yetim qolmasin
    await deleteAttachments(attachments);
    throw error;
  }

  // ⚠️ O'ZIGA YOZGANIGA PUSH YUBORILMAYDI: odam shu zahoti formani to'ldirib
  // chiqdi, "sizga yangi topshiriq berildi" xabari faqat shovqin bo'lardi.
  if (!selfAssigned) _notifyAssignees(TASK_PUSH_EVENTS.CREATED, tasks);

  return tasks;
};

/**
 * Ro'yxat filtri. `due` — status emas, VAQT kesimi:
 *   overdue  — faol va muddati o'tgan
 *   due_soon — faol va muddati `dueSoonHours` ichida
 */
const _buildListFilter = async (query, { selfAssigned = false } = {}) => {
  const { status, assigneeId, createdBy, startDate, endDate, search, due, kind, state } =
    query;

  // ⚠️ IKKI OQIM BIR JADVALDA, LEKIN ARALASHMAYDI. Rahbar bergan topshiriq
  // (`false`) va xodim o'ziga belgilagani (`true`) — har so'rov ANIQ bir
  // tomonni oladi. Filtrsiz qoldirilsa, jarimasiz va o'zi yopiladigan
  // shaxsiy topshiriqlar Lavozimlar markazining bajarilish foizini jimgina
  // ko'tarib yuborardi.
  const filter = { selfAssigned };
  if (status && status !== "all") filter.status = status;
  if (assigneeId && assigneeId !== "all") filter.assignee = assigneeId;
  if (createdBy && createdBy !== "all") filter.createdBy = createdBy;
  if (kind && kind !== "all") filter.kind = normalizeKind(kind);
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

  // VAQT HOLATI kesimi (dashboarddan kelinadigan filtr): bajarildi /
  // bajarilmadi / jarayonda / hozir vaqti. `status` bilan birga berilsa
  // ikkalasi ham amal qiladi — biri ikkinchisini jimgina bekor qilmaydi.
  // ⚠️ `AND` bilan BIRLASHTIRILADI, ustiga yozilmaydi: "Tekshiruvda" statusi
  // bilan "Bajarilmadi" kesimi tanlansa natija bo'sh bo'lishi KERAK, biri
  // ikkinchisini jimgina bekor qilib qo'ymasligi (`devices.md` §10 — ikki
  // holat filtri bir-birini inkor qilgan holat).
  const stateWhere = state && state !== "all" ? buildStateWhere(state, now) : null;
  return stateWhere ? { AND: [filter, stateWhere] } : filter;
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
const getTasks = async (req, scope, { selfAssigned = false } = {}) => {
  const { page, limit, skip } = getPaginationParams(req);
  const base = await _buildListFilter(req.query, { selfAssigned });
  // Rahbar (`tasks.team`) — faqat o'z bo'limi; `tasks.view` — butun filial
  const filter = taskScopeService.applyScope(base, scope);
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

  const now = new Date();
  const tasks = await _attachListRefs(
    rows.map(({ _count, ...t }) =>
      _withTimeState(
        {
          ...t,
          extensionsCount: _count.deadlineHistory,
          attachmentsCount: Array.isArray(t.attachments) ? t.attachments.length : 0,
          completionAttachmentsCount: Array.isArray(t.completionAttachments)
            ? t.completionAttachments.length
            : 0,
          linksCount: Array.isArray(t.links) ? t.links.length : 0,
        },
        now,
      ),
    ),
    { withAssignee: true },
  );

  return formatPaginationResponse(tasks, total, page, limit);
};

/**
 * "Asosiy" tab tepasidagi jonli hisoblagichlar (davrga bog'liq emas).
 * @returns {Promise<object>}
 */
const getTaskStats = async (scope, { selfAssigned = false } = {}) => {
  const settings = await getTaskSettings();
  const now = new Date();
  const soon = new Date(now.getTime() + settings.dueSoonHours * HOUR_MS);
  // Oqim kesimi HAR BIR sanoqchiga qo'shiladi (`_buildListFilter` bilan
  // AYNI sabab): ikki oqim bir jadvalda yashaydi
  const scoped = (where) => taskScopeService.applyScope({ ...where, selfAssigned }, scope);

  const [groups, kindGroups, overdue, dueSoon, activeNow, upcoming] = await Promise.all([
    prisma.task.groupBy({ by: ["status"], where: scoped({}), _count: { _all: true } }),
    prisma.task.groupBy({ by: ["kind"], where: scoped({}), _count: { _all: true } }),
    prisma.task.count({
      where: scoped({ status: { in: WORKING_STATUSES }, dueDate: { lt: now } }),
    }),
    prisma.task.count({
      where: scoped({ status: { in: WORKING_STATUSES }, dueDate: { gte: now, lte: soon } }),
    }),
    // HOZIR BAJARILISH VAQTI — oraliq ichidagi topshiriqlar (ijrochi
    // panelida qizil bo'lib turadiganlar)
    prisma.task.count({
      where: scoped(buildStateWhere("active", now)),
    }),
    prisma.task.count({
      where: scoped(buildStateWhere("upcoming", now)),
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

  const byKind = { main: 0, extra: 0 };
  for (const g of kindGroups) {
    if (g.kind in byKind) byKind[g.kind] = g._count._all;
  }

  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

  return {
    total,
    byStatus,
    byKind,
    inProgress: byStatus.pending + byStatus.extended + byStatus.pending_rejected,
    review: byStatus.pending_review,
    completed: byStatus.completed,
    stopped: byStatus.stopped,
    // ⚠️ `overdue` — AYNAN "bajarilmadi" (✗): muddat o'tdi, ish topshirilmadi
    overdue,
    missed: overdue,
    dueSoon,
    activeNow,
    upcoming,
    dueSoonHours: settings.dueSoonHours,
  };
};

/**
 * IJROCHINING O'Z TOPSHIRIQLARI.
 *
 * `state` — vaqt kesimi (bajarildi / bajarilmadi / hozir vaqti / ...),
 * `kind` — asosiy yoki qo'shimcha. Ikkalasi ham SQL darajasida: panel
 * sahifalangan ro'yxatni xotirada filtrlasa, ikkinchi sahifadagi topshiriq
 * "yo'q" bo'lib ko'rinardi.
 *
 * ⚠️ `sort` berilmasa tartib AVVALGICHA (yangilari tepada) — mobil ilova
 * ham shu yo'ldan o'qiydi.
 *
 * ⚠️ `selfAssigned` SUKUTDA `false`: bu ekran "MENGA BERILGAN topshiriqlar".
 * Xodim o'ziga o'zi belgilaganlari ALOHIDA ro'yxatda
 * (`selfTask.service.js`, `/self-tasks`) — ular jarimasiz va o'zi
 * yopiladigan boshqa oqim, bir ro'yxatda aralashsa "bu ishni menga kim
 * berdi" degan savol javobsiz qolardi. Mavjud mobil ilova shu yo'ldan
 * o'qiydi va sukut uning uchun ham o'zgarmaydi.
 */
const getMyTasks = async (userId, req, { selfAssigned = false } = {}) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { status, kind, state } = req.query;
  const now = new Date();

  const base = { assignee: userId, selfAssigned };
  if (status && status !== "all") base.status = status;
  if (kind && kind !== "all") base.kind = normalizeKind(kind);

  const stateWhere = state && state !== "all" ? buildStateWhere(state, now) : null;
  const filter = stateWhere ? { AND: [base, stateWhere] } : base;

  // ⚠️ Sozlamalar ro'yxat bilan BIR VAQTDA o'qiladi: "Topshiriqlarim" eng
  // ko'p ochiladigan ekran, ketma-ket so'rov unga ortiqcha kechikish
  // qo'shardi.
  const [rows, total, settings] = await Promise.all([
    prisma.task.findMany({
      where: filter,
      orderBy: LIST_SORTS[req.query.sort] || LIST_SORTS.newest,
      skip,
      take: limit,
    }),
    prisma.task.count({ where: filter }),
    getTaskSettings(),
  ]);

  const tasks = await _attachListRefs(
    rows.map((t) =>
      _withTimeState(
        {
          ...t,
          attachmentsCount: Array.isArray(t.attachments) ? t.attachments.length : 0,
          linksCount: Array.isArray(t.links) ? t.links.length : 0,
        },
        now,
      ),
    ),
    { withAssignee: false },
  );

  return {
    ...formatPaginationResponse(tasks, total, page, limit),
    // ⚠️ RO'YXAT BILAN BIRGA: ijrochi ishni ro'yxatdan chiqmasdan
    // topshiradi, ya'ni yakunlash qoidalari (nechta fayl, izoh majburiymi)
    // unga SHU YERDA kerak. Bir marta yuboriladi — har qatorga nusxalash
    // 20 ta bir xil obyekt bo'lardi; detal sahifadagi `submissionRules`
    // bilan AYNI manba (`_submissionRules`).
    submissionRules: _submissionRules(settings),
  };
};

const _canManage = (user) =>
  hasRole(user, ROLES.OWNER) || hasPermission(user.permissions || [], "tasks.view");

/**
 * BOSHQARUV AMALI DOIRASI. `tasks.team` bilan kelgan rahbar faqat o'z
 * bo'limidagi topshiriqni tahrirlaydi / tasdiqlaydi / to'xtatadi.
 *
 * ⚠️ HAR AMALDA, route'da emas: route faqat "kalit bormi" deb tekshiradi,
 * "aynan BU topshiriq meniki emasligini" esa shu yer hal qiladi.
 */
const _assertScope = (task, scope, userId) => {
  // ⚠️ FAQAT `team` va `self` rejimida cheklaydi: `tasks.review` /
  // `tasks.stop` kabi mavjud kalitlar avvalgidek butun filialda ishlaydi —
  // `tasks.team` QO'SHIMCHA daraja, kuchsizlantirish emas.
  if (!scope) return;

  // SHAXSIY YO'L (`selfTask.service.js`): qator xodimning O'ZI o'ziga
  // belgilagani bo'lishi shart. Shu tufayli tahrirlash / to'xtatish /
  // muddat surish / qayta ochish / o'chirish uchun ikkinchi nusxa
  // yozilmadi — AYNI funksiyalar, faqat doira boshqa.
  if (scope.mode === taskScopeService.SCOPE_SELF) {
    if (!taskScopeService.isInScope(task, scope, userId)) {
      throw new ForbiddenError("Bu sizning o'zingizga belgilagan topshirig'ingiz emas");
    }
    return;
  }

  if (scope.mode !== taskScopeService.SCOPE_TEAM) return;
  if (!taskScopeService.isInScope(task, scope, userId)) {
    throw new ForbiddenError("Bu topshiriq sizning bo'limingizga tegishli emas");
  }
};

/**
 * @param {string} taskId
 * @param {object} requestingUser
 * @param {object} [scope] - `taskScope.service.js` natijasi. Berilsa rahbar
 *   (`tasks.team`) o'z bo'limidagi topshiriqni ham ko'ra oladi.
 */
const getTaskById = async (taskId, requestingUser, scope) => {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      statusHistory: { orderBy: { position: "asc" } },
      deadlineHistory: { orderBy: { position: "asc" } },
      // MANBA MUAMMO — topshiriq botdan kelgan murojaatni hal qilish
      // uchun berilgan bo'lsa. IJROCHIGA KERAK: tavsifda matn ko'chirilgan
      // bo'lsa ham, u kimdan kelganini va qaysi yo'nalish ekanini bilishi
      // kerak. Oddiy topshiriqda `null`.
      issue: {
        select: {
          id: true,
          body: true,
          status: true,
          authorKind: true,
          createdAt: true,
          category: { select: { name: true } },
        },
      },
    },
  });

  if (!task) {
    throw new NotFoundError("Topshiriq topilmadi");
  }

  // SHAXSIY YO'L (`/self-tasks/:id`): qator aynan shu odamning o'ziga
  // belgilagani bo'lishi shart. ⚠️ Usiz panel o'ziga BERILGAN oddiy
  // topshiriqni ham shaxsiy ekranda ochib, jarimasiz yopish tugmasini
  // ko'rsatib qo'yardi.
  if (scope?.mode === taskScopeService.SCOPE_SELF) {
    _assertScope(task, scope, requestingUser.id);
  }

  const isAssignee = String(task.assignee) === String(requestingUser.id);
  const canManage =
    _canManage(requestingUser) ||
    // ⚠️ `self` CHIQARIB TASHLANADI: shaxsiy yo'ldan kelgan odam o'z
    // qatorining EGASI, boshqaruvchi emas — unga ijrochi intizomi
    // (`assigneeStats`) va boshqaruv maydonlari berilmaydi.
    (scope &&
      scope.mode !== taskScopeService.SCOPE_NONE &&
      scope.mode !== taskScopeService.SCOPE_SELF &&
      taskScopeService.isInScope(task, scope, requestingUser.id));

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

  // Hosila: hozir qaysi bosqichda (oraliq ichidami, muddati o'tdimi)
  task.timeState = resolveTimeState(task, new Date());

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

/**
 * IJROCHI ISHNI TOPSHIRADI.
 *
 * ⚠️ SHAXSIY TOPSHIRIQ DARHOL YAKUNLANADI (biznes qarori): "Tekshiruvda"
 * bosqichi o'tkazib yuboriladi, chunki ikkinchi tomon yo'q — odam o'ziga
 * o'zi yozgan ishni o'zi yopadi. Aks holda rahbarlarning tasdiqlash
 * navbati birovning shaxsiy rejasi bilan to'lib ketardi, holbuki u na
 * jarima beradi, na birovga majburiyat yuklaydi.
 *
 * ⚠️ YAKUNLASH QOIDALARI (nechta fayl, izoh majburiymi, kech topshirish)
 * IKKI OQIMDA BIR XIL: ular `_assertSubmission` dan o'tadi, shuning uchun
 * shaxsiy topshiriq uchun ikkinchi tekshiruv ro'yxati yozilmadi.
 */
const submitTaskCompletion = async (taskId, userId, { note, files, scope }) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq topilmadi");

  if (String(task.assignee) !== String(userId)) {
    throw new ForbiddenError("Bu topshiriqni yangilashga ruxsat yo'q");
  }

  // ⚠️ SHAXSIY YO'LDAN (`/self-tasks/:id/complete`) FAQAT SHAXSIY QATOR
  // yopiladi: usiz xodim o'ziga BERILGAN oddiy topshiriqni ham shu
  // yo'ldan jo'natib, rahbar tasdig'ini chetlab o'tib yopib qo'ya olardi.
  // Oddiy yo'l (`/tasks/:id/submit`) doira yubormaydi va o'zgarmaydi.
  _assertScope(task, scope, userId);

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
  const nextStatus = task.selfAssigned ? "completed" : "pending_review";

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      completionNote: cleanNote,
      completionAttachments: newAttachments,
      status: nextStatus,
      statusHistory: {
        create: {
          status: nextStatus,
          reason:
            cleanNote ||
            (task.selfAssigned ? "O'ziga belgilagan topshiriq yakunlandi" : "Topshiriq bajarildi"),
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

const approveTask = async (taskId, { reason, approvedBy, scope }) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq topilmadi");
  _assertScope(task, scope, approvedBy);

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

  // ⚠️ KUTILADI, lekin XATO TASHLAMAYDI (ko'prikning o'zi yutadi):
  // muammoni yopish natijasi javobdan oldin tayyor bo'lishi kerak, aks
  // holda panel eski holatni qayta so'rab olardi.
  await issueTaskService.onTaskCompleted(updated);

  return updated;
};

const rejectTask = async (taskId, { reason, rejectedBy, newDueDate, scope }) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq topilmadi");
  _assertScope(task, scope, rejectedBy);

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
  { reason, withPenalty, penaltyPoints, stoppedBy, scope },
) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq topilmadi");
  _assertScope(task, scope, stoppedBy);

  if (!ACTIVE_STATUSES.includes(task.status)) {
    throw new BadRequestError("Bu topshiriqni to'xtatib bo'lmaydi");
  }

  const data = {};
  let appliedPoints = 0;

  // ⚠️ SHAXSIY TOPSHIRIQ — JARIMASIZ. Panel bayroqni umuman yubormaydi,
  // lekin qaror shu yerda: `_applyPenalty` ham zaxira qavat sifatida rad
  // etadi, bu esa "to'xtatdim-u, nega jarima oldim" holatini aniq xato
  // o'rniga JIM o'tkazib yuborish bilan almashtiradi.
  if (withPenalty && !task.selfAssigned && !task.autopenalized) {
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

  // ⚠️ PUSH FAQAT BOSHQA ODAM AMAL QILGANDA. Shaxsiy topshiriqni o'zi
  // to'xtatadi — "topshirig'ingiz to'xtatildi" xabari o'ziga qaytib
  // kelishi shovqin bo'lardi. (Doimiy qoidadan ERTALAB yoziladigan
  // topshiriqda push BOR va u o'rinli: u paytda amalni cron qiladi.)
  if (!updated.selfAssigned) {
    _notifyAssignees(TASK_PUSH_EVENTS.STOPPED, updated, {
      reason,
      penaltyPoints: appliedPoints,
    });
  }

  return updated;
};

const extendDeadline = async (
  taskId,
  { newDueDate, reason, withPenalty, penaltyPoints, extendedBy, scope },
) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq topilmadi");
  _assertScope(task, scope, extendedBy);

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

  // ⚠️ SHAXSIY TOPSHIRIQDA JARIMA YO'Q (`stopTask` bilan AYNI qoida):
  // muddatni o'ziga o'zi surgan odam o'zini jarimalamaydi.
  if (withPenalty && !task.selfAssigned) {
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
      // ⚠️ `appliedPoints` dan o'qiladi, `withPenalty` dan EMAS: shaxsiy
      // topshiriqda bayroq kelsa ham jarima yozilmaydi va tarix buni
      // "jarima bilan uzaytirildi" deb ko'rsatib qo'ymasligi kerak.
      withPenalty: appliedPoints > 0,
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
  {
    title,
    description,
    penaltyPoints,
    assigneeId,
    kind,
    startDate,
    links,
    removeAttachmentKeys = [],
    files = [],
  },
  editorId,
  scope,
) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq topilmadi");
  _assertScope(task, scope, editorId);

  // ⚠️ SHAXSIY DOIRADA IKKI MAYDON YOPIQ (`selfTask.service.js`):
  // IJROCHI — "faqat o'ziga" qoidasi buzilmasin (aks holda tahrir orqali
  // topshiriq birovga o'tib ketardi), JARIMA BALI — shaxsiy topshiriq
  // har doim 0 ball bilan qoladi. Panel bu maydonlarni ko'rsatmaydi,
  // lekin qaror shu yerda.
  if (scope?.mode === taskScopeService.SCOPE_SELF) {
    if (assigneeId !== undefined && String(assigneeId) !== String(task.assignee)) {
      throw new ForbiddenError("O'ziga belgilagan topshiriqning ijrochisini o'zgartirib bo'lmaydi");
    }
    if (penaltyPoints !== undefined && penaltyPoints !== null && penaltyPoints !== "") {
      throw new ForbiddenError("O'ziga belgilagan topshiriqda jarima bali bo'lmaydi");
    }
  }

  // ⚠️ YAKUNLANGAN TOPSHIRIQDA FAQAT TUR o'zgaradi. Qolgan maydonlar
  // (sarlavha, tavsif, muddat, jarima, fayllar) tasdiqlangan natija NIMAGA
  // nisbatan qabul qilinganini belgilaydi — ular muhrlangan. Tur esa
  // YORLIQ: u ishning mazmunini emas, hisobotdagi kesimini bildiradi,
  // shuning uchun uni keyin to'g'rilash mumkin (eski topshiriqlar
  // "asosiy" bo'lib qolgan, "asosiy" esa endi DOIMIY degani).
  const kindOnly =
    kind !== undefined &&
    [title, description, penaltyPoints, assigneeId, startDate, links].every(
      (v) => v === undefined,
    ) &&
    (removeAttachmentKeys || []).length === 0 &&
    (files || []).length === 0;

  if (task.status === "completed" && !kindOnly) {
    throw new BadRequestError(
      "Yakunlangan topshiriqda faqat turni o'zgartirish mumkin — qolganini tahrirlash uchun uni qayta oching",
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

  if (kind !== undefined && kind !== null && kind !== "") {
    const next = _assertKind(kind);
    if (next !== task.kind) {
      data.kind = next;
      changes.push({
        field: "kind",
        label: "Topshiriq turi",
        from: task.kind === "extra" ? "Qo'shimcha" : "Asosiy",
        to: next === "extra" ? "Qo'shimcha" : "Asosiy",
      });
    }
  }

  // BOSHLANISH VAQTI — bo'sh satr yuborilsa oraliq olib tashlanadi
  // ("shu vaqtgacha" rejimiga qaytadi). ⚠️ MUDDATNING O'ZI bu yerda
  // o'zgarmaydi: u `extendDeadline` ning ishi (sabab va tarix bilan).
  if (startDate !== undefined) {
    const next = _parseOptionalDate(startDate, "Boshlanish vaqti");
    if (next && next.getTime() >= task.dueDate.getTime()) {
      throw new BadRequestError("Boshlanish vaqti ijro muddatidan oldin bo'lishi kerak");
    }
    const prevMs = task.startDate ? task.startDate.getTime() : null;
    if ((next ? next.getTime() : null) !== prevMs) {
      data.startDate = next;
      changes.push({
        field: "startDate",
        label: "Boshlanish vaqti",
        from: task.startDate ? formatDateTimeUz(task.startDate) : "—",
        to: next ? formatDateTimeUz(next) : "—",
      });
    }
  }

  if (links !== undefined) {
    const next = normalizeLinks(links, (msg) => new BadRequestError(msg));
    const current = Array.isArray(task.links) ? task.links : [];
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      data.links = next;
      changes.push({
        field: "links",
        label: "Havolalar",
        from: String(current.length),
        to: String(next.length),
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
    // Rahbar topshiriqni bo'limidan tashqariga uzatib yubormasin
    if (scope) taskScopeService.assertCanAssign([assigneeId], scope);
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
const reopenTask = async (taskId, { newDueDate, reason, reopenedBy, scope }) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq topilmadi");
  _assertScope(task, scope, reopenedBy);

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

  // Shaxsiy topshiriqni o'zi qayta ochadi — push yo'q (`stopTask` izohi)
  if (!updated.selfAssigned) {
    _notifyAssignees(TASK_PUSH_EVENTS.REOPENED, updated, {
      reason: text,
      deadlineChanged: true,
    });
  }

  // Topshiriq muammodan kelgan va muammoni AYNAN SHU topshiriq yopgan
  // bo'lsa, muammo ham qayta ochiladi.
  await issueTaskService.onTaskReopened(updated);

  return updated;
};

/**
 * Topshiriqni butunlay o'chiradi (xato yaratilganlar uchun).
 * ⚠️ Jarima yozilgan topshiriq o'chirilmaydi: jarima yozuvi manbasiz qolardi
 * — bunday topshiriq to'xtatiladi.
 */
const deleteTask = async (taskId, { deletedBy, scope } = {}) => {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Topshiriq topilmadi");
  _assertScope(task, scope, deletedBy);

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
  writeTaskRows,
  notifyAssignees: _notifyAssignees,
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
