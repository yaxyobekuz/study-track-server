const asyncHandler = require("../middleware/async.middleware");
const logger = require("../utils/logger");
const { BadRequestError, ValidationError } = require("../utils/errors");
const { isValidId } = require("../utils/objectId");
const { LIMITS } = require("../services/aiAssistant/assistant.constants");
const {
  isConfigured,
  AssistantUnavailableError,
  NOT_CONFIGURED_MESSAGE,
} = require("../services/aiAssistant/assistant.client");
const { decodeXssText } = require("../services/aiAssistant/assistant.sanitize");
const assistantConversationService = require("../services/aiAssistant/assistantConversation.service");
const assistantChatService = require("../services/aiAssistant/assistantChat.service");
const assistantActionService = require("../services/aiAssistant/assistantAction.service");
const assistantVoiceService = require("../services/aiAssistant/assistantVoice.service");

// ─────────────────────────────────────────────
// SSE (Server-Sent Events)
// ─────────────────────────────────────────────

const SSE_EVENT_NAME = /^[a-z_]+$/;
const SSE_HEARTBEAT = ": ping\n\n";

/**
 * Bitta SSE kadri: `event: <nom>\ndata: <bir qatorli JSON>\n\n`.
 *
 * `JSON.stringify` satr ichidagi yangi qatorlarni `\n` ga qochiradi, ya'ni
 * `data:` doim BITTA qator — mijoz parseri ko'p qatorli `data` ni
 * birlashtirishga tayanmaydi.
 */
