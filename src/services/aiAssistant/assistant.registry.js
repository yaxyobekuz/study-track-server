/**
 * AI YORDAMCHI — vositalar va amallar registri.
 *
 * Domen fayllari (`tools/*.tools.js`, `actions/*.actions.js`) shu yerda
 * BIR MARTA yuklanadi. Registr:
 *   - har ta'rifni tekshiradi va nom to'qnashuvini aniqlaydi;
 *   - modelga har raundda faqat OCHIQ bo'limlarning sxemasini beradi;
 *   - vositani validatsiya + vaqt chegarasi + bekor qilish bilan ishga
 *     tushiradi va natijani yagona konvertga o'raydi;
 *   - `propose_*` chaqiruvlarini amal servisiga yo'naltiradi.
 *
 * ⚠️ BUZUQ DOMEN FAYLI SERVERNI YIQITMAYDI. Ta'rif xatosi yoki takroriy
 * nom `logger.error` bilan yoziladi va o'sha ta'rif (yoki fayl) tashlab
 * ketiladi: bitta bo'limdagi xato butun platformani (hamma filialni)
 * to'xtatib qo'ymasligi kerak. Xuddi shu muammolar `lintRegistry()` orqali
 * testda QIZIL bo'ladi — ya'ni jimgina o'tib ketmaydi.
 */

const { LIMITS, TOOLSETS, OPENABLE_TOOLSETS } = require("./assistant.constants");
const { AiToolError, validateArgs, lintSchema } = require("./assistant.toolkit");
const { toModelJson } = require("./assistant.sanitize");
const { currentMonthKey, todayIsoTashkent } = require("../../helpers/month.helpers");
const logger = require("../../utils/logger");

/** Registr yuklaydigan domenlar — aynan shu 14 fayl. */
const DOMAINS = Object.freeze(["overview", "people", "finance", "payroll", "academic", "schedule", "operations"]);

/**
 * Har domen faylida ruxsat etilgan bo'limlar (`design.md` §3). Boshqa
 * bo'limga yozilgan vosita "noto'g'ri tokchaga qo'yilgan" bo'ladi: model
 * uni kerakli bo'limni ochganda topa olmaydi.
 */
const ALLOWED_TOOLSETS = Object.freeze({
  tools: Object.freeze({
    overview: ["core"],
    people: ["core", "people"],
    finance: ["finance"],
    payroll: ["payroll"],
    academic: ["academic"],
    schedule: ["schedule"],
    operations: ["operations"],
  }),
  actions: Object.freeze({
    overview: [],
    people: ["people"],
    finance: ["finance"],
    payroll: ["payroll"],
    academic: ["academic"],
    schedule: ["schedule"],
    operations: ["operations"],
  }),
});

/** Ichki vosita: bo'limlarni ochish. */
const OPEN_TOOLSETS_NAME = "open_toolsets";
const OPEN_TOOLSETS_LABEL = "Bo'limlar ochilmoqda";

const OPEN_TOOLSETS_DEFINITION = Object.freeze({
  type: "function",
  function: {
    name: OPEN_TOOLSETS_NAME,
    description:
      "Open one or more toolsets so their tools become available from the next round. Use it before calling tools of a closed toolset. Returns the list of tools in each opened toolset.",
    parameters: {
      type: "object",
      properties: {
        toolsets: {
          type: "array",
          description: `Toolset keys to open (max ${LIMITS.maxActiveToolsets}).`,
          items: { type: "string", enum: [...OPENABLE_TOOLSETS] },
          minItems: 1,
          maxItems: LIMITS.maxActiveToolsets,
        },
      },
      required: ["toolsets"],
      additionalProperties: false,
    },
  },
});

/** Ta'rif chegaralari — bazadagi ustun kengligi bilan bir xil. */
const FIELD_LIMITS = Object.freeze({ type: 80, toolName: 64, title: 160, permission: 80, label: 80 });

let _registry = null;

function isToolDefinition(def) {
  return Boolean(def) && def.kind === "read" && typeof def.handler === "function";
}

function isActionDefinition(def) {
  return Boolean(def) && def.kind === "action" && typeof def.prepare === "function";
}

