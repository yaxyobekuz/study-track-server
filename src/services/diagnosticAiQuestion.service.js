/**
 * DIAGNOSTIKA — AI SAVOL YOZADI.
 *
 * Kirish: fan, sinf bazasi, MAVZULAR RO'YXATI va qiyinlik bo'yicha
 * savollar soni. Chiqish: bankka yozishga tayyor savollar.
 *
 * ⚠️ MODEL BANKKA TO'G'RIDAN-TO'G'RI YOZMAYDI. Bu servis faqat MATN
 * qaytaradi; yozuvni `diagnosticQuestion.service.js` qiladi va savol
 * `review` holatida tushadi. Testga baribir faqat `approved` savol
 * tushadi (`diagnostics.moderate` — alohida ruxsat). Ya'ni AI savol
 * YOZADI, lekin uni O'ZI TASDIQLAMAYDI: bankning butun sifati aynan shu
 * ikki qadamning ajratilganidan kelib chiqadi.
 *
 * ⚠️ MAVZUDAN CHIQIB KETGAN SAVOL TASHLANADI. Har savol o'zining
 * `topicOrder` ini aytib kelishi shart va u SO'RALGAN mavzular ichida
 * bo'lishi kerak. Model boshqa mavzuni yozsa, savol "to'g'rilanmaydi" —
 * tashlanadi: aks holda "kelgan mavzudan o'tib ketmaslik" qoidasi
 * (`diagnosticTopicScope.service.js`) modelning xohishiga qolardi.
 *
 * ⚠️ TO'G'RI JAVOBI NOANIQ SAVOL HAM TASHLANADI, TUZATILMAYDI. Eski
 * generatorda (`ai.service.js`) to'g'ri variant bo'lmasa BIRINCHISI
 * to'g'ri deb belgilanardi — bu diagnostikada xato javob KALITI bo'lib
 * saqlanardi va o'sha savolga javob bergan HAR BIR o'quvchi jimgina
 * "xato" deb belgilanardi. Taxmin qilingan kalit kalitsizlikdan battar.
 *
 * ⚠️ VARIANTLAR ARALASHTIRILADI. Model to'g'ri javobni deyarli har doim
 * birinchi qilib yozadi; `shuffleOptions = false` bo'lgan testda bu
 * javob kalitini ochib berardi.
 *
 * ⚠️ `expert` DARAJA YOZILMAYDI. Odam uch so'z bilan o'ylaydi (oson /
 * o'rta / qiyin), bankdagi to'rtinchi pog'ona esa adaptiv tanlov uchun
 * va u qo'lda tanlangan, tekshirilgan savollarga qoldiriladi.
 */

const OpenAI = require("openai");
const { config } = require("../config/env.config");
const logger = require("../utils/logger");
const { BadRequestError } = require("../utils/errors");
const { normalizeText, shuffle } = require("../helpers/diagnostic.helpers");
const {
  LEVEL_KEYS,
  LEVEL_KEY_LABELS,
  spreadTopics,
} = require("../helpers/diagnosticBlueprint.helpers");
const { getDiagnosticSettings } = require("./settings.service");

/** Bitta so'rovda eng ko'p savol — javob token chegarasida kesilmasin. */
const QUESTIONS_PER_REQUEST = Math.min(
  Math.max(config.aiMaxQuestionsPerRequest || 20, 1),
  10,
);
/** Bitta so'rovda eng ko'p mavzu — prompt uzayib ketmasin. */
const TOPICS_PER_REQUEST = 8;
/** Bitta testni yig'ishda eng ko'p model chaqiruvi (pul va vaqt chegarasi). */
const MAX_REQUESTS_PER_BUILD = 30;
/** Bitta paketni to'ldirish uchun urinishlar. */
const MAX_ATTEMPTS_PER_BATCH = 2;

const AI_TIMEOUT_MS = 60000;
const AI_MAX_RETRIES = 1;
const TEMPERATURE = 0.7;

/** Variantlar soni — `single` savol uchun standart. */
const OPTION_COUNT = 4;

const TEXT_MIN = 8;
const TEXT_MAX = 2000;
const OPTION_MAX = 500;

let _client = null;

