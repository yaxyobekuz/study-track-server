/**
 * AI YORDAMCHI — suhbatlar: CRUD, serializatsiya va model tarixi.
 *
 * ⚠️ HAR O'QISH EGASI BO'YICHA FILTRLANADI (`ownerId`, `deletedAt: null`).
 * Suhbat faqat tizim egasiniki bo'lsa-da, filtr "id ni bilgan boshqa
 * foydalanuvchi" holatini strukturaviy yopadi — marshrut darvozasi
 * kelajakda kengaytirilsa ham ma'lumot ochilib ketmaydi.
 *
 * ⚠️ O'CHIRISH YUMSHOQ. Suhbat ro'yxatdan yo'qoladi, lekin bajarilgan
 * amallar audit sifatida bazada qoladi. Tasdiq kutayotgan amallar esa
 * `rejected` qilinadi: ko'rinmaydigan suhbatdagi karta hech qachon
 * tasdiqlanmasligi kerak.
 */

const prisma = require("../../config/prisma");
const logger = require("../../utils/logger");
const { NotFoundError, BadRequestError } = require("../../utils/errors");
const { formatDateTimeUz, formatTimeUz } = require("../../helpers/date.helpers");
const { LIMITS, ACTION_STATUS_LABELS } = require("./assistant.constants");
const { decodeXssText } = require("./assistant.sanitize");
const { normalizeToolsets } = require("./assistant.registry");
const assistantActionService = require("./assistantAction.service");

const MAX_PAGE_LIMIT = 50;
const MAX_STORED_TITLE = 120;

// ─────────────────────────────────────────────────────────────────────────
// Serializatsiya
// ─────────────────────────────────────────────────────────────────────────

function serializeConversation(row) {
  return {
    id: row.id,
    title: row.title,
    messageCount: row.messageCount,
    lastMessageAt: row.lastMessageAt,
    lastMessageAtLabel: formatDateTimeUz(row.lastMessageAt),
    createdAt: row.createdAt,
    activeToolsets: normalizeToolsets(row.activeToolsets),
  };
}

/**
 * @param {object} row — `AiMessage` (`audio` select va `actions` bilan bo'lishi mumkin)
 * @param {object[]} [actions] — xom `AiAction` qatorlari (bo'lmasa `row.actions`)
 */
