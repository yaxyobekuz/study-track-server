/**
 * GURUH SIGNALLARI — AI topgan muammolar bilan ishlash.
 *
 * Oqim:
 *
 *   bot guruhdan o'qiydi  →  group_messages (navbat)
 *   job har 30 daqiqada   →  AI tahlili  →  group_signals
 *   odam panelda ko'radi  →  kategoriya tanlaydi  →  issues (haqiqiy muammo)
 *
 * ⚠️ SIGNAL — MUAMMO EMAS va bu butun modulning asosiy qarori. Xulosani
 * AI chiqargan, ya'ni u xato bo'lishi mumkin: hazilni shikoyat deb,
 * shikoyatni hazil deb topishi mumkin. Muammolar ro'yxati esa
 * ma'muriyat ishonadigan rasmiy navbat — unga tekshirilmagan taxminni
 * qo'yish o'sha ishonchni buzardi. Shuning uchun signal ALOHIDA turadi
 * va `issues` ga faqat ODAM qarori bilan o'tadi.
 *
 * ⚠️ PLATFORMA + FILIAL — IKKALASI. Signal platformada yashaydi (guruh
 * filialga tegishli emas), muammo esa filialda. `attach()` ikkalasiga
 * ham yozadi va bu YAGONA joy; boshqa hech qayerda `group_signals` va
 * `issues` birga o'zgartirilmaydi.
 */

const prisma = require("../config/prisma");
const platformPrisma = require("../config/platformPrisma");
const logger = require("../utils/logger");
const { NotFoundError, BadRequestError } = require("../utils/errors");
const { getBranch } = require("../config/branchContext");
const groupSignalAi = require("./groupSignalAi.service");

/** Signal holatlari. */
const SIGNAL_STATUSES = ["new", "attached", "dismissed"];

/**
 * Tahlilga olinadigan xabarlarning eng ko'p soni (bitta aylanishda).
 *
 * ⚠️ Chegara job'ni PREDSKAZUEMY qiladi: bot bir kecha ishlab, ertalab
 * server ko'tarilsa minglab xabar yig'ilgan bo'lishi mumkin. Hammasi
 * bitta aylanishda AI'ga ketsa — hisob ham, vaqt ham portlardi.
 * Qolgani keyingi aylanishda ko'riladi.
 */
const MAX_MESSAGES_PER_RUN = 300;

/**
 * Tahlil qilingan xabar qancha turib o'chiriladi.
 *
 * ⚠️ DARHOL O'CHIRILMAYDI: xato tekshirish uchun bir necha soat
 * qolgani ma'qul ("signal nimadan chiqdi?"). Lekin uzoq SAQLANMAYDI —
 * bu guruh yozishmasi va uni arxivlash kerak emas.
 */
const SWEEP_AFTER_HOURS = 24;

const MS_PER_HOUR = 3600000;

// ─────────────────────────────────────────────
// TAHLIL (job chaqiradi)
// ─────────────────────────────────────────────

/**
 * Navbatdagi xabarlarni AI'ga berib, signallarni yozadi.
 *
 * ⚠️ FILIAL KONTEKSTI KERAK EMAS va bo'lmasligi ham kerak: ikkala jadval
 * ham platformada. Shu sababli job `branchCron` ISHLATMAYDI — guruh
 * birorta filialga tegishli emas va uni filiallar bo'ylab aylantirish
 * har bir signalni filiallar soniga ko'paytirib yuborardi.
 *
 * @returns {Promise<{analyzed: number, signals: number, groups: number, skipped: boolean}>}
 */
