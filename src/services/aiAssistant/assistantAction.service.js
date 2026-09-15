/**
 * AI YORDAMCHI — amallar: taklif → ko'rinish → ega tasdiqlaydi → bajariladi.
 *
 * ⚠️ MODEL HECH NARSANI O'ZI BAJARMAYDI. U faqat `propose_*` chaqiradi;
 * bu servis `prepare` bilan ko'rinish quradi va `pending` qator yozadi.
 * Bajarish — faqat egasi `POST /actions/:id/confirm` bosganda, o'sha
 * so'rovning filial kontekstida.
 *
 * ⚠️ HOLAT O'TISHLARI COMPARE-AND-SWAP (`updateMany where status`).
 * "Tasdiqlash" ikki marta (ikki oyna, ikki bosish) kelsa, ikkinchisi
 * `count !== 1` bilan 409 oladi — amal ikki marta bajarilmaydi.
 *
 * ⚠️ TASDIQDA `prepare` QAYTA ISHLAYDI. Taklif va tasdiq orasida ma'lumot
 * o'zgargan bo'lsa (boshqa xodim to'lov kiritdi, oylik o'zgardi), ega
 * eskirgan raqamga "ha" demasligi uchun yangi ko'rinish qaytariladi va
 * qayta tasdiq so'raladi (`preview_changed`).
 *
 * ⚠️ `AiAction` qatorining o'zi AUDIT: kim (ownerId), nima (type, args,
 * params), qanday ko'rinishga rozi bo'lgan (preview), natija va vaqtlar.
 */

const crypto = require("crypto");
const prisma = require("../../config/prisma");
const logger = require("../../utils/logger");
const { NotFoundError, ConflictError, BadRequestError } = require("../../utils/errors");
const { formatDateTimeUz } = require("../../helpers/date.helpers");
const { LIMITS, RISK, ACTION_STATUS_LABELS } = require("./assistant.constants");
const { AiToolError, validateArgs } = require("./assistant.toolkit");
const { toJsonSafe, toStorableJson } = require("./assistant.sanitize");
const {
  getActionByType,
  withTimeout,
  publicErrorMessage,
  buildToolContext,
  AiTimeoutError,
} = require("./assistant.registry");

const ACTION_STATUSES = Object.freeze(Object.keys(ACTION_STATUS_LABELS));
const MAX_PAGE_LIMIT = 50;
const UNEXPECTED_EXECUTE_MESSAGE = "Amalni bajarishda kutilmagan xato yuz berdi";

// ─────────────────────────────────────────────────────────────────────────
// Iz (fingerprint)
// ─────────────────────────────────────────────────────────────────────────

/** Kalitlari tartiblangan JSON — bir xil holat doim bir xil satr beradi. */
function stableStringify(value) {
  const normalize = (node) => {
    if (Array.isArray(node)) return node.map(normalize);
    if (node !== null && typeof node === "object") {
      const out = {};
      for (const key of Object.keys(node).sort()) out[key] = normalize(node[key]);
      return out;
    }
    return node;
  };
  return JSON.stringify(normalize(toStorableJson(value)));
}

/** sha256 hex (64 belgi — `fingerprint` ustuni kengligi). */
function fingerprintOf(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────
// Ko'rinish normalizatsiyasi
// ─────────────────────────────────────────────────────────────────────────

const displayValue = (value) => {
  if (value === undefined || value === null || value === "") return "—";
  return String(value);
};

const stringList = (list) =>
  (Array.isArray(list) ? list : []).filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());

/**
 * `prepare` qaytargan ko'rinishni UI kutgan AYNI shaklga keltiradi.
 * Xulosa yo'q ko'rinish — domen kodidagi xato (egaga nima tasdiqlayotganini
 * aytmaydigan kartani ko'rsatib bo'lmaydi).
 */
function normalizePreview(preview, def) {
  if (!preview || typeof preview.summary !== "string" || !preview.summary.trim()) {
    throw new Error(`action "${def.type}": prepare preview.summary qaytarmadi`);
  }
  return {
    summary: preview.summary.trim(),
    target: typeof preview.target === "string" && preview.target.trim() ? preview.target.trim() : null,
    fields: (Array.isArray(preview.fields) ? preview.fields : [])
      .filter((field) => field && field.label)
      .map((field) => ({
        label: String(field.label),
        before: displayValue(field.before),
        after: displayValue(field.after),
      })),
    effects: stringList(preview.effects),
    warnings: stringList(preview.warnings),
  };
}

function normalizeResult(result, def) {
  if (!result || typeof result.summary !== "string" || !result.summary.trim()) {
    throw new Error(`action "${def.type}": execute summary qaytarmadi`);
  }
  const normalized = {
    summary: result.summary.trim(),
    details: (Array.isArray(result.details) ? result.details : [])
      .filter((item) => item && item.label)
      .map((item) => ({ label: String(item.label), value: displayValue(item.value) })),
  };
  if (result.data !== undefined) normalized.data = toJsonSafe(result.data);
  return normalized;
}

