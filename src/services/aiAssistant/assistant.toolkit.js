/**
 * AI YORDAMCHI — vosita (tool) va amal (action) shartnomasi.
 *
 * Bu fayl domen fayllari (`tools/*.tools.js`, `actions/*.actions.js`) va
 * yadro (registr, suhbat, amal servisi) orasidagi YAGONA shartnoma. Domen
 * fayllari faqat shu yerdagi `defineTool` / `defineAction` va yordamchilar
 * bilan yoziladi.
 *
 * ── O'QISH VOSITASI ────────────────────────────────────────────────────
 *   defineTool({
 *     name, toolset, label, description, parameters,
 *     timeoutMs?,                       // default LIMITS.toolTimeoutMs
 *     async handler(args, ctx) → JSON   // args validatsiyadan o'tgan
 *   })
 *
 * ── AMAL (model faqat TAKLIF qiladi) ───────────────────────────────────
 *   defineAction({
 *     type,        // "payroll.change_salary" — audit kaliti
 *     toolName,    // "propose_change_staff_salary" — model ko'radigan nom
 *     toolset, title, risk, description, parameters,
 *     permission?, // HTTP yo'lidagi ruxsat kaliti (audit uchun)
 *     async prepare(args, ctx) → { params, preview, fingerprint? }
 *     async execute(params, ctx) → { summary, details?, data? }
 *   })
 *
 * ⚠️ `prepare` HECH NARSA YOZMAYDI. U tasdiqdan oldin ham, tasdiq paytida
 * ham (holat o'zgarmaganini tekshirish uchun) chaqiriladi. Yozadigan
 * `prepare` bitta amalni ikki marta bajargan bo'lardi.
 *
 * ⚠️ `execute` MAVJUD SERVISNI chaqiradi — controller qanday chaqirsa
 * aynan shunday (aktyor, qo'shimcha tekshiruvlar). Biznes mantiqini bu
 * yerda qayta yozish ikki xil haqiqat manbai demakdir.
 */

const { LIMITS, RISK, TOOLSETS, TOOL_NAME_PATTERN } = require("./assistant.constants");
const { isValidId } = require("../../utils/objectId");
const { formatAmount } = require("../../helpers/money.helpers");
const {
  parseMonthKey,
  parseDayDate,
  currentMonthKey,
  formatMonthKey,
  todayIsoTashkent,
} = require("../../helpers/month.helpers");

// ─────────────────────────────────────────────────────────────────────────
// Xatolar
// ─────────────────────────────────────────────────────────────────────────

/**
 * Model va egaga ko'rsatiladigan xato. Xabar O'ZBEKCHA va aniq bo'lishi
 * shart: model uni egaga tushuntiradi ("Bu xodimda oylik qoidasi yo'q").
 *
 * `statusCode` 400 — xato "kutilgan" (validatsiya), log `warn` darajasida.
 */
class AiToolError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = "AiToolError";
    this.statusCode = 400;
    this.details = details;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// JSON Schema (kichik to'plam) — argument validatsiyasi
// ─────────────────────────────────────────────────────────────────────────

const SUPPORTED_KEYWORDS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
  "default",
]);

const SUPPORTED_TYPES = new Set(["object", "string", "integer", "number", "boolean", "array"]);

/**
 * Sxemaning o'zi to'g'ri yozilganini tekshiradi (registr va testlar uchun).
 * @returns {string[]} topilgan muammolar
 */
function lintSchema(schema, path = "parameters") {
  const problems = [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [`${path}: sxema obyekt emas`];
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) problems.push(`${path}: qo'llanmaydigan kalit "${key}"`);
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  for (const t of types) {
    if (!SUPPORTED_TYPES.has(t)) problems.push(`${path}: noma'lum tur "${t}"`);
  }
  if (schema.type === "object") {
    const props = schema.properties || {};
    for (const [name, sub] of Object.entries(props)) {
      problems.push(...lintSchema(sub, `${path}.${name}`));
      if (!sub.description && path === "parameters") {
        problems.push(`${path}.${name}: "description" yo'q`);
      }
    }
    for (const req of schema.required || []) {
      if (!props[req]) problems.push(`${path}: required "${req}" properties ichida yo'q`);
    }
  }
  if (schema.type === "array") {
    if (!schema.items) problems.push(`${path}: array uchun "items" yo'q`);
    else problems.push(...lintSchema(schema.items, `${path}[]`));
  }
  if (schema.enum && !Array.isArray(schema.enum)) problems.push(`${path}: enum massiv emas`);
  if (schema.pattern) {
    try {
      new RegExp(schema.pattern);
    } catch {
      problems.push(`${path}: pattern noto'g'ri`);
    }
  }
  return problems;
}

function typeOfValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