function _getClient() {
  if (!config.openaiApiKey) return null;
  if (!_client) _client = new OpenAI({ apiKey: config.openaiApiKey });
  return _client;
}

/**
 * ⚠️ IKKI BAYROQ: kalit (`OPENAI_API_KEY`) va sozlama
 * (`DiagnosticSettings.aiEnabled`). Kalit — texnik imkoniyat, sozlama —
 * maktabning qarori; ikkalasi ham "yo'q" deyishi mumkin.
 */
async function isEnabled() {
  if (!config.openaiApiKey) return false;
  const settings = await getDiagnosticSettings();
  return Boolean(settings.aiEnabled);
}

async function assertEnabled() {
  if (config.openaiApiKey && !(await getDiagnosticSettings()).aiEnabled) {
    throw new BadRequestError(
      "Diagnostikada AI o'chirilgan. Sozlamalarda yoqing yoki savollarni bankdan oling.",
    );
  }
  if (!config.openaiApiKey) {
    throw new BadRequestError(
      "AI sozlanmagan. Administrator OPENAI_API_KEY ni kiritishi kerak.",
    );
  }
}

// ─────────────────────────────────────────────
// PROMPT
// ─────────────────────────────────────────────

function _systemPrompt({ subjectName, grade, levelKey, count }) {
  return [
    "Sen tajribali o'qituvchi va test tuzuvchisan.",
    `Fan: ${subjectName}.`,
    grade ? `Sinf darajasi: ${grade}-sinf.` : "",
    `${count} ta "${LEVEL_KEY_LABELS[levelKey]}" darajadagi test savoli tuz.`,
    "Barcha savol va variant matnlari O'ZBEK tilida (lotin yozuvida) bo'lishi shart.",
    "QAT'IY SHARTLAR:",
    `1. Savol FAQAT berilgan mavzulardan bo'ladi. Boshqa mavzuga chiqma.`,
    `2. Har savolda "topicOrder" maydoni bo'lsin — savol tegishli mavzuning raqami (faqat berilgan raqamlardan).`,
    `3. Har savolda AYNAN ${OPTION_COUNT} ta variant bo'lsin va ulardan AYNAN BITTASIDA "isCorrect": true bo'lsin.`,
    "4. Variantlar bir-biridan farq qilsin; \"Barchasi to'g'ri\" yoki \"Hech biri\" kabi variant yozma.",
    "5. \"explanation\" — nega shu javob to'g'ri, bir-ikki gap.",
    "Javobni FAQAT JSON formatda qaytar, boshqa hech narsa yozma:",
    '{"questions":[{"topicOrder":1,"text":"savol matni","options":[{"text":"variant","isCorrect":true},{"text":"variant","isCorrect":false},{"text":"variant","isCorrect":false},{"text":"variant","isCorrect":false}],"explanation":"izoh"}]}',
  ]
    .filter(Boolean)
    .join("\n");
}

function _userPrompt(batch) {
  const lines = batch.map((entry) => {
    const topic = entry.topic;
    const parts = [`${topic.order}. ${topic.name}`];
    if (topic.description) parts.push(`   Mazmuni: ${topic.description}`);
    if (topic.book) parts.push(`   Kitob: ${topic.book}`);
    if (topic.level) parts.push(`   Daraja: ${topic.level}`);
    parts.push(`   Kerak: ${entry.count} ta savol`);
    return parts.join("\n");
  });

  return [
    "Mavzular (raqam — mavzu nomi):",
    lines.join("\n"),
    "",
    `Jami ${batch.reduce((sum, e) => sum + e.count, 0)} ta savol tuz va har savolda "topicOrder" ni to'g'ri ko'rsat.`,
  ].join("\n");
}

// ─────────────────────────────────────────────
// JAVOBNI TEKSHIRISH
// ─────────────────────────────────────────────

/**
 * Modelning bitta savolini tekshiradi.
 *
 * @returns {{ok: true, question: object}|{ok: false, reason: string}}
 */