/** Bitta ta'rifning shakl muammolari (defineTool/defineAction dan tashqari). */
function lintDefinition(def, group, domain) {
  const problems = [];
  const name = group === "tools" ? def.name : def.toolName;
  const where = `${group}/${domain} "${name}"`;

  if (!ALLOWED_TOOLSETS[group][domain].includes(def.toolset)) {
    problems.push(`${where}: toolset "${def.toolset}" bu faylda ruxsat etilmagan`);
  }
  for (const issue of lintSchema(def.parameters)) problems.push(`${where}: ${issue}`);
  if (def.parameters?.additionalProperties !== false) {
    problems.push(`${where}: parameters.additionalProperties false bo'lishi shart`);
  }
  if (typeof def.timeoutMs !== "number" || def.timeoutMs <= 0) {
    problems.push(`${where}: timeoutMs musbat son bo'lsin`);
  }

  if (group === "tools") {
    if (typeof def.label !== "string" || !def.label.trim()) problems.push(`${where}: label yo'q`);
    else if (def.label.length > FIELD_LIMITS.label) problems.push(`${where}: label juda uzun`);
  } else {
    if (def.type.length > FIELD_LIMITS.type) problems.push(`${where}: type juda uzun`);
    if (def.toolName.length > FIELD_LIMITS.toolName) problems.push(`${where}: toolName juda uzun`);
    if (typeof def.title !== "string" || !def.title.trim()) problems.push(`${where}: title yo'q`);
    else if (def.title.length > FIELD_LIMITS.title) problems.push(`${where}: title juda uzun`);
    if (def.permission !== undefined && def.permission !== null) {
      if (typeof def.permission !== "string" || def.permission.length > FIELD_LIMITS.permission) {
        problems.push(`${where}: permission satr (≤ ${FIELD_LIMITS.permission}) bo'lsin`);
      }
    }
  }
  return problems;
}

/**
 * Domen fayllarini yuklaydi. Natija xotirada saqlanadi.
 * @returns {{ tools: Map, actions: Map, actionsByType: Map, problems: string[] }}
 */
function loadRegistry() {
  if (_registry) return _registry;

  const tools = new Map();
  const actions = new Map();
  const actionsByType = new Map();
  const problems = [];

  const reject = (message) => {
    problems.push(message);
    logger.error(`[AiAssistant] registr: ${message}`);
  };

  for (const domain of DOMAINS) {
    for (const group of ["tools", "actions"]) {
      const file = `./${group}/${domain}.${group}.js`;
      let exported;
      try {
        exported = require(file);
      } catch (err) {
        reject(`${file} yuklanmadi: ${err.message}`);
        continue;
      }
      if (!Array.isArray(exported)) {
        reject(`${file} massiv eksport qilmadi`);
        continue;
      }

      exported.forEach((def, index) => {
        const valid = group === "tools" ? isToolDefinition(def) : isActionDefinition(def);
        if (!valid) {
          reject(`${file}[${index}]: ${group === "tools" ? "defineTool" : "defineAction"} bilan yaratilmagan`);
          return;
        }
        const name = group === "tools" ? def.name : def.toolName;
        if (name === OPEN_TOOLSETS_NAME || tools.has(name) || actions.has(name)) {
          reject(`${file}: "${name}" nomi takrorlangan — ta'rif tashlab ketildi`);
          return;
        }
        if (group === "actions" && actionsByType.has(def.type)) {
          reject(`${file}: "${def.type}" amal turi takrorlangan — ta'rif tashlab ketildi`);
          return;
        }

        // Shakl muammolari (toolset tokchasi, uzunliklar) ta'rifni TASHLAMAYDI:
        // ular xavfsizlik emas, sifat masalasi va testda ushlanadi.
        for (const issue of lintDefinition(def, group, domain)) problems.push(issue);

        const entry = Object.freeze({ def, domain, file });
        if (group === "tools") {
          tools.set(name, entry);
        } else {
          actions.set(name, entry);
          actionsByType.set(def.type, entry);
        }
      });
    }
  }

  _registry = { tools, actions, actionsByType, problems };
  return _registry;
}

/** Testlar va diagnostika uchun: registrdagi barcha muammolar. */
function lintRegistry() {
  const { tools, actions, problems } = loadRegistry();
  return { problems: [...problems], toolCount: tools.size, actionCount: actions.size };
}

/** Faqat ma'lum, ochiladigan va takrorlanmagan bo'limlar (eng oxirgisi saqlanadi). */
function normalizeToolsets(list) {
  const result = [];
  for (const key of Array.isArray(list) ? list : []) {
    if (!OPENABLE_TOOLSETS.includes(key)) continue;
    const at = result.indexOf(key);
    if (at !== -1) result.splice(at, 1);
    result.push(key);
  }
  return result.slice(-LIMITS.maxActiveToolsets);
}

/**
 * Yangi bo'limlarni ochadi: allaqachon ochiqlari "eng yangi"ga ko'chadi,
 * chegaradan oshsa eng eskisi yopiladi.
 * @returns {string[]}
 */
function mergeToolsets(current, requested) {
  return normalizeToolsets([...(current || []), ...(requested || [])]);
}

function firstSentence(text) {
  const match = String(text || "").match(/^(.+?[.!?])(\s|$)/);
  return (match ? match[1] : String(text || "")).trim();
}