/**
 * Qiymatni sxema bo'yicha tekshiradi va NORMALLASHTIRADI:
 *  - raqamli satr ("202609") → son (integer/number uchun);
 *  - "true"/"false" → boolean;
 *  - satrlar `trim` qilinadi;
 *  - `additionalProperties: false` bo'lsa noma'lum kalitlar TASHLANADI
 *    (xato emas: model ba'zan ortiqcha maydon qo'shadi);
 *  - `null` yoki bo'sh satr ixtiyoriy maydon uchun "berilmagan" hisoblanadi.
 *
 * @throws {AiToolError} birinchi topilgan muammo bilan
 */
function validateArgs(schema, input, path = "") {
  const label = path || "argumentlar";
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];

  let value = input;

  if (types.includes("string") && typeof value === "string") {
    value = value.trim();
  }
  if ((types.includes("integer") || types.includes("number")) && typeof value === "string") {
    const trimmed = value.trim().replace(/\s+/g, "");
    if (trimmed !== "" && !Number.isNaN(Number(trimmed))) value = Number(trimmed);
  }
  if (types.includes("boolean") && typeof value === "string") {
    if (value === "true") value = true;
    else if (value === "false") value = false;
  }

  const actual = typeOfValue(value);
  const typeOk = types.some((t) => {
    if (t === "number") return actual === "number" || actual === "integer";
    return t === actual;
  });
  if (!typeOk) {
    throw new AiToolError(`${label}: ${types.join("|")} kutilgan, ${actual} berildi`);
  }

  if (schema.enum && !schema.enum.includes(value)) {
    throw new AiToolError(`${label}: ruxsat etilgan qiymatlar — ${schema.enum.join(", ")}`);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AiToolError(`${label}: son yaroqsiz`);
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new AiToolError(`${label}: ${schema.minimum} dan kichik bo'lmasin`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new AiToolError(`${label}: ${schema.maximum} dan katta bo'lmasin`);
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new AiToolError(`${label}: kamida ${schema.minLength} belgi bo'lsin`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new AiToolError(`${label}: ko'pi bilan ${schema.maxLength} belgi bo'lsin`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new AiToolError(`${label}: formati noto'g'ri`);
    }
  }

  if (actual === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new AiToolError(`${label}: kamida ${schema.minItems} ta element bo'lsin`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new AiToolError(`${label}: ko'pi bilan ${schema.maxItems} ta element bo'lsin`);
    }
    return value.map((item, i) => validateArgs(schema.items, item, `${label}[${i}]`));
  }

  if (actual === "object") {
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    const out = {};
    for (const [key, sub] of Object.entries(props)) {
      const raw = value[key];
      const missing = raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
      if (missing) {
        if (required.has(key)) {
          throw new AiToolError(`${path ? `${path}.` : ""}${key}: majburiy maydon`);
        }
        if (sub.default !== undefined) out[key] = sub.default;
        continue;
      }
      out[key] = validateArgs(sub, raw, path ? `${path}.${key}` : key);
    }
    if (schema.additionalProperties !== false) {
      for (const [key, raw] of Object.entries(value)) {
        if (!(key in props)) out[key] = raw;
      }
    }
    return out;
  }

  return value;
}

// ─────────────────────────────────────────────────────────────────────────
// Ta'riflar
// ─────────────────────────────────────────────────────────────────────────

function assertCommon(def, kind) {
  const where = `${kind} "${def?.name || def?.toolName || def?.type || "?"}"`;
  const problems = [];
  if (!def || typeof def !== "object") throw new Error(`${where}: ta'rif obyekt emas`);
  if (!TOOLSETS[def.toolset]) problems.push(`noma'lum toolset "${def.toolset}"`);
  if (!def.description || def.description.length < 20) problems.push("description juda qisqa");
  if (def.description && def.description.length > 1024) problems.push("description 1024 belgidan uzun");
  if (!def.parameters || def.parameters.type !== "object") {
    problems.push('parameters { type: "object" } bo\'lishi shart');
  } else {
    problems.push(...lintSchema(def.parameters));
  }
  if (problems.length) throw new Error(`${where}: ${problems.join("; ")}`);
}

/**
 * O'qish vositasi. Faqat o'qiydi — hech qanday yozuv, xabar yuborish yoki
 * "o'qish" nomi ostida yashiringan `upsert` dan tashqari yon ta'sir yo'q.
 */
function defineTool(def) {
  assertCommon(def, "tool");
  if (!TOOL_NAME_PATTERN.test(def.name || "")) throw new Error(`tool "${def.name}": nom formati noto'g'ri`);
  if (def.name.startsWith("propose_")) throw new Error(`tool "${def.name}": "propose_" faqat amallar uchun`);
  if (!def.label) throw new Error(`tool "${def.name}": label (UI uchun o'zbekcha) yo'q`);
  if (typeof def.handler !== "function") throw new Error(`tool "${def.name}": handler yo'q`);
  return Object.freeze({ kind: "read", timeoutMs: LIMITS.toolTimeoutMs, ...def });
}

/**
 * Amal. Model uni `toolName` orqali TAKLIF qiladi, server `prepare` bilan
 * ko'rinish quradi, ega tasdiqlagandan keyin `execute` bajariladi.
 */
function defineAction(def) {
  assertCommon(def, "action");
  if (!/^[a-z][a-zA-Z]*\.[a-z][a-z_]*$/.test(def.type || "")) {
    throw new Error(`action "${def.type}": type "<bo'lim>.<amal>" shaklida bo'lsin`);
  }
  if (!TOOL_NAME_PATTERN.test(def.toolName || "") || !def.toolName.startsWith("propose_")) {
    throw new Error(`action "${def.type}": toolName "propose_..." bilan boshlansin`);
  }
  if (!def.title) throw new Error(`action "${def.type}": title yo'q`);
  if (!RISK[def.risk]) throw new Error(`action "${def.type}": risk low|medium|high|critical`);
  if (typeof def.prepare !== "function" || typeof def.execute !== "function") {
    throw new Error(`action "${def.type}": prepare va execute majburiy`);
  }
  return Object.freeze({ kind: "action", timeoutMs: LIMITS.toolTimeoutMs, ...def });
}

// ─────────────────────────────────────────────────────────────────────────
// Yordamchilar (domen fayllari uchun)
// ─────────────────────────────────────────────────────────────────────────

/** 24-hex id sxemasi. */
const idSchema = (description) => ({
  type: "string",
  pattern: "^[a-fA-F0-9]{24}$",
  description,
});

/** YYYYMM oy sxemasi (model 202609 yoki "2026-09" yuborishi mumkin). */
const monthSchema = (description = "Month as YYYYMM integer, e.g. 202609. Omit for the current month.") => ({
  type: ["integer", "string"],
  description,
});

/** "YYYY-MM-DD" kun sxemasi. */
const daySchema = (description) => ({
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description,
});

/** Ro'yxat chegarasi sxemasi. */
const limitSchema = (max = 50, description = "Maximum rows to return.") => ({
  type: "integer",
  minimum: 1,
  maximum: max,
  description: `${description} Default ${Math.min(20, max)}, max ${max}.`,
});

/** Id ni tekshiradi. */
function requireId(value, label = "id") {
  if (!isValidId(value)) throw new AiToolError(`${label} noto'g'ri formatda`);
  return value;
}

/** Oy kaliti (bo'sh → joriy oy, Toshkent). */
function monthArg(value, label = "Oy") {
  if (value === undefined || value === null || value === "") return currentMonthKey();
  try {
    return parseMonthKey(value, label);
  } catch (err) {
    throw new AiToolError(err.message);
  }
}

/** Kun ("YYYY-MM-DD"). Bo'sh → bugun (Toshkent). Qaytaradi: satr. */
function dayArg(value, label = "Sana") {
  if (value === undefined || value === null || value === "") return todayIsoTashkent();
  try {
    parseDayDate(value, label);
  } catch (err) {
    throw new AiToolError(err.message);
  }
  return value;
}

/**
 * Servislar `req` oladi va faqat `req.query` ni o'qiydi. Qiymatlar HTTP
 * dagidek SATR bo'lishi kerak (`activeOnly: "true"`), `limit` doim
 * aniq beriladi (servisda yuqori chegara yo'q).
 */
function reqLike(ctx, query = {}, extra = {}) {
  const q = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    q[key] = Array.isArray(value) ? value.map(String) : String(value);
  }
  if (!q.limit) q.limit = "20";
  return { query: q, params: {}, body: {}, user: ctx.user, branch: ctx.branch, ...extra };
}

