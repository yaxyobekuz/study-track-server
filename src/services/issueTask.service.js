/**
 * MUAMMO ↔ TOPSHIRIQ KO'PRIGI.
 *
 * Botdan kelgan muammoni hal qilish uchun ma'muriyat bir yoki bir nechta
 * xodimga topshiriq biriktiradi (`issue.service#assignTasks`). Topshiriq
 * tasdiqlanganda muammo ham avtomatik yopiladi va yuborgan odamga botdan
 * javob ketadi.
 *
 * ── NEGA ALOHIDA MODUL ───────────────────────────────────────────────
 *
 * ⚠️ AYLANMA IMPORTNI OLDINI OLADI. Bog'lanish ikki yo'nalishli:
 * `issue.service` topshiriq YARATADI (→ `task.service`), `task.service`
 * esa topshiriq tasdiqlanganda muammoni YOPADI. Ikkisi bir-birini
 * to'g'ridan-to'g'ri import qilsa sikl paydo bo'lardi va `require`
 * tartibiga qarab yarim bo'sh `exports` qaytarardi. Shuning uchun
 * zanjir BIR TOMONLAMA:
 *
 *     issue.service  →  task.service  →  issueTask.service  →  prisma
 *                                                           →  issueNotification
 *
 * Bu modul `task.service` ni HECH QACHON import qilmaydi.
 *
 * ── QOIDALAR ─────────────────────────────────────────────────────────
 *
 * ⚠️ HECH QACHON XATO TASHLAMAYDI. Chaqiruvchi — topshiriqni tasdiqlash
 * oqimi: muammoni yopish muvaffaqiyatsiz bo'lsa ham topshiriq tasdiqlangan
 * bo'lib qolishi kerak, aks holda xodimning bajargan ishi bekor bo'lardi.
 * Xato logga yoziladi.
 *
 * ⚠️ MUAMMO BARCHA TOPSHIRIQLARI TUGAGANDA yopiladi, birinchisida emas.
 * Uch kishiga biriktirilgan muammo bitta odam ishni topshirgani uchun
 * hal qilingan bo'lmaydi.
 *
 * ⚠️ QO'LDA QO'YILGAN QAROR USTUN. Ma'muriyat muammoni qo'lda "hal
 * qilindi"/"rad etildi" qilgan bo'lsa, topshiriq uni qayta ochmaydi ham,
 * ustiga yozmaydi ham (`closedByTask` shu farqni saqlaydi).
 */

const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const { notifyIssueReply } = require("./issueNotification.service");

/** Hali tugamagan topshiriq holatlari — `task.service.js#ACTIVE_STATUSES`. */
const ACTIVE_TASK_STATUSES = [
  "pending",
  "extended",
  "pending_rejected",
  "pending_review",
];

/** Muammoning YAKUNIY holatlari — `issue.service.js#FINAL_STATUSES`. */
const FINAL_ISSUE_STATUSES = ["resolved", "rejected"];

/**
 * Topshiriq yakunlangandan keyin muammoga yoziladigan javob matni.
 *
 * ⚠️ IJROCHINING IZOHI AFZAL. Muammo yuborgan odamga "topshiriq bajarildi"
 * degan quruq xabardan ko'ra NIMA QILINGANI muhim — ijrochi yakunlash
 * izohida aynan shuni yozadi. Izoh bo'lmasa (sozlamada majburiy emas)
 * standart satr ishlatiladi.
 *
 * Bir nechta ijrochi bo'lsa izohlar birlashtiriladi: har biri boshqa ish
 * qilgan bo'lishi mumkin va bittasini tanlab olish qolganlarini yashirardi.
 *
 * @param {Array<{completionNote?: string|null}>} tasks - yakunlangan topshiriqlar
 * @returns {string}
 */
const buildReplyFromTasks = (tasks) => {
  const notes = tasks
    .map((t) => (t.completionNote || "").trim())
    .filter(Boolean);

  if (!notes.length) {
    return "Muammoni hal qilish uchun berilgan topshiriq bajarildi.";
  }

  return [...new Set(notes)].join("\n\n");
};

/**
 * TOPSHIRIQ TASDIQLANDI — muammoni yopish kerakmi?
 *
 * @param {object} task - tasdiqlangan topshiriq (`issueId` bilan)
 * @returns {Promise<void>}
 */