function _validate(raw, { allowedOrders, levelKey }) {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "shakl" };

  const order = parseInt(raw.topicOrder, 10);
  if (Number.isNaN(order) || !allowedOrders.has(order)) {
    return { ok: false, reason: "mavzu" };
  }

  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (text.length < TEXT_MIN || text.length > TEXT_MAX) {
    return { ok: false, reason: "matn" };
  }

  const rawOptions = Array.isArray(raw.options) ? raw.options : [];
  const options = rawOptions
    .map((opt) => ({
      text: typeof opt?.text === "string" ? opt.text.trim().slice(0, OPTION_MAX) : "",
      isCorrect: opt?.isCorrect === true,
    }))
    .filter((opt) => opt.text.length > 0);

  if (options.length !== OPTION_COUNT) return { ok: false, reason: "variant" };

  // Takroriy variant — savol amalda uch variantli bo'lib qolardi.
  const unique = new Set(options.map((opt) => normalizeText(opt.text)));
  if (unique.size !== options.length) return { ok: false, reason: "takror variant" };

  // ⚠️ TUZATILMAYDI — tashlanadi (fayl sarlavhasidagi izoh).
  if (options.filter((opt) => opt.isCorrect).length !== 1) {
    return { ok: false, reason: "javob kaliti" };
  }

  const explanation =
    typeof raw.explanation === "string" && raw.explanation.trim()
      ? raw.explanation.trim().slice(0, 2000)
      : null;

  return {
    ok: true,
    question: {
      topicOrder: order,
      text,
      type: "single",
      difficulty: levelKey,
      explanation,
      options: shuffle(options).map((opt, position) => ({
        text: opt.text,
        isCorrect: opt.isCorrect,
        position,
      })),
    },
  };
}

async function _ask(system, user, { count }) {
  const client = _getClient();
  if (!client) return null;

  let completion;
  try {
    completion = await client.chat.completions.create(
      {
        model: config.openaiModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: TEMPERATURE,
        // Savol + 4 variant + izoh ≈ 300 token; zaxira bilan.
        max_tokens: Math.min(400 * count + 500, 8000),
      },
      { timeout: AI_TIMEOUT_MS, maxRetries: AI_MAX_RETRIES },
    );
  } catch (error) {
    logger.warn(`[DiagnosticAI] Savol generatsiyasi xatosi: ${error.message}`);
    return null;
  }

  const choice = completion.choices?.[0];
  /**
   * ⚠️ KESILGAN JAVOB PARSE QILINMAYDI (`diagnosticAi.service.js` dagi
   * AYNI qoida): yarim JSON ba'zan yaroqli ko'rinadi (massiv yopilib
   * qolgan) va yarim ro'yxat to'liq javob bo'lib chiqardi.
   */
  if (choice?.finish_reason === "length") {
    logger.warn("[DiagnosticAI] Javob token chegarasida kesildi");
    return null;
  }

  const content = choice?.message?.content;
  if (!content) return null;

  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed?.questions) ? parsed.questions : [];
  } catch {
    logger.warn("[DiagnosticAI] Javobni JSON sifatida o'qib bo'lmadi");
    return null;
  }
}

// ─────────────────────────────────────────────
// PAKETLAR
// ─────────────────────────────────────────────

/**
 * Qatorni model so'rovlariga bo'ladi.
 *
 * Har daraja alohida (prompt "oson savol tuz" deb aytishi kerak), har
 * so'rovda ko'pi bilan `TOPICS_PER_REQUEST` mavzu va
 * `QUESTIONS_PER_REQUEST` savol.
 */
function planBatches({ topics, counts }) {
  const batches = [];

  for (const levelKey of LEVEL_KEYS) {
    const want = Number(counts?.[levelKey]) || 0;
    if (want <= 0) continue;

    const spread = spreadTopics(topics, want);

    let current = [];
    let currentCount = 0;
    const flush = () => {
      if (current.length) batches.push({ levelKey, entries: current });
      current = [];
      currentCount = 0;
    };

    for (const entry of spread) {
      let left = entry.count;
      while (left > 0) {
        const room = QUESTIONS_PER_REQUEST - currentCount;
        if (room <= 0 || current.length >= TOPICS_PER_REQUEST) {
          flush();
          continue;
        }
        const take = Math.min(left, room);
        current.push({ topic: entry.topic, count: take });
        currentCount += take;
        left -= take;
      }
    }
    flush();
  }

  return batches;
}