/** Bo'limdagi vositalar (model `open_toolsets` natijasida ko'radi). */
function describeToolset(key) {
  const { tools, actions } = loadRegistry();
  const list = [];
  for (const { def } of tools.values()) {
    if (def.toolset === key) list.push({ name: def.name, description: firstSentence(def.description) });
  }
  for (const { def } of actions.values()) {
    if (def.toolset === key) list.push({ name: def.toolName, description: firstSentence(def.description) });
  }
  return { key, label: TOOLSETS[key]?.label || key, tools: list };
}

/**
 * Modelga yuboriladigan vositalar: `core` + ochiq bo'limlar + `open_toolsets`.
 * @param {string[]} activeToolsets
 */
function getToolDefinitions(activeToolsets = []) {
  const { tools, actions } = loadRegistry();
  const visible = new Set(["core", ...normalizeToolsets(activeToolsets)]);
  const definitions = [];

  for (const { def } of tools.values()) {
    if (!visible.has(def.toolset)) continue;
    definitions.push({
      type: "function",
      function: { name: def.name, description: def.description, parameters: def.parameters },
    });
  }
  for (const { def } of actions.values()) {
    if (!visible.has(def.toolset)) continue;
    definitions.push({
      type: "function",
      function: { name: def.toolName, description: def.description, parameters: def.parameters },
    });
  }
  definitions.push(OPEN_TOOLSETS_DEFINITION);
  return definitions;
}

/**
 * Nom bo'yicha ta'rif. Yopiq bo'limdagi ma'lum vosita ham TOPILADI: model
 * uni oldingi turda ko'rgan bo'lishi mumkin, argumentlar esa baribir
 * validatsiyadan o'tadi — rad etish faqat bir raundni behuda sarflardi.
 * @returns {{ kind: "read"|"action"|"system", def: object|null }|null}
 */
function resolveTool(name) {
  if (name === OPEN_TOOLSETS_NAME) return { kind: "system", def: null };
  const { tools, actions } = loadRegistry();
  if (tools.has(name)) return { kind: "read", def: tools.get(name).def };
  if (actions.has(name)) return { kind: "action", def: actions.get(name).def };
  return null;
}

/** Amal turi bo'yicha ta'rif (tasdiqlashda). */
function getActionByType(type) {
  return loadRegistry().actionsByType.get(type)?.def || null;
}

/** UI qadam yorlig'i. */
function stepLabel(name) {
  const resolved = resolveTool(name);
  if (!resolved) return "Noma'lum vosita";
  if (resolved.kind === "system") return OPEN_TOOLSETS_LABEL;
  return resolved.kind === "read" ? resolved.def.label : resolved.def.title;
}

/** Model yuborgan argument satri → obyekt. */
function parseToolArguments(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiToolError("Argumentlar yaroqli JSON emas");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AiToolError("Argumentlar obyekt bo'lishi kerak");
  }
  return parsed;
}

/** Vaqt chegarasi xatosi — `statusCode` 504, egaga tushunarli matn. */
class AiTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiTimeoutError";
    this.statusCode = 504;
  }
}

/** Mijoz uzilgani sababli to'xtatildi. */
class AiAbortedError extends Error {
  constructor() {
    super("So'rov bekor qilindi");
    this.name = "AbortError";
    this.statusCode = 499;
  }
}

/**
 * Promise'ni vaqt chegarasi va AbortSignal bilan poygaga qo'yadi.
 *
 * ⚠️ Vaqt tugaganda ish FIZIK TO'XTAMAYDI (servis chaqiruvini bekor qilib
 * bo'lmaydi) — faqat natijasi kutilmaydi. Shu sababli yozadigan amalda
 * chaqiruvchi "bajarilmadi" emas, "natijani tekshiring" deb aytishi kerak.
 *
 * @param {() => Promise<*>} factory
 * @param {{ timeoutMs: number, signal?: AbortSignal, timeoutMessage: string }} options
 */
function withTimeout(factory, { timeoutMs, signal, timeoutMessage }) {
  if (signal?.aborted) return Promise.reject(new AiAbortedError());

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, new AiAbortedError());
    const timer = setTimeout(() => finish(reject, new AiTimeoutError(timeoutMessage)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    Promise.resolve()
      .then(factory)
      .then(
        (value) => finish(resolve, value),
        (err) => finish(reject, err),
      );
  });
}

/**
 * Xato → modelga va egaga ko'rsatiladigan o'zbekcha matn. 5xx ichki
 * tafsiloti (Prisma xabari, stack) tashqariga chiqmaydi.
 */
function publicErrorMessage(err, fallback) {
  if (err instanceof AiToolError) return err.message;
  if (err && Number.isInteger(err.statusCode) && err.statusCode < 500 && err.message) return err.message;
  if (err instanceof AiTimeoutError) return err.message;
  return fallback;
}