async function runAnalysis() {
  if (!groupSignalAi.isEnabled()) {
    return { analyzed: 0, signals: 0, groups: 0, skipped: true };
  }

  const pending = await platformPrisma.groupMessage.findMany({
    where: { analyzedAt: null },
    orderBy: { sentAt: "asc" },
    take: MAX_MESSAGES_PER_RUN,
  });

  if (pending.length === 0) {
    return { analyzed: 0, signals: 0, groups: 0, skipped: false };
  }

  // ⚠️ GURUH BO'YICHA AJRATILADI: ikki guruhning yozishmasi bitta
  // so'rovga tushsa, model ularni bir suhbat deb o'qib, aralashtirib
  // xulosa chiqarardi.
  const byChat = new Map();
  for (const message of pending) {
    if (!byChat.has(message.chatId)) byChat.set(message.chatId, []);
    byChat.get(message.chatId).push(message);
  }

  let created = 0;

  for (const [chatId, messages] of byChat) {
    const result = await groupSignalAi.analyze(messages);

    // ⚠️ NOSOZLIKDA XABARLAR BELGILANMAYDI: `analyzedAt` qo'yilsa ular
    // tahlilsiz qolib, keyingi aylanishda ham olinmasdi. Shu holda
    // keyingi urinishda qayta ko'riladi.
    if (!result) {
      logger.warn(`[GroupSignal] ${chatId} tahlil qilinmadi — keyin qayta uriniladi`);
      continue;
    }

    for (const signal of result.signals) {
      try {
        await platformPrisma.groupSignal.create({
          data: {
            chatId: signal.chatId,
            messageId: signal.messageId,
            kind: signal.kind,
            severity: signal.severity,
            summary: signal.summary,
            quote: signal.quote,
            senderTgId: signal.senderTgId,
            senderName: signal.senderName,
            sentAt: signal.sentAt,
            messageCount: messages.length,
            model: result.model,
          },
        });
        created += 1;
      } catch (error) {
        logger.warn(`[GroupSignal] Signal yozilmadi: ${error.message}`);
      }
    }

    // Shu guruhning xabarlari ko'rib chiqildi.
    await platformPrisma.groupMessage.updateMany({
      where: { id: { in: messages.map((m) => m.id) } },
      data: { analyzedAt: new Date() },
    });
  }

  return {
    analyzed: pending.length,
    signals: created,
    groups: byChat.size,
    skipped: false,
  };
}

/**
 * Tahlil qilingan eski xabarlarni o'chiradi.
 *
 * ⚠️ FAQAT `analyzedAt` QO'YILGANLARI: tahlil qilinmagan xabar navbatda
 * turibdi va uni o'chirish signalni yo'qotish bo'lardi.
 */
async function sweep() {
  const cutoff = new Date(Date.now() - SWEEP_AFTER_HOURS * MS_PER_HOUR);

  const { count } = await platformPrisma.groupMessage.deleteMany({
    where: { analyzedAt: { not: null, lt: cutoff } },
  });

  return { deleted: count };
}

// ─────────────────────────────────────────────
// PANEL (controller chaqiradi)
// ─────────────────────────────────────────────

/**
 * Telegram xabariga HAVOLA.
 *
 * ⚠️ IKKI XIL SHAKL BOR va ikkalasi ham kerak:
 *
 *   ommaviy guruh (username bor) → https://t.me/<username>/<messageId>
 *   yopiq guruh (username yo'q)  → https://t.me/c/<chatId'siz -100>/<messageId>
 *
 * `-100` prefiksi supergruppa `chat_id` sining ichki qismi va havolada
 * ishlatilmaydi — olib tashlanmasa havola ochilmaydi.
 *
 * ⚠️ `t.me/c/...` havolasi faqat O'SHA GURUH A'ZOSIGA ochiladi. Bu
 * kamchilik emas: guruhda bo'lmagan odam xabarni ko'rmasligi to'g'ri.
 */
function buildMessageLink(group, messageId) {
  if (!messageId || !group) return null;

  if (group.username) return `https://t.me/${group.username}/${messageId}`;

  const chatId = String(group.chatId || "");
  if (!chatId.startsWith("-100")) return null;

  return `https://t.me/c/${chatId.slice(4)}/${messageId}`;
}