/**
 * BITTA TAQSIMOT QATORI UCHUN SAVOLLAR YOZADI.
 *
 * @param {object} params
 * @param {{id: string, name: string}} params.subject
 * @param {number|null} params.grade
 * @param {Array} params.topics - qamrovdagi mavzular (`order` asc)
 * @param {{easy: number, medium: number, hard: number}} params.counts
 * @param {Set<string>} [params.seenText] - butun test bo'ylab takrorni ushlash
 * @param {{value: number}} [params.budget] - qolgan model chaqiruvlari
 * @returns {Promise<{items: Array, warnings: Array<string>, requests: number}>}
 */
async function generateForRow({
  subject,
  grade,
  topics,
  counts,
  language = "uz",
  seenText = new Set(),
  budget = { value: MAX_REQUESTS_PER_BUILD },
}) {
  const topicByOrder = new Map(topics.map((topic) => [topic.order, topic]));
  const batches = planBatches({ topics, counts });

  const items = [];
  const warnings = [];
  let requests = 0;
  const dropped = {};

  for (const batch of batches) {
    const want = batch.entries.reduce((sum, e) => sum + e.count, 0);
    const allowedOrders = new Set(batch.entries.map((e) => e.topic.order));
    let got = 0;

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_BATCH && got < want; attempt += 1) {
      if (budget.value <= 0) {
        warnings.push(
          `${subject.name}: AI chaqiruvlari chegarasiga yetildi — qolgan savollar yozilmadi`,
        );
        return { items, warnings, requests };
      }

      const remaining = want - got;
      const entries =
        attempt === 0
          ? batch.entries
          : // Qayta urinishda qolgan miqdor so'raladi, mavzular o'sha.
            batch.entries.map((e) => ({
              ...e,
              count: Math.max(1, Math.round((e.count * remaining) / want)),
            }));

      budget.value -= 1;
      requests += 1;

      const raw = await _ask(
        _systemPrompt({
          subjectName: subject.name,
          grade,
          levelKey: batch.levelKey,
          count: remaining,
        }),
        _userPrompt(entries),
        { count: remaining },
      );

      if (raw === null) continue;

      for (const candidate of raw) {
        if (got >= want) break;

        const result = _validate(candidate, {
          allowedOrders,
          levelKey: batch.levelKey,
        });
        if (!result.ok) {
          dropped[result.reason] = (dropped[result.reason] || 0) + 1;
          continue;
        }

        const key = normalizeText(result.question.text);
        if (!key || seenText.has(key)) {
          dropped.takror = (dropped.takror || 0) + 1;
          continue;
        }
        seenText.add(key);

        const topic = topicByOrder.get(result.question.topicOrder);
        items.push({
          subjectId: subject.id,
          topicId: topic?.id || null,
          topicOrder: result.question.topicOrder,
          topicName: topic?.name || null,
          grade: grade ?? null,
          language,
          text: result.question.text,
          type: result.question.type,
          difficulty: result.question.difficulty,
          explanation: result.question.explanation,
          options: result.question.options,
        });
        got += 1;
      }
    }

    if (got < want) {
      warnings.push(
        `${subject.name} · ${LEVEL_KEY_LABELS[batch.levelKey]}: ` +
          `${want} ta so'raldi, AI ${got} ta yarokli savol yozdi`,
      );
    }
  }

  /**
   * ⚠️ NIMA UCHUN TASHLANGANI AYTILADI. "18 tadan 12 tasi yozildi" degan
   * xabar sababsiz bo'lsa, admin promptni ham, mavzuni ham tuzatolmasdi.
   */
  const reasons = Object.entries(dropped)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${reason}: ${n}`);
  if (reasons.length) {
    warnings.push(`${subject.name}: tashlangan javoblar — ${reasons.join(", ")}`);
  }

  return { items, warnings, requests };
}

module.exports = {
  QUESTIONS_PER_REQUEST,
  TOPICS_PER_REQUEST,
  MAX_REQUESTS_PER_BUILD,
  OPTION_COUNT,
  isEnabled,
  assertEnabled,
  planBatches,
  generateForRow,
  _validate,
};
