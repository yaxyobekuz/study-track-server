/**
 * AI YORDAMCHI — ovoz: nutqni matnga aylantirish, javobni ovozda o'qish,
 * egasining ovozli xabarini qaytarib berish.
 *
 * ⚠️ OVOZLI XABAR SPACES'DA MAXFIY (`ACL: private`), BAZADA FAQAT KALITI.
 * Mavjud `uploadBuffer` fayllarni `public-read` yuklaydi — egasining ovozi
 * havola orqali hammaga ochiq bo'lib qolardi. Bu yerda `uploadPrivateBuffer`
 * ishlatiladi va fayl mijozga faqat egalik tekshiruvidan o'tgan so'rov
 * orqali, server tomonidan o'qib beriladi. Ochiq URL hech qayerga yozilmaydi.
 *
 * ⚠️ SAQLASH NOSOZ BO'LSA SUHBAT TO'XTAMAYDI. Transkripsiya allaqachon
 * tayyor: xabar matni bilan yoziladi, faqat qayta tinglash imkoni bo'lmaydi
 * (`hasAudio: false`). Ovozni saqlay olmadik deb egasining savolini
 * yo'qotish noto'g'ri narx bo'lardi.
 *
 * ⚠️ MIJOZ YUBORGAN DAVOMIYLIK — FAQAT ISHORA. Brauzer uni o'lchaydi, server
 * audio'ni dekodlamaydi; shu sababli u faqat chegaralanadi va ko'rsatish
 * uchun saqlanadi, xavfsizlik chegarasi esa bayt hajmi (`maxVoiceBytes`).
 */

const { toFile } = require("openai");
const logger = require("../../utils/logger");
const { config } = require("../../config/env.config");
const { BadRequestError, NotFoundError } = require("../../utils/errors");
const { generateId } = require("../../utils/idGenerator");
const fileStorage = require("../fileStorage.service");
const { MODELS, SPEECH, TRANSCRIBE, LIMITS } = require("./assistant.constants");
const { getClient } = require("./assistant.client");
const assistantConversationService = require("./assistantConversation.service");

/** busboy `;codecs=` qismini tashlaydi — bu yerda faqat `type/subtype`. */
const MIME_EXTENSIONS = Object.freeze({
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "mp4",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
});

function extensionForMime(mimeType) {
  const base = String(mimeType || "").split(";")[0].trim().toLowerCase();
  return MIME_EXTENSIONS[base] || null;
}

/**
 * Mijoz yuborgan davomiylik (ms). Yaroqsiz → `null`, chegaradan uzun → 400.
 * @returns {number|null}
 */
function parseVoiceDuration(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  const maxMs = LIMITS.maxVoiceSeconds * 1000;
  if (value > maxMs) {
    throw new BadRequestError(`Ovozli xabar ko'pi bilan ${Math.round(LIMITS.maxVoiceSeconds / 60)} daqiqa bo'lsin`);
  }
  return Math.round(value);
}

/**
 * Yuklangan audio faylni tekshiradi (hajm, tur).
 * @returns {{ buffer: Buffer, mimeType: string, sizeBytes: number }}
 */
function assertVoiceFile(file) {
  if (!file || !file.buffer || file.size === 0) throw new BadRequestError("Ovozli xabar bo'sh");
  if (file.size > LIMITS.maxVoiceBytes) {
    throw new BadRequestError(
      `Ovozli xabar juda katta. Ko'pi bilan ${Math.round(LIMITS.maxVoiceBytes / (1024 * 1024))} MB bo'lsin`,
    );
  }
  const mimeType = String(file.mimetype || "").split(";")[0].trim().toLowerCase();
  if (!extensionForMime(mimeType)) throw new BadRequestError("Bu turdagi audio fayl qabul qilinmaydi");
  return { buffer: file.buffer, mimeType, sizeBytes: file.size };
}

/**
 * Nutq → matn.
 * @returns {Promise<string>} bo'sh satr — nutq aniqlanmadi
 */
async function transcribe(buffer, mimeType, { signal } = {}) {
  const client = getClient();
  const extension = extensionForMime(mimeType) || "webm";
  const file = await toFile(buffer, `voice.${extension}`, { type: mimeType });
  const response = await client.audio.transcriptions.create(
    {
      file,
      model: MODELS.transcribe,
      language: TRANSCRIBE.language,
      prompt: TRANSCRIBE.prompt,
      response_format: "json",
    },
    { signal, timeout: LIMITS.audioTimeoutMs, maxRetries: 1 },
  );
  return String(response?.text || "").trim();
}

/**
 * Markdown → o'qiladigan oddiy matn: sarlavha/qalin belgilar olib
 * tashlanadi, jadval ustunlari vergul bilan, havola — faqat matni.
 */