/**
 * Signallar ro'yxati — guruh ma'lumoti va havola bilan.
 *
 * @param {object} query - `req.query` (status, chatId)
 */
async function listSignals(query = {}) {
  const where = {};

  if (query.status && SIGNAL_STATUSES.includes(query.status)) {
    where.status = query.status;
  }
  if (query.chatId) where.chatId = query.chatId;
  if (query.kind && groupSignalAi.SIGNAL_KINDS.has(query.kind)) {
    where.kind = query.kind;
  }

  const signals = await platformPrisma.groupSignal.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  if (signals.length === 0) return [];

  // Guruh nomi va havola uchun — bitta so'rov bilan.
  const groups = await platformPrisma.telegramGroup.findMany({
    where: { chatId: { in: [...new Set(signals.map((s) => s.chatId))] } },
    select: { chatId: true, title: true, username: true },
  });
  const groupByChatId = new Map(groups.map((g) => [g.chatId, g]));

  // Biriktirgan odamlar — FILIAL schema'sidan (joriy filial).
  const actorIds = [
    ...new Set(
      signals.flatMap((s) => [s.attachedBy, s.dismissedBy].filter(Boolean)),
    ),
  ];
  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const actorById = new Map(actors.map((a) => [a.id, a]));

  return signals.map((signal) => {
    const group = groupByChatId.get(signal.chatId) || null;

    return {
      id: signal.id,
      kind: signal.kind,
      severity: signal.severity,
      summary: signal.summary,
      quote: signal.quote,
      status: signal.status,

      senderName: signal.senderName,
      senderTgId: signal.senderTgId,
      sentAt: signal.sentAt,
      messageCount: signal.messageCount,
      model: signal.model,
      createdAt: signal.createdAt,

      group: group
        ? { chatId: group.chatId, title: group.title, username: group.username }
        : { chatId: signal.chatId, title: signal.chatId, username: null },

      messageLink: buildMessageLink(group || { chatId: signal.chatId }, signal.messageId),

      issueId: signal.issueId,
      branchId: signal.branchId,
      // ⚠️ Aktyor BOSHQA filialda bo'lsa `null` qaytadi — `telegramGroup`
      // dagi `officialBy` bilan ayni hol. Panelda shunda faqat sana turadi.
      attachedBy: actorById.get(signal.attachedBy) || null,
      attachedAt: signal.attachedAt,
      dismissedBy: actorById.get(signal.dismissedBy) || null,
      dismissedAt: signal.dismissedAt,
    };
  });
}

/** Holat bo'yicha sanoq — tabdagi belgi uchun. */
async function getSignalCounts() {
  const rows = await platformPrisma.groupSignal.groupBy({
    by: ["status"],
    _count: { _all: true },
  });

  const counts = { new: 0, attached: 0, dismissed: 0 };
  for (const row of rows) {
    if (row.status in counts) counts[row.status] = row._count._all;
  }
  return counts;
}

/**
 * SIGNALNI MUAMMOGA AYLANTIRADI — "tezkor biriktirish".
 *
 * Odam kategoriya tanlaydi, qolgan hamma narsa signaldan ko'chiriladi.
 *
 * ⚠️ MUALLIF — BIRIKTIRGAN ODAM, xabar egasi emas. Sabab: `issues.user_id`
 * FILIAL `users` jadvaliga ishora qiladi, guruhda yozgan odam esa ko'pincha
 * ota-ona — u tizimda foydalanuvchi EMAS. Haqiqiy manba yo'qolmaydi: ismi,
 * guruh nomi va xabar havolasi muammo matniga yoziladi.
 *
 * ⚠️ JAVOB BOTGA KETMAYDI: `telegramId` va `chatId` ATAYLAB bo'sh
 * qoldiriladi. Ular to'ldirilsa, muammo yopilganda `issueNotification`
 * javobni O'SHA GURUHGA yuborardi — bot esa guruhda kuzatuvchi va hech
 * narsa yozmasligi kerak.
 *
 * @param {string} id - signal id
 * @param {{categoryId: string}} payload
 * @param {string} userId - biriktirayotgan xodim
 */
