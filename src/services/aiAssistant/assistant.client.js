/**
 * AI YORDAMCHI — OpenAI mijozi va xatolarni egaga tushunarli qilish.
 *
 * ⚠️ MIJOZ XATO OTADI, `null` QAYTARMAYDI (`diagnosticAi.service.js` dan
 * farqli). U yerda AI qo'shimcha qatlam va qoidalar zaxirasi bor; bu yerda
 * esa ega aynan AI bilan gaplashmoqchi — kalit yo'qligi "jim zaxira" emas,
 * aniq 503 xabari bo'lishi kerak.
 *
 * ⚠️ OpenAI xabari egaga KO'RSATILMAYDI: u inglizcha, ichida loyiha/tashkilot
 * identifikatorlari bo'lishi mumkin. Egaga faqat shu yerdagi o'zbekcha matn
 * boradi, xomi esa logga.
 */

const OpenAI = require("openai");
const { config } = require("../../config/env.config");

let _client = null;

/** Kalit bormi — `/status` va chat oldidan tekshiruv uchun. */
function isConfigured() {
  return Boolean(config.openaiApiKey);
}

/**
 * AI xizmati ishlamayotgani — 503. `code` SSE `error` hodisasidagi bilan
 * bir xil kalit, mijoz matndan emas, koddan qaror qiladi.
 */
