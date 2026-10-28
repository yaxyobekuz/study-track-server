const asyncHandler = require("../middleware/async.middleware");
const { BadRequestError, ForbiddenError } = require("../utils/errors");
const taskService = require("../services/task.service");
const taskReportService = require("../services/taskReport.service");
const taskScopeService = require("../services/taskScope.service");
const taskNetworkService = require("../services/taskNetwork.service");
const taskReportExport = require("../services/taskReportExport.service");
const { PERMISSIONS, hasPermission, hasRole } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const { config } = require("../config/env.config");
const { getTaskSettings: loadTaskSettings } = require("../services/settings.service");

/**
 * Bir nechta foydalanuvchiga topshiriq yaratadi
 * POST /tasks
 */
const createTask = asyncHandler(async (req, res) => {
  const { title, description, startDate, dueDate, kind, links, penaltyPoints, assigneeIds } =
    req.body;

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
    // Ixtiyoriy: berilsa topshiriq AYNAN shu oraliqda bajariladi
    startDate,
    dueDate,
    kind,
    // multipart'da JSON satri bo'lib keladi — service o'zi ochadi
    links,
    // Berilmasa — sozlamadagi standart ball
    penaltyPoints: penaltyPoints ? Number(penaltyPoints) : undefined,
    assigneeIds: parsedAssigneeIds,
    createdBy: req.user.id,
    files: req.files || [],
    scope: req.taskScope,
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
  const result = await taskService.getTasks(req, req.taskScope);
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
  const task = await taskService.getTaskById(req.params.id, req.user, req.taskScope);
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
    scope: req.taskScope,
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
    scope: req.taskScope,
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
    scope: req.taskScope,
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
    scope: req.taskScope,
  });
  return res.json({ success: true, data: task, message: "Ijro muddati uzaytirildi" });
});

/**
 * Jonli hisoblagichlar ("Asosiy" tab tepasi)
 * GET /tasks/stats
 */
const getTaskStats = asyncHandler(async (req, res) => {
  const data = await taskService.getTaskStats(req.taskScope);
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
    period: req.query.period,
    scope: req.taskScope,
  });
  return res.json({ success: true, data });
});

/**
 * TOPSHIRIQ BERISH MUMKIN BO'LGAN ODAMLAR (doira bo'yicha).
 *
 * Bo'lim rahbarida `users.view` bo'lmasligi mumkin — usiz u ijrochini
 * tanlay olmasdi. Javobda faqat ism va rol bor.
 *
 * GET /tasks/assignees?search=&group=staff|student&limit=
 */
const getTaskAssignees = asyncHandler(async (req, res) => {
  const data = await taskScopeService.getAssignableUsers(req.taskScope, {
    search: req.query.search,
    group: req.query.group,
    limit: req.query.limit,
  });
  return res.json({ success: true, data });
});

/**
 * LAVOZIMLAR MARKAZI DASHBOARDI — kunlik / haftalik / oylik / yillik.
 *
 * ⚠️ Hisobot bilan BITTA DVIGATEL (`taskReport.service.js`): dashboarddagi
 * "bajarildi" va hisobotdagi "bajarildi" ikki xil raqam chiqarmasligi kerak.
 * Farqi faqat davr presetida va doirasida (rahbar — o'z bo'limi).
 *
 * GET /tasks/dashboard?period=day|week|month|year
 */
const getTaskDashboard = asyncHandler(async (req, res) => {
  // ⚠️ DASHBOARD `tasks.reports` NI OCHIB BERMAYDI. Payload hisobot bilan
  // bitta dvigateldan keladi, shuning uchun reytinglar (yetakchilar,
  // e'tibor, rollar, topshiriq beruvchilar) faqat o'sha kaliti borlarga
  // qo'shiladi — aks holda bo'limning bosh sahifasini ochish alohida
  // ruxsatni chetlab o'tish yo'li bo'lardi.
  const canSeeReports =
    hasRole(req.user, ROLES.OWNER) ||
    hasPermission(req.user.permissions || [], PERMISSIONS.TASKS_REPORTS);

  const data = await taskReportService.getTaskReport({
    period: req.query.period || "month",
    from: req.query.from,
    to: req.query.to,
    scope: req.taskScope,
    full: canSeeReports,
  });
  return res.json({ success: true, data });
});

