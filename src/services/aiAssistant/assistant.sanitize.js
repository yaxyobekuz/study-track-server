/**
 * AI YORDAMCHI — modelga (va bazaga) ketadigan JSON ni tozalash.
 *
 * ⚠️ BU OXIRGI HIMOYA QATLAMI, ASOSIY EMAS. Vositalar maxfiy maydonni
 * umuman qaytarmasligi kerak (`design.md` §3.1). Bu yerda esa "unutilgan"
 * `password` yoki `token` OpenAI'ga ketib qolmasligi kafolatlanadi.
 *
 * ⚠️ HAJM CHEGARASI JIM KESMAYDI. Qisqartirilgan massiv oxiriga
 * `{ _truncated: true, total }` belgisi qo'yiladi: model "hammasi shu" deb
 * xulosa chiqarmasligi kerak.
 */

const { LIMITS } = require("./assistant.constants");

const SECRET_KEY_PATTERN =
  /^(password|plainPassword|passwordHash|token|accessToken|refreshToken|jti|tokenJti|secret|apiKey|botToken|otp)$/i;

const MAX_DEPTH = 10;
/** Saqlash rejimi faqat aylanma/cheksiz tuzilmadan himoyalanadi. */
const MAX_STORAGE_DEPTH = 32;
const MAX_STRING_CHARS = 2000;
const MAX_ARRAY_ITEMS = 100;

/** Prisma Decimal (ikki client — ikki klass, shuning uchun shakl bo'yicha). */
function isDecimalLike(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.toFixed === "function" &&
    Array.isArray(value.d) &&
    typeof value.e === "number" &&
    typeof value.s === "number"
  );
}

function isBinary(value) {
  return Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer;
}

function truncateString(value) {
  return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
}

/** Model uchun: sirlar tashlanadi, uzun satr va massivlar kesiladi. */
const MODEL_MODE = Object.freeze({ lossy: true });
/**
 * Bazaga amal argumentlari uchun: HECH NARSA KESILMAYDI va kalitlar
 * tashlanmaydi — faqat JSON'ga sig'maydigan turlar o'giriladi.
 *
 * ⚠️ NEGA ALOHIDA REJIM: `args`/`params` ega tasdiqlagan narsaning AYNAN
 * o'zi. Kesilgan 2000+ belgili xabar yoki 100+ o'quvchili ro'yxat
 * tasdiqdan keyin boshqa (qisqargan) amal bo'lib bajarilardi, iz
 * (fingerprint) esa kesilgan qism o'zgarishini sezmasdi.
 */
const STORAGE_MODE = Object.freeze({ lossy: false });

/**
 * Chuqur tozalash: binar, funksiyalar tashlanadi; Decimal, BigInt, Date —
 * satrga. `lossy` rejimda sirli kalitlar ham tashlanadi, uzun satr va
 * massivlar kesiladi.
 * @returns {*} JSON-xavfsiz qiymat (`undefined` — "tashlansin")
 */
function sanitizeValue(value, depth = 0, seen = new WeakSet(), mode = MODEL_MODE) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "undefined" || type === "function" || type === "symbol") return undefined;
  if (type === "string") return mode.lossy ? truncateString(value) : value;
  if (type === "number") return Number.isFinite(value) ? value : null;
  if (type === "boolean") return value;
  if (type === "bigint") return value.toString();

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (isDecimalLike(value)) return value.toFixed();
  if (isBinary(value)) return undefined;

  if (depth >= (mode.lossy ? MAX_DEPTH : MAX_STORAGE_DEPTH)) {
    if (mode.lossy) return "[truncated: too deep]";
    throw new Error("Amal ma'lumoti juda chuqur ichma-ich tuzilgan");
  }
  if (seen.has(value)) {
    if (mode.lossy) return "[circular]";
    throw new Error("Amal ma'lumotida aylanma havola bor");
  }
  seen.add(value);

  try {
    if (value instanceof Map) {
      return sanitizeValue(Object.fromEntries(value), depth, seen, mode);
    }
    if (value instanceof Set) {
      return sanitizeValue([...value], depth, seen, mode);
    }
    if (Array.isArray(value)) {
      const source = mode.lossy ? value.slice(0, MAX_ARRAY_ITEMS) : value;
      const items = [];
      for (const item of source) {
        const clean = sanitizeValue(item, depth + 1, seen, mode);
        items.push(clean === undefined ? null : clean);
      }
      if (mode.lossy && value.length > MAX_ARRAY_ITEMS) items.push({ _truncated: true, total: value.length });
      return items;
    }

    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      if (mode.lossy && SECRET_KEY_PATTERN.test(key)) continue;
      const clean = sanitizeValue(raw, depth + 1, seen, mode);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  } finally {
    // Aylanma havola faqat O'Z yo'lida aniqlanadi: bir obyekt ikki joyda
    // uchrasa (masalan bir xil sinf ikki o'quvchida), ikkinchisi ham chiqsin.
    seen.delete(value);
  }
}