/**
 * `prepare` ni validatsiya + vaqt chegarasi bilan ishga tushiradi.
 * @returns {Promise<{ args, params, preview, fingerprint }>}
 */
async function runPrepare(def, rawArgs, ctx) {
  const args = validateArgs(def.parameters, rawArgs || {});
  const prepared = await withTimeout(() => def.prepare(args, ctx), {
    timeoutMs: def.timeoutMs,
    signal: ctx.signal,
    timeoutMessage: "Taklifni tayyorlash belgilangan vaqtda tugamadi",
  });
  if (!prepared || typeof prepared !== "object") {
    throw new Error(`action "${def.type}": prepare natija qaytarmadi`);
  }
  const preview = normalizePreview(prepared.preview, def);
  return {
    args: toStorableJson(args),
    params: toStorableJson(prepared.params ?? {}),
    preview,
    fingerprint: fingerprintOf(prepared.fingerprint ?? preview),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Serializatsiya
// ─────────────────────────────────────────────────────────────────────────

const isStalePending = (row, now = new Date()) => row.status === "pending" && row.expiresAt.getTime() < now.getTime();

/**
 * UI shakli (`design.md` §4.3). Muddati o'tgan `pending` — `expired` deb
 * ko'rsatiladi (bazaga keyingi o'qishda yoziladi).
 */
function serializeAction(row, { conversationTitle } = {}) {
  const now = new Date();
  const status = isStalePending(row, now) ? "expired" : row.status;
  const result =
    row.result && typeof row.result === "object"
      ? { summary: row.result.summary || "", details: Array.isArray(row.result.details) ? row.result.details : [] }
      : null;

  const data = {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    type: row.type,
    title: row.title,
    risk: row.risk,
    riskLabel: RISK[row.risk]?.label || row.risk,
    permission: row.permission,
    status,
    statusLabel: ACTION_STATUS_LABELS[status],
    preview: row.preview,
    result,
    errorMessage: row.errorMessage,
    requiresAcknowledge: row.risk === RISK.critical.key,
    expiresAt: row.expiresAt,
    isExpired: status === "expired",
    createdAt: row.createdAt,
    createdAtLabel: formatDateTimeUz(row.createdAt),
    decidedAt: row.decidedAt,
    executedAt: row.executedAt,
    executedAtLabel: row.executedAt ? formatDateTimeUz(row.executedAt) : null,
  };
  if (conversationTitle !== undefined) data.conversationTitle = conversationTitle;
  return data;
}

// ─────────────────────────────────────────────────────────────────────────
// Taklif
// ─────────────────────────────────────────────────────────────────────────

/**
 * Model taklifini `pending` amal sifatida yozadi.
 *
 * `messageId` odatda `null`: yordamchi xabari tur OXIRIDA saqlanadi va
 * amallar o'shanda `linkToMessage` bilan bog'lanadi.
 *
 * @throws {AiToolError|Error} — registr konvertga o'raydi
 */
async function propose(def, rawArgs, ctx, { messageId = null, emit } = {}) {
  const prepared = await runPrepare(def, rawArgs, ctx);
  const now = new Date();

  const row = await prisma.aiAction.create({
    data: {
      conversationId: ctx.conversationId,
      messageId,
      ownerId: ctx.user.id,
      type: def.type,
      toolName: def.toolName,
      title: def.title.slice(0, 160),
      risk: def.risk,
      permission: def.permission || null,
      args: prepared.args,
      params: prepared.params,
      preview: prepared.preview,
      fingerprint: prepared.fingerprint,
      status: "pending",
      expiresAt: new Date(now.getTime() + LIMITS.actionTtlMs),
    },
  });

  logger.info(`[AiAction] taklif: ${def.type}`, {
    id: row.id,
    type: row.type,
    ownerId: row.ownerId,
    status: row.status,
  });

  const action = serializeAction(row);
  if (typeof emit === "function") emit("action", { action });
  return action;
}

/** Tur oxirida yaratilgan amallarni yordamchi xabariga bog'laydi. */
async function linkToMessage(actionIds, messageId, client = prisma) {
  if (!actionIds.length) return;
  await client.aiAction.updateMany({
    where: { id: { in: actionIds }, messageId: null },
    data: { messageId },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// O'qish
// ─────────────────────────────────────────────────────────────────────────

/** Egasining muddati o'tgan `pending` amallarini `expired` qiladi. */
async function expireStale(ownerId, now = new Date()) {
  const { count } = await prisma.aiAction.updateMany({
    where: { ownerId, status: "pending", expiresAt: { lt: now } },
    data: { status: "expired" },
  });
  if (count) logger.info(`[AiAction] muddati o'tdi: ${count} ta`, { ownerId, status: "expired" });
  return count;
}

/** Egaga tegishli, o'chirilmagan suhbatdagi amal (aks holda 404). */
async function findOwned(id, ownerId) {
  const row = await prisma.aiAction.findFirst({
    where: { id, ownerId, conversation: { deletedAt: null } },
  });
  if (!row) throw new NotFoundError("Amal topilmadi");
  return row;
}

function statusWhere(status, now) {
  if (status === "pending") return { status: "pending", expiresAt: { gte: now } };
  if (status === "expired") {
    return { OR: [{ status: "expired" }, { status: "pending", expiresAt: { lt: now } }] };
  }
  return { status };
}

/**
 * Egasining amallari (audit ro'yxati), eng yangisi birinchi.
 * @param {string} ownerId
 * @param {{ status?: string, page?: *, limit?: * }} query
 */
async function list(ownerId, query = {}) {
  const status = query.status ? String(query.status) : "";
  if (status && !ACTION_STATUSES.includes(status)) {
    throw new BadRequestError(`Holat noto'g'ri. Ruxsat etilgan: ${ACTION_STATUSES.join(", ")}`);
  }
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, parseInt(query.limit, 10) || 20));

  await expireStale(ownerId);
  const now = new Date();
  const where = {
    ownerId,
    conversation: { deletedAt: null },
    ...(status ? statusWhere(status, now) : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.aiAction.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
      include: { conversation: { select: { title: true } } },
    }),
    prisma.aiAction.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);
  return {
    success: true,
    data: rows.map((row) => serializeAction(row, { conversationTitle: row.conversation?.title ?? null })),
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Tasdiqlash / rad etish
// ─────────────────────────────────────────────────────────────────────────

function logTransition(row, status, extra = {}) {
  logger.info(`[AiAction] ${row.type} → ${status}`, {
    id: row.id,
    type: row.type,
    ownerId: row.ownerId,
    status,
    ...extra,
  });
}

/** `executing` → yakuniy holat (CAS bilan). */
async function finishExecuting(row, data) {
  const { count } = await prisma.aiAction.updateMany({
    where: { id: row.id, status: "executing" },
    data,
  });
  if (count !== 1) {
    logger.error(`[AiAction] ${row.type}: executing holati kutilmaganda o'zgargan`, {
      id: row.id,
      type: row.type,
      ownerId: row.ownerId,
      status: data.status,
    });
  }
  logTransition(row, data.status);
  return prisma.aiAction.findUnique({ where: { id: row.id } });
}

/**
 * Amalni tasdiqlaydi va bajaradi.
 *
 * @param {string} id
 * @param {{ acknowledge?: boolean }} body
 * @param {{ user: object, branch: object }} requestCtx
 * @returns {Promise<object>} serializatsiya qilingan amal (`succeeded` yoki `failed`)
 * @throws {ConflictError} `expired` / `not_pending` / `preview_changed`
 * @throws {BadRequestError} `acknowledge_required`
 */
async function confirm(id, { acknowledge } = {}, { user, branch }) {
  const row = await findOwned(id, user.id);
  const now = new Date();

  if (isStalePending(row, now)) {
    await prisma.aiAction.updateMany({
      where: { id: row.id, status: "pending" },
      data: { status: "expired" },
    });
    logTransition(row, "expired");
    const fresh = await prisma.aiAction.findUnique({ where: { id: row.id } });
    throw new ConflictError("Amal muddati o'tgan. Yordamchidan qayta taklif qilishni so'rang.", {
      reason: "expired",
      action: serializeAction(fresh),
    });
  }
  if (row.status !== "pending") {
    throw new ConflictError("Bu amal bo'yicha qaror allaqachon qabul qilingan", {
      reason: "not_pending",
      action: serializeAction(row),
    });
  }
  if (row.risk === RISK.critical.key && acknowledge !== true) {
    throw new BadRequestError("Bu amal uchun \"Oqibatlarini tushundim\" belgisi majburiy", {
      reason: "acknowledge_required",
    });
  }

  const claimed = await prisma.aiAction.updateMany({
    where: { id: row.id, status: "pending" },
    data: { status: "executing", decidedAt: now },
  });
  if (claimed.count !== 1) {
    const fresh = await prisma.aiAction.findUnique({ where: { id: row.id } });
    throw new ConflictError("Bu amal bo'yicha qaror allaqachon qabul qilingan", {
      reason: "not_pending",
      action: serializeAction(fresh),
    });
  }
  logTransition(row, "executing");

  const def = getActionByType(row.type);
  if (!def) {
    const done = await finishExecuting(row, {
      status: "failed",
      errorMessage: "Bu amal turi endi mavjud emas",
    });
    return serializeAction(done);
  }

  // ⚠️ Bajarish mijoz uzilishiga BOG'LANMAYDI: yozish yarim yo'lda
  // to'xtatilsa, qaysi qismi bajarilgani noma'lum qolardi.
  const ctx = buildToolContext({
    user,
    branch,
    conversationId: row.conversationId,
    signal: new AbortController().signal,
  });

  let prepared;
  try {
    prepared = await runPrepare(def, row.args, ctx);
  } catch (err) {
    logFailure(row, err, "prepare");
    const done = await finishExecuting(row, {
      status: "failed",
      errorMessage: publicErrorMessage(err, "Amalni tekshirishda kutilmagan xato yuz berdi"),
    });
    return serializeAction(done);
  }

  if (prepared.fingerprint !== row.fingerprint) {
    const refreshed = await prisma.aiAction.updateMany({
      where: { id: row.id, status: "executing" },
      data: {
        status: "pending",
        params: prepared.params,
        preview: prepared.preview,
        fingerprint: prepared.fingerprint,
        expiresAt: new Date(Date.now() + LIMITS.actionTtlMs),
        decidedAt: null,
      },
    });
    if (refreshed.count === 1) logTransition(row, "pending", { reason: "preview_changed" });
    const fresh = await prisma.aiAction.findUnique({ where: { id: row.id } });
    throw new ConflictError("Ma'lumot o'zgargan — yangilangan ko'rinishni tekshirib, qayta tasdiqlang", {
      reason: "preview_changed",
      action: serializeAction(fresh),
    });
  }

  let rawResult;
  try {
    rawResult = await withTimeout(() => def.execute(prepared.params, ctx), {
      timeoutMs: def.timeoutMs,
      timeoutMessage:
        "Amal belgilangan vaqtda tugamadi. U fonda yakunlangan bo'lishi mumkin — natijani tegishli bo'limda tekshiring.",
    });
  } catch (err) {
    logFailure(row, err, "execute");
    const done = await finishExecuting(row, {
      status: "failed",
      errorMessage: publicErrorMessage(err, UNEXPECTED_EXECUTE_MESSAGE),
    });
    return serializeAction(done);
  }

  // ⚠️ `execute` QAYTGAN — yozuv BAJARILGAN. Natija shakli buzuq bo'lsa ham
  // (domen kodidagi xato) amal `failed` deb yozilmaydi: ega "bajarilmadi"
  // ni ko'rib qayta so'rasa, o'zgarish ikki marta bajarilardi.
  let result;
  try {
    result = normalizeResult(rawResult, def);
  } catch (err) {
    logger.error(`[AiAction] ${row.type}: execute natijasi yaroqsiz — ${err.message}`, {
      id: row.id,
      type: row.type,
      ownerId: row.ownerId,
      status: "succeeded",
    });
    result = { summary: `${row.title} — bajarildi`, details: [] };
  }
  const done = await finishExecuting(row, { status: "succeeded", result, executedAt: new Date() });
  return serializeAction(done);
}

function logFailure(row, err, phase) {
  const expected =
    err instanceof AiToolError || err instanceof AiTimeoutError || (Number.isInteger(err?.statusCode) && err.statusCode < 500);
  const line = `[AiAction] ${row.type} ${phase} xatosi: ${err?.message}`;
  const meta = { id: row.id, type: row.type, ownerId: row.ownerId, status: "failed" };
  if (expected) logger.warn(line, meta);
  else logger.error(line, { ...meta, stack: err?.stack });
}

/** Taklifni rad etadi (faqat `pending`). */
async function reject(id, { user }) {
  const row = await findOwned(id, user.id);
  if (isStalePending(row)) {
    await expireStale(user.id);
    const fresh = await prisma.aiAction.findUnique({ where: { id: row.id } });
    throw new ConflictError("Amal muddati o'tgan", { reason: "expired", action: serializeAction(fresh) });
  }
  const { count } = await prisma.aiAction.updateMany({
    where: { id: row.id, status: "pending" },
    data: { status: "rejected", decidedAt: new Date() },
  });
  const fresh = await prisma.aiAction.findUnique({ where: { id: row.id } });
  if (count !== 1) {
    throw new ConflictError("Bu amal bo'yicha qaror allaqachon qabul qilingan", {
      reason: "not_pending",
      action: serializeAction(fresh),
    });
  }
  logTransition(row, "rejected");
  return serializeAction(fresh);
}

module.exports = {
  ACTION_STATUSES,
  stableStringify,
  fingerprintOf,
  normalizePreview,
  serializeAction,
  propose,
  linkToMessage,
  expireStale,
  list,
  confirm,
  reject,
};