function serializeMessage(row, actions) {
  const actionRows = actions || row.actions || [];
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    inputMode: row.inputMode,
    hasAudio: Boolean(row.audio),
    audioDurationMs: row.audioDurationMs,
    steps: row.role === "assistant" && Array.isArray(row.steps) ? row.steps : [],
    status: row.status,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    createdAtLabel: formatDateTimeUz(row.createdAt),
    timeLabel: formatTimeUz(row.createdAt),
    actions: actionRows.map((action) => assistantActionService.serializeAction(action)),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Sarlavha
// ─────────────────────────────────────────────────────────────────────────

/** Zaxira sarlavha: matnning birinchi qatori, `maxTitleLength` gacha. */
function fallbackTitle(text) {
  const firstLine =
    String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || "Yangi suhbat";
  const collapsed = firstLine.replace(/\s+/g, " ");
  if (collapsed.length <= LIMITS.maxTitleLength) return collapsed;
  return `${collapsed.slice(0, LIMITS.maxTitleLength - 1).trimEnd()}…`;
}

/** Egasi kiritgan sarlavha (xss-clean `&lt;` qaytariladi). */
function parseTitle(raw) {
  if (typeof raw !== "string") throw new BadRequestError("Sarlavha kiritilmagan");
  const title = decodeXssText(raw).replace(/\s+/g, " ").trim();
  if (!title) throw new BadRequestError("Sarlavha bo'sh bo'lmasin");
  if (title.length > MAX_STORED_TITLE) {
    throw new BadRequestError(`Sarlavha ko'pi bilan ${MAX_STORED_TITLE} belgi bo'lsin`);
  }
  return title;
}

// ─────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────

async function create({ ownerId, title }) {
  return prisma.aiConversation.create({
    data: { ownerId, title: String(title).slice(0, MAX_STORED_TITLE), activeToolsets: [] },
  });
}

/** Egaga tegishli, o'chirilmagan suhbat (aks holda 404). */
async function getOwned(id, ownerId) {
  const row = await prisma.aiConversation.findFirst({ where: { id, ownerId, deletedAt: null } });
  if (!row) throw new NotFoundError("Suhbat topilmadi");
  return row;
}

async function list(ownerId, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, parseInt(query.limit, 10) || 20));
  const search = typeof query.search === "string" ? decodeXssText(query.search).trim().slice(0, 120) : "";

  const where = {
    ownerId,
    deletedAt: null,
    ...(search ? { title: { contains: search, mode: "insensitive" } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.aiConversation.findMany({
      where,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.aiConversation.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);
  return {
    success: true,
    data: rows.map(serializeConversation),
    pagination: { page, limit, total, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 },
  };
}

const MESSAGE_INCLUDE = Object.freeze({
  audio: { select: { id: true } },
  actions: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
});

async function getDetail(id, ownerId) {
  const conversation = await getOwned(id, ownerId);
  await assistantActionService.expireStale(ownerId);
  const messages = await prisma.aiMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: MESSAGE_INCLUDE,
  });
  return {
    conversation: serializeConversation(conversation),
    messages: messages.map((message) => serializeMessage(message)),
  };
}

async function rename(id, ownerId, rawTitle) {
  const title = parseTitle(rawTitle);
  const conversation = await getOwned(id, ownerId);
  const updated = await prisma.aiConversation.update({ where: { id: conversation.id }, data: { title } });
  return serializeConversation(updated);
}

async function softDelete(id, ownerId) {
  const conversation = await getOwned(id, ownerId);
  const now = new Date();
  const [, rejected] = await prisma.$transaction([
    prisma.aiConversation.update({ where: { id: conversation.id }, data: { deletedAt: now } }),
    prisma.aiAction.updateMany({
      where: { conversationId: conversation.id, status: "pending" },
      data: { status: "rejected", decidedAt: now },
    }),
  ]);
  logger.info(`[AiAssistant] suhbat o'chirildi`, {
    id: conversation.id,
    ownerId,
    rejectedActions: rejected.count,
  });
}

/** Egaga tegishli xabar (suhbat orqali), `audio`/`actions` bilan. */
async function getOwnedMessage(messageId, ownerId, include = {}) {
  const row = await prisma.aiMessage.findFirst({
    where: { id: messageId, conversation: { ownerId, deletedAt: null } },
    include,
  });
  if (!row) throw new NotFoundError("Xabar topilmadi");
  return row;
}

// ─────────────────────────────────────────────────────────────────────────
// Model tarixi
// ─────────────────────────────────────────────────────────────────────────

/** Amalning tarixdagi qisqa izohi — model tasdiq/rad natijasini bilsin. */
function actionNote(action, now = new Date()) {
  const status =
    action.status === "pending" && new Date(action.expiresAt).getTime() < now.getTime() ? "expired" : action.status;
  let note = `[Amal #${action.id}: ${action.title} — holat: ${ACTION_STATUS_LABELS[status] || status}`;
  if (status === "succeeded" && action.result?.summary) note += ` — natija: ${action.result.summary}`;
  if (status === "failed" && action.errorMessage) note += ` — xato: ${action.errorMessage}`;
  return `${note}]`;
}

/**
 * Oldingi xabarlar → modelga ketadigan `messages` (tizim promptisiz).
 *
 * Eng yangisidan orqaga yuriladi: `maxMessages` va `charBudget` dan
 * oshganda ESKISI tashlanadi. Vosita natijalari qayta o'ynatilmaydi —
 * ular eskirgan jonli ma'lumot; model kerak bo'lsa vositani qayta chaqiradi.
 *
 * @param {object[]} messages — vaqt bo'yicha o'sish tartibida, `actions` bilan
 * @param {{ maxMessages?: number, charBudget?: number, now?: Date }} [options]
 * @returns {{ role: "user"|"assistant", content: string }[]}
 */
function buildHistory(messages, options = {}) {
  const maxMessages = options.maxMessages ?? LIMITS.historyMaxMessages;
  const charBudget = options.charBudget ?? LIMITS.historyCharBudget;
  const now = options.now ?? new Date();

  const picked = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0 && picked.length < maxMessages; i -= 1) {
    const message = messages[i];
    let content = String(message.content || "");
    if (message.role === "assistant") {
      const notes = (message.actions || []).map((action) => actionNote(action, now));
      // Yarim qolgan javob to'liq deb qabul qilinmasin: model undagi kesilgan
      // jadval yoki ro'yxatga "yuqorida aytganimdek" deb tayanib qolardi.
      if (content.trim() && (message.status === "interrupted" || message.status === "error")) {
        notes.unshift("[Bu javob yakunlanmay qolgan]");
      }
      if (notes.length) content = `${content}\n\n${notes.join("\n")}`.trim();
    }
    if (!content.trim()) continue;
    if (used + content.length > charBudget) {
      // Eng yangi xabar yolg'iz o'zi byudjetdan katta bo'lsa ham, uning
      // oxiri qoladi — aks holda model suhbat davomini umuman ko'rmasdi.
      if (picked.length === 0) picked.push({ role: message.role, content: content.slice(-charBudget) });
      break;
    }
    used += content.length;
    picked.push({ role: message.role, content });
  }
  return picked.reverse();
}

/** Tur uchun oldingi xabarlar (eng oxirgi `historyMaxMessages` tasi). */
async function loadHistoryMessages(conversationId, { excludeId } = {}) {
  const rows = await prisma.aiMessage.findMany({
    where: { conversationId, ...(excludeId ? { id: { not: excludeId } } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: LIMITS.historyMaxMessages,
    include: { actions: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
  });
  return rows.reverse();
}

module.exports = {
  serializeConversation,
  serializeMessage,
  fallbackTitle,
  parseTitle,
  create,
  getOwned,
  list,
  getDetail,
  rename,
  softDelete,
  getOwnedMessage,
  actionNote,
  buildHistory,
  loadHistoryMessages,
};