/** Tozalangan va kesilgan qiymat (model, ko'rinish natijasi). */
function toJsonSafe(value) {
  const clean = sanitizeValue(value);
  return clean === undefined ? null : clean;
}

/**
 * Amal `args`/`params`/iz uchun YO'QOTISHSIZ JSON (`STORAGE_MODE` izohi).
 * @throws {Error} aylanma havola yoki haddan tashqari chuqurlikda
 */
function toStorableJson(value) {
  const clean = sanitizeValue(value, 0, new WeakSet(), STORAGE_MODE);
  return clean === undefined ? null : clean;
}

const isTruncationMarker = (item) =>
  item !== null && typeof item === "object" && !Array.isArray(item) && item._truncated === true;

/** Qiymat ichidagi barcha massivlar (havolalari bilan). */
function collectArrays(value, out = []) {
  if (Array.isArray(value)) {
    out.push(value);
    for (const item of value) collectArrays(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectArrays(item, out);
  }
  return out;
}

const realLength = (arr) => (arr.length && isTruncationMarker(arr[arr.length - 1]) ? arr.length - 1 : arr.length);

/** Eng uzun massivni ikki barobar qisqartiradi. O'zgarish bo'lmasa `false`. */
function halveLongestArray(value) {
  let target = null;
  let targetLength = 1;
  for (const arr of collectArrays(value)) {
    const len = realLength(arr);
    if (len > targetLength) {
      target = arr;
      targetLength = len;
    }
  }
  if (!target) return false;

  const hasMarker = realLength(target) !== target.length;
  const originalTotal = hasMarker ? target[target.length - 1].total : targetLength;
  const keep = Math.ceil(targetLength / 2);
  target.splice(keep);
  target.push({ _truncated: true, total: originalTotal });
  return true;
}

/**
 * Vosita natijasi → modelga ketadigan JSON satr (hajm chegarasi bilan).
 * @param {*} value
 * @param {number} [maxChars]
 * @returns {string}
 */
function toModelJson(value, maxChars = LIMITS.maxToolResultChars) {
  const clean = toJsonSafe(value);
  let json = JSON.stringify(clean);
  if (json.length <= maxChars) return json;

  if (clean !== null && typeof clean === "object") {
    while (json.length > maxChars && halveLongestArray(clean)) {
      json = JSON.stringify(clean);
    }
    if (json.length <= maxChars) return json;
  }

  return JSON.stringify({ _truncated: true, preview: json.slice(0, Math.max(0, maxChars - 200)) });
}

/**
 * `xss-clean` JSON matnidagi `<` ni `&lt;` ga aylantiradi. Chat matni va
 * sarlavha HTML sifatida chizilmaydi (frontend markdown'ni xavfsiz
 * render qiladi), shuning uchun egasi yozgan "x < 5" aynan shunday qaytadi.
 */
function decodeXssText(value) {
  return typeof value === "string" ? value.replace(/&lt;/g, "<") : value;
}

module.exports = {
  SECRET_KEY_PATTERN,
  sanitizeValue,
  toJsonSafe,
  toStorableJson,
  toModelJson,
  decodeXssText,
};