function formatSseFrame(event, data) {
  if (!SSE_EVENT_NAME.test(event)) throw new Error(`SSE hodisa nomi noto'g'ri: "${event}"`);
  return `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
}

/**
 * Javob ustidagi SSE kanali.
 *
 * ⚠️ SARLAVHA YUBORILGANDAN KEYIN HECH NARSA OTILMAYDI. Global error
 * handler `headersSent` ni tekshirmaydi — bu yerdan chiqqan xato soketni
 * buzardi. Yozish yopiq soketga tushsa jim `false` qaytadi.
 *
 * ⚠️ UZILISH `res` NING `close` HODISASIDAN aniqlanadi, `req` nikidan emas:
 * Node 16+ da `req` `close` so'rov tanasi o'qib bo'linganda (ya'ni
 * `express.json()` dan keyin darhol) keladi va har turni "uzildi" deb
 * to'xtatib qo'yardi. `res` esa faqat javob tugaganda yoki ulanish
 * uzilganda yopiladi; `writableFinished` ikkalasini ajratadi.
 */
function createSseChannel(res, { heartbeatMs = LIMITS.heartbeatMs } = {}) {
  let opened = false;
  let ended = false;
  let heartbeat = null;

  const writable = () => opened && !ended && !res.writableEnded && !res.destroyed;
  const write = (chunk) => {
    if (!writable()) return false;
    try {
      res.write(chunk);
      return true;
    } catch (err) {
      logger.warn(`[AiAssistant] SSE yozilmadi: ${err.message}`);
      return false;
    }
  };

  return {
    open() {
      if (opened) return;
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      // nginx: javobni buferlamasin (aks holda matn bo'lak-bo'lak emas, oxirida keladi).
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      opened = true;
      heartbeat = setInterval(() => write(SSE_HEARTBEAT), heartbeatMs);
      if (typeof heartbeat.unref === "function") heartbeat.unref();
    },
    send(event, data) {
      return write(formatSseFrame(event, data));
    },
    /**
     * ⚠️ ULANISH TINGLOVCHI QO'YILISHIDAN OLDIN UZILGAN BO'LISHI MUMKIN
     * (suhbatni o'qish `await` qilinayotganda). `close` hodisasi qayta
     * chiqmaydi — tekshirilmasa tur hech kim kutmayotgan holda oxirigacha
     * ishlab, pullik model so'rovlarini behuda yuborardi.
     */
    onClientClose(listener) {
      const fire = () => {
        if (!res.writableFinished) listener();
      };
      if (res.destroyed) {
        fire();
        return;
      }
      res.on("close", fire);
    },
    end() {
      if (!opened || ended) return;
      write(formatSseFrame("done", {}));
      ended = true;
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    },
  };
}

// ─────────────────────────────────────────────
// Kirish tekshiruvlari
// ─────────────────────────────────────────────

function parseOptionalConversationId(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (!isValidId(raw)) throw new ValidationError("Noto'g'ri conversationId formati");
  return raw;
}

/**
 * Chat matni. JSON so'rovda `xss-clean` `<` ni `&lt;` qilgan — qaytariladi;
 * multipart maydonlari `xss-clean` dan o'tmaydi, ular tegilmaydi.
 */
function parseChatText(req) {
  const raw = req.body?.text;
  if (typeof raw !== "string") throw new BadRequestError("Xabar matni kiritilmagan");
  const text = (req.is("multipart/form-data") ? raw : decodeXssText(raw)).trim();
  if (!text) throw new BadRequestError("Xabar matni bo'sh");
  if (text.length > LIMITS.maxTextLength) {
    throw new BadRequestError(`Xabar ko'pi bilan ${LIMITS.maxTextLength} belgi bo'lsin`);
  }
  return text;
}

function assertConfigured() {
  if (!isConfigured()) throw new AssistantUnavailableError(NOT_CONFIGURED_MESSAGE);
}

// ─────────────────────────────────────────────
// Holat
// ─────────────────────────────────────────────

const getStatus = asyncHandler(async (req, res) => {
  const configured = isConfigured();
  res.json({
    success: true,
    data: {
      configured,
      voiceInput: configured,
      voiceOutput: configured,
      branch: { id: req.branch.id, name: req.branch.name },
      limits: {
        maxTextLength: LIMITS.maxTextLength,
        maxVoiceSeconds: LIMITS.maxVoiceSeconds,
        maxVoiceBytes: LIMITS.maxVoiceBytes,
      },
    },
  });
});

// ─────────────────────────────────────────────
// Suhbatlar
// ─────────────────────────────────────────────

const listConversations = asyncHandler(async (req, res) => {
  const result = await assistantConversationService.list(req.user.id, req.query);
  res.json(result);
});

const getConversation = asyncHandler(async (req, res) => {
  const data = await assistantConversationService.getDetail(req.params.id, req.user.id);
  res.json({ success: true, data });
});

const renameConversation = asyncHandler(async (req, res) => {
  const data = await assistantConversationService.rename(req.params.id, req.user.id, req.body?.title);
  res.json({ success: true, data });
});

const deleteConversation = asyncHandler(async (req, res) => {
  await assistantConversationService.softDelete(req.params.id, req.user.id);
  res.json({ success: true, message: "Suhbat o'chirildi" });
});

// ─────────────────────────────────────────────
// Chat (SSE)
// ─────────────────────────────────────────────

/**
 * Oqimdan OLDINGI hamma tekshiruv (matn, ovoz, suhbat, sozlama, band)
 * oddiy JSON xato bo'lib qaytadi. Sarlavhalardan keyin esa faqat SSE
 * `error` hodisasi va doim `done`.
 */
const chat = asyncHandler(async (req, res) => {
  const ownerId = req.user.id;
  assertConfigured();

  let text = "";
  let voice = null;
  if (req.file) {
    const file = assistantVoiceService.assertVoiceFile(req.file);
    voice = { ...file, durationMs: assistantVoiceService.parseVoiceDuration(req.body?.durationMs) };
  } else {
    text = parseChatText(req);
  }

  const conversationId = parseOptionalConversationId(req.body?.conversationId);

  // ⚠️ QULF SUHBAT O'QILISHIDAN OLDIN olinadi. Aksincha bo'lsa, oldingi tur
  // qulfni bo'shatguncha o'qilgan suhbat eskirgan bo'lib qolardi: eskirgan
  // `activeToolsets` yangi ochilgan bo'limlarni ustidan yozar, eskirgan
  // `messageCount = 0` esa ikkinchi turni "birinchi" deb, tayyor sarlavhani
  // qayta almashtirardi.
  const lock = assistantChatService.acquireTurnLock({
    schemaName: req.branch.schemaName,
    ownerId,
    conversationId,
  });

  try {
    const conversation = conversationId
      ? await assistantConversationService.getOwned(conversationId, ownerId)
      : null;

    const channel = createSseChannel(res);
    const abort = new AbortController();
    channel.onClientClose(() => abort.abort());
    channel.open();
    try {
      await assistantChatService.runTurn({
        user: req.user,
        branch: req.branch,
        conversation,
        text,
        voice,
        emit: channel.send,
        signal: abort.signal,
        lock,
      });
    } catch (err) {
      logger.error(`[AiAssistant] chat oqimida kutilmagan xato: ${err.message}`, { stack: err.stack });
      channel.send("error", { code: "internal", message: "Javob tayyorlashda kutilmagan xato yuz berdi." });
    } finally {
      channel.end();
    }
  } finally {
    // Oqimdan oldingi xato (404 suhbat) ham qulfni bo'shatadi.
    lock.release();
  }
});

// ─────────────────────────────────────────────
// Ovoz
// ─────────────────────────────────────────────

const getMessageAudio = asyncHandler(async (req, res) => {
  const clip = await assistantVoiceService.getVoiceClip(req.params.id, req.user.id);
  res.set({
    "Content-Type": clip.mimeType,
    "Content-Length": String(clip.data.length),
    "Cache-Control": "private, max-age=3600",
  });
  res.send(clip.data);
});

const getMessageSpeech = asyncHandler(async (req, res) => {
  assertConfigured();
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  const audio = await assistantVoiceService.speakMessage(req.params.id, req.user.id, { signal: abort.signal });
  res.set({
    "Content-Type": "audio/mpeg",
    "Content-Length": String(audio.length),
    "Cache-Control": "private, no-store",
  });
  res.send(audio);
});

// ─────────────────────────────────────────────
// Amallar
// ─────────────────────────────────────────────

const listActions = asyncHandler(async (req, res) => {
  const result = await assistantActionService.list(req.user.id, req.query);
  res.json(result);
});

const confirmAction = asyncHandler(async (req, res) => {
  const data = await assistantActionService.confirm(
    req.params.id,
    { acknowledge: req.body?.acknowledge === true },
    { user: req.user, branch: req.branch },
  );
  res.json({ success: true, data });
});

const rejectAction = asyncHandler(async (req, res) => {
  const data = await assistantActionService.reject(req.params.id, { user: req.user });
  res.json({ success: true, data });
});

module.exports = {
  formatSseFrame,
  createSseChannel,
  getStatus,
  listConversations,
  getConversation,
  renameConversation,
  deleteConversation,
  chat,
  getMessageAudio,
  getMessageSpeech,
  listActions,
  confirmAction,
  rejectAction,
};