/** Vosita konteksti (`design.md` §2). */
function buildToolContext({ user, branch, conversationId, signal, now = new Date() }) {
  return Object.freeze({
    user,
    branch,
    conversationId,
    signal,
    now,
    monthKey: currentMonthKey(),
    today: todayIsoTashkent(),
  });
}

/**
 * Bitta vosita chaqiruvini bajaradi. HECH QACHON xato otmaydi — natija doim
 * konvert: `{ ok: true, data }` yoki `{ ok: false, error }`.
 *
 * @param {{ id: string, name: string, arguments: string }} call
 * @param {object} ctx — `buildToolContext` natijasi
 * @param {{
 *   onOpenToolsets: (keys: string[]) => { active: string[], opened: object[] },
 *   reserveActionSlot: () => boolean,
 *   emit?: (event: string, data: object) => void,
 * }} hooks
 * @returns {Promise<{ step: object, content: string, action: object|null }>}
 */
async function runTool(call, ctx, hooks) {
  const started = Date.now();
  const resolved = resolveTool(call.name);
  const step = {
    id: call.id,
    name: call.name,
    label: stepLabel(call.name),
    kind: resolved ? resolved.kind : "system",
    status: "running",
    durationMs: 0,
    error: null,
  };

  const done = (envelope, action = null) => {
    step.durationMs = Date.now() - started;
    step.status = envelope.ok ? "ok" : "error";
    step.error = envelope.ok ? null : envelope.error;
    return { step, content: toModelJson(envelope), action };
  };

  if (!resolved) {
    return done({ ok: false, error: `Unknown tool "${call.name}". Use only the tools provided.` });
  }

  let rawArgs;
  try {
    rawArgs = parseToolArguments(call.arguments);
  } catch (err) {
    return done({ ok: false, error: err.message });
  }

  try {
    if (resolved.kind === "system") {
      const args = validateArgs(OPEN_TOOLSETS_DEFINITION.function.parameters, rawArgs);
      const result = hooks.onOpenToolsets(args.toolsets);
      return done({ ok: true, data: result });
    }

    if (resolved.kind === "read") {
      const { def } = resolved;
      const args = validateArgs(def.parameters, rawArgs);
      const data = await withTimeout(() => def.handler(args, ctx), {
        timeoutMs: def.timeoutMs,
        signal: ctx.signal,
        timeoutMessage: `"${def.label}" ma'lumoti ${Math.round(def.timeoutMs / 1000)} soniyada kelmadi`,
      });
      return done({ ok: true, data: data === undefined ? null : data });
    }

    if (!hooks.reserveActionSlot()) {
      return done({
        ok: false,
        error: `Bitta javobda ko'pi bilan ${LIMITS.maxActionsPerTurn} ta amal taklif qilinadi`,
      });
    }
    // Lazy: amal servisi tasdiqlashda registrdan ta'rif oladi — yuqorida
    // require qilinsa ikki modul bir-birini yarim yuklangan holda ko'rardi.
    const assistantActionService = require("./assistantAction.service");
    const action = await assistantActionService.propose(resolved.def, rawArgs, ctx, { emit: hooks.emit });
    return done(
      {
        ok: true,
        data: { status: "awaiting_owner_confirmation", actionId: action.id, preview: action.preview },
      },
      action,
    );
  } catch (err) {
    // Servis signalni o'zi tinglab, o'z `AbortError` ini otgan bo'lishi mumkin.
    if (err instanceof AiAbortedError || (ctx.signal?.aborted && err?.name === "AbortError")) {
      return done({ ok: false, error: "Cancelled: the owner closed the connection." });
    }
    const message = publicErrorMessage(
      err,
      resolved.kind === "action"
        ? "Taklifni tayyorlashda kutilmagan xato yuz berdi"
        : "Ma'lumotni o'qishda kutilmagan xato yuz berdi",
    );
    if (err instanceof AiToolError || (Number.isInteger(err?.statusCode) && err.statusCode < 500)) {
      logger.warn(`[AiAssistant] ${call.name}: ${err.message}`);
    } else {
      logger.error(`[AiAssistant] ${call.name} xatosi: ${err?.message}`, { stack: err?.stack });
    }
    return done({ ok: false, error: message });
  }
}

module.exports = {
  DOMAINS,
  ALLOWED_TOOLSETS,
  OPEN_TOOLSETS_NAME,
  OPEN_TOOLSETS_LABEL,
  OPEN_TOOLSETS_DEFINITION,
  AiTimeoutError,
  AiAbortedError,
  loadRegistry,
  lintRegistry,
  normalizeToolsets,
  mergeToolsets,
  describeToolset,
  getToolDefinitions,
  resolveTool,
  getActionByType,
  stepLabel,
  parseToolArguments,
  withTimeout,
  publicErrorMessage,
  buildToolContext,
  runTool,
};