/** Pul: "450000.00" → "450 000 so'm". Faqat KO'RSATISH uchun (hisob-kitob emas). */
function formatMoneyUz(value) {
  if (value === undefined || value === null || value === "") return "—";
  const fixed = formatAmount(value);
  const [intPart, frac] = fixed.split(".");
  const negative = intPart.startsWith("-");
  const digits = negative ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const tail = frac && frac !== "00" ? `,${frac}` : "";
  return `${negative ? "−" : ""}${grouped}${tail} so'm`;
}

/** Oy yorlig'i: 202609 → "Sentabr, 2026". */
const monthLabel = (key) => (key ? formatMonthKey(key) : "—");

/**
 * Uzun ro'yxatni kesadi va model "hammasi shu" deb o'ylamasligi uchun
 * belgi qo'yadi. Sukut bo'yicha kesish JIM bo'lmasligi kerak.
 */
function sliceList(items, max) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= max) return { items: list, total: list.length, truncated: false };
  return { items: list.slice(0, max), total: list.length, truncated: true };
}

/** Obyektdan faqat kerakli kalitlarni oladi (PII ni modelga yubormaslik uchun). */
function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const key of keys) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
}

/** Foydalanuvchi ismi (select bilan `fullName` virtual maydoni kelmaydi). */
function personName(user) {
  if (!user) return "—";
  return user.fullName || [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || "—";
}

module.exports = {
  AiToolError,
  defineTool,
  defineAction,
  validateArgs,
  lintSchema,
  idSchema,
  monthSchema,
  daySchema,
  limitSchema,
  requireId,
  monthArg,
  dayArg,
  reqLike,
  formatMoneyUz,
  monthLabel,
  sliceList,
  pick,
  personName,
};