/**
 * XODIMLAR TOPSHIRIQLARI — FAQAT "UMUMIY — BARCHA FILIALLAR" KO'RINISHIDA
 * (biznes qarori, 2026-10-27).
 *
 * Savol tarmoq darajasida beriladi: "bu oy butun tarmoqda nechta topshiriq
 * berildi, qanchasi bajarildi, qaysi filialda ish qolib ketyapti". Bitta
 * filial ichida bu savolga Lavozimlar markazi allaqachon javob beradi —
 * bir xil nomdagi ikki ekran ikki xil raqam ko'rsatmasligi kerak.
 *
 * ⚠️ DARVOZA SERVERDA, panelda EMAS. Panel kartani va hujjatni umumiy
 * ko'rinishdan tashqarida ko'rsatmaydi, lekin saqlangan havola yoki
 * to'g'ridan-to'g'ri so'rov shu yerda to'siladi: aks holda "faqat umumiy
 * ko'rinishda" degan qoida faqat ekranga tegishli bo'lib qolardi
 * (`studentEnrollment.controller.js` bilan AYNI naqsh).
 *
 * ⚠️ 403 — ruxsat kaliti YETARLI, lekin REJIM noto'g'ri. Shuning uchun
 * xabar "ruxsatingiz yo'q" emas: odam qaysi tugmani bosishi kerakligini
 * bilib tursin.
 *
 * @returns {object[]} umumiy rejimdagi filiallar ro'yxati
 */
const assertAggregateView = (req) => {
  const branches = req.aggregateScope?.branches;

  if (!branches?.length) {
    throw new ForbiddenError(
      "Bu hisobot faqat \"Umumiy — barcha filiallar\" ko'rinishida ochiladi",
    );
  }

  return branches;
};

/**
 * BOSH SAHIFADAGI KARTA — tanlangan davr bo'yicha beshta raqam va
 * filiallar kesimi.
 *
 * ⚠️ To'liq hisobotdan YENGIL (`getTaskPulse`): karta har ochilishda, har
 * filialda bajariladi. Raqamlar esa AYNI ta'riflardan chiqadi.
 *
 * GET /tasks/network/pulse?period=day|week|month|year
 */
const getNetworkTaskPulse = asyncHandler(async (req, res) => {
  const branches = assertAggregateView(req);

  const data = await taskNetworkService.getNetworkTaskPulse(
    { period: req.query.period || "month", from: req.query.from, to: req.query.to },
    branches,
  );

  return res.json({ success: true, data });
});

/**
 * HUJJAT KO'RINISHIDAGI HISOBOT — butun tarmoq bo'yicha.
 *
 * GET /tasks/network/report?period=day|week|month|year
 */
const getNetworkTaskReport = asyncHandler(async (req, res) => {
  const branches = assertAggregateView(req);

  const data = await taskNetworkService.getNetworkTaskReport(
    { period: req.query.period || "month", from: req.query.from, to: req.query.to },
    branches,
  );

  return res.json({ success: true, data });
});

/**
 * AYNI hisobot — Word (.docx) fayli.
 *
 * ⚠️ Fayl EKRANDAGI AYNI OBYEKTDAN quriladi: hisobot bir marta hisoblanib,
 * `taskReportExport` ga BERILADI (u qayta hisoblamaydi). Ikkinchi hisob
 * bo'lsa, ekrandagi foiz bilan fayldagi foiz asta-sekin uzoqlashardi.
 *
 * GET /tasks/network/report/export?period=...
 */