class AssistantUnavailableError extends Error {
  constructor(message, code = "not_configured", statusCode = 503) {
    super(message);
    this.name = "AssistantUnavailableError";
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

const NOT_CONFIGURED_MESSAGE = "AI sozlanmagan: OPENAI_API_KEY kiritilmagan";

/** Yagona OpenAI mijozi (dangasa yaratiladi). */
function getClient() {
  if (!isConfigured()) {
    throw new AssistantUnavailableError(NOT_CONFIGURED_MESSAGE, "not_configured", 503);
  }
  if (!_client) _client = new OpenAI({ apiKey: config.openaiApiKey });
  return _client;
}

/**
 * Responses API OQIMI ICHIDA kelgan nosozlik: `response.failed`, `error`
 * hodisasi, `response.incomplete` yoki yakuniy hodisasiz uzilgan oqim.
 *
 * ⚠️ Bu HTTP xatosi EMAS: sarlavhalar 200 bilan kelgan, xato esa keyinroq
 * hodisa bo'lib keladi. SDK ularni o'zi otmaydi (faqat `data.error` bo'lsa
 * otadi), jim o'tkazib yuborilsa esa tur "bo'sh javob" bo'lib tugardi va
 * haqiqiy sabab (limit, token chegarasi) yo'qolardi.
 */
class ResponseStreamError extends Error {
  /**
   * @param {{ kind: "failed"|"error"|"incomplete"|"ended", code?: string|null, reason?: string|null, message?: string }} input
   */
  constructor({ kind, code = null, reason = null, message }) {
    super(message || `Responses oqimi: ${kind}${code ? ` (${code})` : ""}${reason ? ` — ${reason}` : ""}`);
    this.name = "ResponseStreamError";
    this.kind = kind;
    this.code = code;
    this.reason = reason;
  }
}

/** So'rov mijoz uzilgani (AbortSignal) sababli to'xtatilganmi. */
function isAbortError(err) {
  if (!err) return false;
  return err instanceof OpenAI.APIUserAbortError || err.name === "AbortError";
}

/**
 * Model umuman topilmadimi (yoki loyihaga ruxsat yo'qmi). Faqat shu holda
 * zaxira modelga o'tiladi — boshqa xatoda (limit, tarmoq) boshqa model
 * yordam bermaydi, faqat hisobni ikki barobar sarflaydi.
 */
function isModelNotFound(err) {
  if (err instanceof ResponseStreamError) return err.code === "model_not_found";
  if (!(err instanceof OpenAI.APIError)) return false;
  if (err.code === "model_not_found") return true;
  if (err.status === 404) return true;
  return err.status === 403 && /model/i.test(err.message || "");
}

/** Egaga boradigan xabarlar. Har chaqiruvda nusxa qaytariladi. */
const ERRORS = Object.freeze({
  timeout: {
    code: "timeout",
    message: "AI javobi belgilangan vaqtda kelmadi. Savolni qisqaroq qilib qayta yuboring.",
    statusCode: 504,
  },
  connection: {
    code: "model_unavailable",
    message: "AI xizmatiga ulanib bo'lmadi. Birozdan keyin qayta urinib ko'ring.",
    statusCode: 503,
  },
  quotaExceeded: {
    code: "quota_exceeded",
    message: "OpenAI hisobidagi limit tugagan. To'lov sozlamalarini tekshiring.",
    statusCode: 503,
  },
  rateLimited: {
    code: "rate_limited",
    message: "AI xizmati hozir juda band. Bir daqiqadan so'ng qayta urinib ko'ring.",
    statusCode: 429,
  },
  invalidKey: {
    code: "not_configured",
    message: "OpenAI kaliti yaroqsiz. OPENAI_API_KEY ni tekshiring.",
    statusCode: 503,
  },
  modelMissing: {
    code: "model_unavailable",
    message: "AI modeli bu kalit uchun mavjud emas. Model sozlamasini tekshiring.",
    statusCode: 503,
  },
  serverError: {
    code: "model_unavailable",
    message: "AI xizmatida vaqtinchalik nosozlik. Birozdan keyin qayta urinib ko'ring.",
    statusCode: 502,
  },
  streamEnded: {
    code: "model_unavailable",
    message: "AI javobi oxirigacha yetib kelmadi. Savolni qayta yuboring.",
    statusCode: 502,
  },
  contextTooLong: {
    code: "internal",
    message: "Suhbat va vosita natijalari model sig'imidan oshib ketdi. Yangi suhbatda aniqroq savol bering.",
    statusCode: 502,
  },
  outputLimit: {
    code: "internal",
    message: "Javob token chegarasiga yetib, yakunlanmay qoldi. Savolni toraytirib qayta yuboring.",
    statusCode: 502,
  },
  contentFilter: {
    code: "internal",
    message: "AI javobni xavfsizlik filtri sababli to'xtatdi. Savolni boshqacha ifodalab ko'ring.",
    statusCode: 502,
  },
  rejected: {
    code: "internal",
    message: "AI so'rovni qabul qilmadi. Savolni boshqacha ifodalab ko'ring.",
    statusCode: 502,
  },
  unexpected: {
    code: "internal",
    message: "Javob tayyorlashda kutilmagan xato yuz berdi.",
    statusCode: 500,
  },
});

/**
 * OpenAI xato KODI bo'yicha xabar. Responses oqimidagi xatolarda HTTP holati
 * yo'q — qaror faqat koddan chiqadi, shuning uchun HTTP va oqim yo'li shu
 * bitta jadvaldan o'qiydi.
 */
function errorForCode(code) {
  switch (code) {
    case "insufficient_quota":
      return ERRORS.quotaExceeded;
    case "rate_limit_exceeded":
      return ERRORS.rateLimited;
    case "model_not_found":
      return ERRORS.modelMissing;
    case "server_error":
      return ERRORS.serverError;
    case "context_length_exceeded":
      return ERRORS.contextTooLong;
    case "invalid_prompt":
      return ERRORS.rejected;
    default:
      return null;
  }
}

function mapStreamError(err) {
  if (err.kind === "incomplete") {
    if (err.reason === "max_output_tokens") return ERRORS.outputLimit;
    if (err.reason === "content_filter") return ERRORS.contentFilter;
    return ERRORS.streamEnded;
  }
  if (err.kind === "ended") return ERRORS.streamEnded;
  // `failed`/`error`: noma'lum kod — model tomonidagi nosozlik, so'rov emas.
  return errorForCode(err.code) || ERRORS.serverError;
}

/**
 * OpenAI xatosini SSE/HTTP uchun tayyor shaklga keltiradi.
 * @returns {{ code: string, message: string, statusCode: number }}
 */
function mapOpenAiError(err) {
  if (err instanceof AssistantUnavailableError) {
    return { code: err.code, message: err.message, statusCode: err.statusCode };
  }
  if (err instanceof ResponseStreamError) return { ...mapStreamError(err) };
  if (err instanceof OpenAI.APIConnectionTimeoutError) return { ...ERRORS.timeout };
  if (err instanceof OpenAI.APIConnectionError) return { ...ERRORS.connection };
  if (err instanceof OpenAI.APIError) {
    if (err.status === 429) {
      return { ...(err.code === "insufficient_quota" ? ERRORS.quotaExceeded : ERRORS.rateLimited) };
    }
    if (err.status === 401) return { ...ERRORS.invalidKey };
    if (isModelNotFound(err)) return { ...ERRORS.modelMissing };
    // Holatsiz APIError — SDK oqimdagi `{ error: {...} }` hodisasidan yasagan.
    const byCode = errorForCode(err.code);
    if (byCode) return { ...byCode };
    if (err.status >= 500) return { ...ERRORS.serverError };
    return { ...(err.status ? ERRORS.rejected : ERRORS.serverError) };
  }
  return { ...ERRORS.unexpected };
}

module.exports = {
  OpenAI,
  AssistantUnavailableError,
  ResponseStreamError,
  NOT_CONFIGURED_MESSAGE,
  isConfigured,
  getClient,
  isAbortError,
  isModelNotFound,
  mapOpenAiError,
};