function stripMarkdownForSpeech(markdown) {
  return String(markdown || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, " ")
    .replace(/^\s*\|(.*)\|\s*$/gm, (_, row) => `${row.split("|").map((cell) => cell.trim()).filter(Boolean).join(", ")}.`)
    .replace(/\|/g, ", ")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_`~#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Matnni `max` gacha, iloji bo'lsa gap chegarasida kesadi. */
function cutAtSentence(text, max) {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const boundary = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("? "), slice.lastIndexOf("! "));
  if (boundary > max * 0.5) return slice.slice(0, boundary + 1).trim();
  const space = slice.lastIndexOf(" ");
  return (space > 0 ? slice.slice(0, space) : slice).trim();
}

/** Matn → mp3 (Buffer). */
async function synthesizeSpeech(text, { signal } = {}) {
  const input = cutAtSentence(stripMarkdownForSpeech(text), SPEECH.maxInputChars);
  if (!input) throw new BadRequestError("O'qish uchun matn yo'q");
  const client = getClient();
  const response = await client.audio.speech.create(
    {
      model: MODELS.speech,
      voice: SPEECH.voice,
      input,
      instructions: SPEECH.instructions,
      response_format: SPEECH.format,
    },
    { signal, timeout: LIMITS.audioTimeoutMs, maxRetries: 1 },
  );
  return Buffer.from(await response.arrayBuffer());
}

/** Spaces sozlanganmi (kalit va bucket). Sozlanmagan bo'lsa ovoz saqlanmaydi. */
function isVoiceStorageConfigured() {
  return Boolean(config.doBucketName && config.doAccessKey && config.doSecretKey && config.doEndpoint);
}

/**
 * Obyekt kaliti: `ai-assistant/voice/<schema>/<suhbat>/<id>.<ext>`.
 * Filial schema'si kalitda — bir bucket bir nechta filialga xizmat qiladi.
 */
function buildVoiceKey({ schemaName, conversationId, mimeType }) {
  const extension = extensionForMime(mimeType) || "webm";
  return `ai-assistant/voice/${schemaName}/${conversationId}/${generateId()}.${extension}`;
}

/**
 * Ovozli xabarni Spaces'ga MAXFIY yuklaydi.
 * @returns {Promise<string|null>} kalit; saqlab bo'lmasa `null` (xato loglanadi)
 */
async function storeVoiceClip({ buffer, mimeType, schemaName, conversationId }) {
  if (!isVoiceStorageConfigured()) {
    logger.warn("[AiAssistant] ovozli xabar saqlanmadi: Spaces sozlanmagan");
    return null;
  }
  const key = buildVoiceKey({ schemaName, conversationId, mimeType });
  try {
    await fileStorage.uploadPrivateBuffer({ key, buffer, contentType: mimeType });
    return key;
  } catch (err) {
    logger.warn(`[AiAssistant] ovozli xabar Spaces'ga yuklanmadi: ${err.message}`, { conversationId });
    return null;
  }
}

/** Bazaga yozilmay qolgan klipni Spaces'dan o'chiradi (yetim fayl qolmasin). */
async function discardVoiceClip(key) {
  if (!key) return;
  try {
    await fileStorage.deleteObject(key);
  } catch (err) {
    logger.warn(`[AiAssistant] yetim ovozli fayl o'chirilmadi: ${err.message}`, { key });
  }
}

/** Egasining ovozli xabari (baytlar Spaces'dan, egalik tekshiruvidan keyin). */
async function getVoiceClip(messageId, ownerId) {
  const message = await assistantConversationService.getOwnedMessage(messageId, ownerId, { audio: true });
  if (!message.audio) throw new NotFoundError("Bu xabarda ovozli yozuv yo'q");
  let object;
  try {
    object = await fileStorage.getObjectBuffer(message.audio.storageKey);
  } catch (err) {
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
      throw new NotFoundError("Ovozli yozuv fayli topilmadi");
    }
    throw err;
  }
  return { mimeType: message.audio.mimeType, data: object.buffer };
}

/** Yordamchi javobini ovozda o'qiydi (faqat to'liq yakunlangan javob). */
async function speakMessage(messageId, ownerId, { signal } = {}) {
  const message = await assistantConversationService.getOwnedMessage(messageId, ownerId);
  if (message.role !== "assistant") throw new BadRequestError("Faqat yordamchi javobini ovozda o'qish mumkin");
  if (message.status !== "complete" || !message.content.trim()) {
    throw new BadRequestError("Bu javob to'liq emas — ovozda o'qib bo'lmaydi");
  }
  return synthesizeSpeech(message.content, { signal });
}

module.exports = {
  MIME_EXTENSIONS,
  extensionForMime,
  parseVoiceDuration,
  assertVoiceFile,
  transcribe,
  stripMarkdownForSpeech,
  cutAtSentence,
  synthesizeSpeech,
  isVoiceStorageConfigured,
  buildVoiceKey,
  storeVoiceClip,
  discardVoiceClip,
  getVoiceClip,
  speakMessage,
};