const exportNetworkTaskReport = asyncHandler(async (req, res) => {
  const branches = assertAggregateView(req);

  const report = await taskNetworkService.getNetworkTaskReport(
    { period: req.query.period || "month", from: req.query.from, to: req.query.to },
    branches,
  );

  await taskReportExport.sendTaskReportDocx(res, report);
});

/**
 * Topshiriq qoidalari
 * GET /tasks/settings
 */
const getTaskSettings = asyncHandler(async (req, res) => {
  const data = await loadTaskSettings();
  // Fayl hajmi chegarasi sozlamada emas, muhitda (`MAX_UPLOAD_FILE_SIZE_MB`)
  // — forma uni bilmasa, katta faylni yuborib qo'yardi va foydalanuvchi
  // "CORS xatosi" ni ko'rardi (hajm bo'yicha rad etilgan javobda CORS
  // sarlavhalari bo'lmaydi).
  return res.json({
    success: true,
    data: { ...data, maxFileSizeMb: config.maxUploadFileSizeMb },
  });
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
  const {
    title,
    description,
    penaltyPoints,
    assigneeId,
    kind,
    startDate,
    links,
    removeAttachmentKeys,
  } = req.body;

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
      kind,
      startDate,
      links,
      removeAttachmentKeys: removeKeys,
      files: req.files || [],
    },
    req.user.id,
    req.taskScope,
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
    scope: req.taskScope,
  });
  return res.json({ success: true, data: task, message: "Topshiriq qayta ochildi" });
});

/**
 * TOPSHIRIQNI BOSHQA IJROCHIGA BIRIKTIRISH — "Topshiriqlarim" ekranidan.
 * PUT /tasks/:id/delegate
 *
 * ⚠️ RUXSAT KALITI TALAB QILINMAYDI (route'da ham): topshiriq AYNAN shu
 * odamga berilgan bo'lsa, uni biriktirish huquqi EGALIKDAN keladi va
 * aktyor TOKENDAN olinadi. "Kimga" degan savol esa service'da
 * `assertCanDelegate` bilan cheklanadi.
 *
 * ⚠️ MULTIPART EMAS, JSON: fayl yuborilmaydi — manba topshiriqning
 * fayllari havolasi bilan ko'chadi.
 */
const delegateTask = asyncHandler(async (req, res) => {
  const { assigneeIds, dueDate, note, title, description, penaltyPoints, kind } = req.body;

  if (!dueDate) throw new BadRequestError("Ijro muddati majburiy");
  if (!Array.isArray(assigneeIds) || assigneeIds.length === 0) {
    throw new BadRequestError("Kamida bitta ijrochi tanlash kerak");
  }

  const tasks = await taskService.delegateTask(
    req.params.id,
    {
      assigneeIds,
      dueDate,
      note,
      title,
      description,
      penaltyPoints: penaltyPoints ? Number(penaltyPoints) : undefined,
      kind,
    },
    req.user.id,
    req.taskScope,
  );

  return res.status(201).json({
    success: true,
    data: tasks,
    message:
      tasks.length > 1
        ? `${tasks.length} ta xodimga biriktirildi`
        : "Topshiriq biriktirildi",
  });
});

/**
 * Topshiriqni o'chirish
 * DELETE /tasks/:id
 */
const deleteTask = asyncHandler(async (req, res) => {
  const data = await taskService.deleteTask(req.params.id, {
    deletedBy: req.user.id,
    scope: req.taskScope,
  });
  return res.json({ success: true, data, message: "Topshiriq o'chirildi" });
});

module.exports = {
  createTask,
  getTasks,
  getTaskStats,
  getTaskReport,
  getTaskDashboard,
  getNetworkTaskPulse,
  getNetworkTaskReport,
  exportNetworkTaskReport,
  getTaskAssignees,
  getTaskSettings,
  updateTaskSettings,
  updateTask,
  reopenTask,
  delegateTask,
  deleteTask,
  getMyTasks,
  getTaskById,
  submitCompletion,
  approveTask,
  rejectTask,
  stopTask,
  extendDeadline,
};