async function attach(id, payload = {}, userId) {
  const signal = await platformPrisma.groupSignal.findUnique({ where: { id } });
  if (!signal) throw new NotFoundError("Signal topilmadi");

  if (signal.status === "attached") {
    throw new BadRequestError("Bu signal allaqachon muammolarga biriktirilgan");
  }

  const categoryId = String(payload.categoryId || "").trim();
  if (!categoryId) throw new BadRequestError("Kategoriya tanlanmagan");

  const category = await prisma.issueCategory.findUnique({
    where: { id: categoryId },
    select: { id: true, isActive: true },
  });
  if (!category) throw new NotFoundError("Kategoriya topilmadi");
  if (!category.isActive) {
    throw new BadRequestError("Kategoriya faol emas");
  }

  const group = await platformPrisma.telegramGroup.findUnique({
    where: { chatId: signal.chatId },
    select: { chatId: true, title: true, username: true },
  });

  const issue = await prisma.issue.create({
    data: {
      categoryId,
      userId,
      // ⚠️ `staff` — biriktirgan odam xodim. `AUTHOR_KINDS` da faqat
      // "student" va "staff" bor, uchinchisini qo'shish esa butun
      // muallif mantig'ini (`loadAuthors`, filtrlar) o'zgartirardi.
      authorKind: "staff",
      body: _buildIssueBody(signal, group),
    },
  });

  await platformPrisma.groupSignal.update({
    where: { id },
    data: {
      status: "attached",
      issueId: issue.id,
      branchId: getBranch()?.id || null,
      attachedBy: userId,
      attachedAt: new Date(),
      // Avval e'tiborsiz qoldirilgan bo'lsa — belgisi tozalanadi.
      dismissedBy: null,
      dismissedAt: null,
    },
  });

  return { issueId: issue.id };
}

/** Muammo matni — signalning BARCHA ma'lumoti, havolasi bilan. */
function _buildIssueBody(signal, group) {
  const link = buildMessageLink(group || { chatId: signal.chatId }, signal.messageId);

  const lines = [signal.summary, ""];

  if (signal.quote) lines.push(`Xabar: "${signal.quote}"`, "");

  lines.push(`Guruh: ${group?.title || signal.chatId}`);
  if (signal.senderName) lines.push(`Yozgan: ${signal.senderName}`);
  if (link) lines.push(`Havola: ${link}`);

  return lines.join("\n");
}

/**
 * E'TIBORSIZ QOLDIRADI — "bu muammo emas".
 *
 * ⚠️ O'CHIRILMAYDI: AI nimani noto'g'ri topganini ko'rish kerak. Ro'yxat
 * esa standart holda faqat yangilarini ko'rsatadi, ya'ni bu yozuvlar
 * ishga xalaqit bermaydi.
 */
async function dismiss(id, userId) {
  const signal = await platformPrisma.groupSignal.findUnique({ where: { id } });
  if (!signal) throw new NotFoundError("Signal topilmadi");

  if (signal.status === "attached") {
    throw new BadRequestError(
      "Muammolarga biriktirilgan signalni e'tiborsiz qoldirib bo'lmaydi",
    );
  }

  await platformPrisma.groupSignal.update({
    where: { id },
    data: { status: "dismissed", dismissedBy: userId, dismissedAt: new Date() },
  });

  return { id };
}

module.exports = {
  SIGNAL_STATUSES,
  MAX_MESSAGES_PER_RUN,
  SWEEP_AFTER_HOURS,
  buildMessageLink,
  runAnalysis,
  sweep,
  listSignals,
  getSignalCounts,
  attach,
  dismiss,
};