const onTaskCompleted = async (task) => {
  try {
    if (!task?.issueId) return;

    const issue = await prisma.issue.findUnique({
      where: { id: task.issueId },
      include: {
        category: { select: { name: true, isActive: true } },
        tasks: {
          select: { id: true, status: true, completionNote: true },
        },
      },
    });
    if (!issue) return;

    // Qo'lda yopilgan muammoga tegilmaydi (yuqoridagi izoh)
    if (FINAL_ISSUE_STATUSES.includes(issue.status)) return;

    const active = issue.tasks.filter((t) =>
      ACTIVE_TASK_STATUSES.includes(t.status),
    );
    if (active.length > 0) return;

    const completed = issue.tasks.filter((t) => t.status === "completed");
    // ⚠️ Hammasi TO'XTATILGAN bo'lsa muammo yopilmaydi: hech kim ishni
    // bajarmagan, ya'ni muammo ochiq qoladi va ma'muriyat o'zi qaror
    // qiladi (panelda faol topshiriq soni nol bo'lib ko'rinadi).
    if (completed.length === 0) return;

    const reply = buildReplyFromTasks(completed);
    const now = new Date();

    const updated = await prisma.issue.update({
      where: { id: issue.id },
      data: {
        status: "resolved",
        reply,
        reviewedAt: now,
        closedByTask: true,
      },
      include: { category: { select: { name: true, isActive: true } } },
    });

    const delivered = await notifyIssueReply(updated);
    if (delivered) {
      await prisma.issue.update({
        where: { id: issue.id },
        data: { repliedAt: now },
      });
    }

    logger.info(
      `[IssueTask] Muammo topshiriq bilan yopildi: issue=${issue.id} tasks=${completed.length} yuborildi=${delivered}`,
    );
  } catch (error) {
    logger.error(`[IssueTask] Muammoni yopishda xato: ${error.message}`);
  }
};

/**
 * TOPSHIRIQ QAYTA OCHILDI — muammo ham qayta ochiladi.
 *
 * ⚠️ FAQAT TOPSHIRIQ YOPGAN MUAMMO (`closedByTask`). Ma'muriyat qo'lda
 * "hal qilindi" deb yopgan bo'lsa, topshiriqni qayta ochish uni bekor
 * qilmaydi: bu boshqa odamning qarori va uni jimgina teskari aylantirish
 * mumkin emas.
 *
 * ⚠️ `reply` SAQLANADI. Javob allaqachon botga yuborilgan, ya'ni odam
 * uni o'qigan: yozuvni o'chirish "nima deganimizni" yashirardi. Holat
 * esa `in_review` ga qaytadi — ish qaytadan boshlandi.
 *
 * @param {object} task - qayta ochilgan topshiriq (`issueId` bilan)
 * @returns {Promise<void>}
 */
const onTaskReopened = async (task) => {
  try {
    if (!task?.issueId) return;

    const issue = await prisma.issue.findUnique({
      where: { id: task.issueId },
      select: { id: true, status: true, closedByTask: true },
    });
    if (!issue || !issue.closedByTask) return;

    await prisma.issue.update({
      where: { id: issue.id },
      data: { status: "in_review", closedByTask: false },
    });

    logger.info(
      `[IssueTask] Topshiriq qayta ochildi, muammo ham qayta ochildi: issue=${issue.id}`,
    );
  } catch (error) {
    logger.error(
      `[IssueTask] Muammoni qayta ochishda xato: ${error.message}`,
    );
  }
};

/**
 * MUAMMOLAR UCHUN TOPSHIRIQ HOLATI — ro'yxat va detal uchun.
 *
 * ⚠️ BITTA SO'ROV, N+1 EMAS: ro'yxatda 20 ta muammo bor va har biri uchun
 * alohida so'rov yuborilsa sahifa sekinlashardi.
 *
 * Qaytadi: `Map<issueId, { total, active, completed, stopped, assignees }>`
 * `assignees` — ijrochi id'lari (ismlar chaqiruvchida yuklanadi).
 *
 * @param {string[]} issueIds
 * @returns {Promise<Map<string, object>>}
 */
const getTaskProgress = async (issueIds = []) => {
  const ids = [...new Set(issueIds.filter(Boolean))];
  if (!ids.length) return new Map();

  const tasks = await prisma.task.findMany({
    where: { issueId: { in: ids } },
    select: {
      id: true,
      issueId: true,
      status: true,
      assignee: true,
      dueDate: true,
    },
  });

  const map = new Map();
  for (const task of tasks) {
    if (!map.has(task.issueId)) {
      map.set(task.issueId, {
        total: 0,
        active: 0,
        completed: 0,
        stopped: 0,
        assignees: [],
        // Eng yaqin muddat — ro'yxatda "qachongacha" ni ko'rsatish uchun
        nextDueDate: null,
      });
    }

    const row = map.get(task.issueId);
    row.total += 1;
    if (ACTIVE_TASK_STATUSES.includes(task.status)) {
      row.active += 1;
      if (!row.nextDueDate || task.dueDate < row.nextDueDate) {
        row.nextDueDate = task.dueDate;
      }
    } else if (task.status === "completed") row.completed += 1;
    else if (task.status === "stopped") row.stopped += 1;

    if (!row.assignees.includes(task.assignee)) {
      row.assignees.push(task.assignee);
    }
  }

  return map;
};

module.exports = {
  ACTIVE_TASK_STATUSES,
  buildReplyFromTasks,
  onTaskCompleted,
  onTaskReopened,
  getTaskProgress,
};
