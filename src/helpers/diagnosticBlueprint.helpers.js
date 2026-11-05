/**
 * DIAGNOSTIKA — SAVOLLAR TAQSIMOTI (BLUEPRINT).
 *
 * Taqsimot — "qaysi fandan, qaysi sinf bazasidan, QAYSI MAVZULAR
 * ORALIG'IDAN, nechta yengil / o'rta / og'ir savol va ularni QAYERDAN
 * olish (bank yoki AI)" degan qoida. Test shu qoidadan quriladi.
 *
 * ⚠️ BU FAYLDA BAZA SO'ROVI YO'Q — faqat tekshiruv va arifmetika.
 * Mavzu o'rni (`currentTopicNumber`) `diagnosticTopicScope.service.js`
 * da hal qilinadi, savol tanlash `diagnosticTest.service.js` da. Qoida
 * uch joyda tekshirilmasin: taqsimotning shakli BITTA joyda yoziladi.
 *
 * ⚠️ "OG'IR" IKKI BANK DARAJASINI QAMRAYDI (`hard` + `expert`).
 * `DiagnosticLevel` to'rt pog'onali (adaptiv tanlov uchun), odam esa
 * uchta so'z bilan o'ylaydi: oson / o'rta / qiyin. Bankda `expert`
 * savollar kam va ularni alohida ustun qilib so'rash o'qituvchini har
 * safar "yetarli savol yo'q" xatosiga urardi.
 */

const { BadRequestError } = require("../utils/errors");

/** Savol QAYERDAN olinadi — admin har qator uchun ongli tanlaydi. */
const BLUEPRINT_SOURCES = ["bank", "ai"];

const SOURCE_LABELS = {
  bank: "Bankdan",
  ai: "AI yozadi",
};

/**
 * MAVZU QAMROVI.
 *
 * `current` — 1-mavzudan sinfning HOZIRGI KELGAN mavzusigacha.
 * `range`   — aniq oraliq, lekin yuqori chegarasi baribir joriy
 *             mavzudan oshmaydi (qoida `diagnosticTopicScope` da).
 *
 * ⚠️ UCHINCHI REJIM ("hammasi") ATAYLAB YO'Q. Modulning butun va'dasi —
 * o'quvchi O'TGAN materialdan so'ralishi; "hamma mavzudan" degan tanlov
 * qoidani bir bosishda bekor qilardi.
 */
const TOPIC_MODES = ["current", "range"];

const TOPIC_MODE_LABELS = {
  current: "Hozirgi mavzugacha",
  range: "Mavzular oralig'i",
};

/** Odam o'ylaydigan uch daraja va ularning bankdagi qiyinliklari. */
const LEVEL_KEYS = ["easy", "medium", "hard"];

const LEVEL_POOLS = {
  easy: ["easy"],
  medium: ["medium"],
  hard: ["hard", "expert"],
};

const LEVEL_KEY_LABELS = {
  easy: "Oson",
  medium: "O'rta",
  hard: "Qiyin",
};

/** Bitta darajada eng ko'p savol va butun testdagi chegara. */
const MAX_PER_LEVEL = 100;
/** `DiagnosticTest.questionCount` chegarasi bilan AYNI (1..100). */
const MAX_TOTAL = 100;
/** Bitta testda eng ko'p fan qatori — prompt va so'rov sonini cheklaydi. */
const MAX_ROWS = 12;

/** Mavzu tartib raqami — `Topic.order` (1 dan boshlanadi). */
const MAX_TOPIC_ORDER = 100000;

function _int(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

function _count(value, field) {
  const n = _int(value) ?? 0;
  if (n < 0) throw new BadRequestError(`${field}: savol soni manfiy bo'lmaydi`);
  if (n > MAX_PER_LEVEL) {
    throw new BadRequestError(`${field}: bitta darajada ${MAX_PER_LEVEL} tadan ko'p savol bo'lmaydi`);
  }
  return n;
}

/** Qatordagi jami savol soni. */
function rowTotal(row) {
  return LEVEL_KEYS.reduce((sum, key) => sum + (Number(row?.[key]) || 0), 0);
}

/** `{ easy: 5, medium: 10, hard: 5 }` — nollari tashlanmaydi (hisobot uchun). */
function levelCounts(row) {
  return Object.fromEntries(LEVEL_KEYS.map((key) => [key, Number(row?.[key]) || 0]));
}

/**
 * Taqsimotni o'qiydi va TEKSHIRADI.
 *
 * ⚠️ YAROQSIZ QATOR JIM TASHLANMAYDI — xato qaytariladi. Ilgari
 * `.filter()` bilan tashlanardi: fanni tanlamagan odam "test yaratildi"
 * degan xabarni olar, testda esa o'sha fan bo'lmasdi.
 *
 * ⚠️ `legacy: true` — ESKI YO'L (`POST`/`PUT /diagnostic-tests`) uchun va
 * u IKKI narsani yumshatadi:
 *   1. mavzu qamrovi talab qilinmaydi (testlar hech qachon mavzuga
 *      bog'lanmagan edi va majburan `current` qo'yilsa bugungacha ishlab
 *      turgan oynalar jimgina yiqilardi);
 *   2. to'liqsiz qator (fansiz yoki hammasi nol) XATO EMAS, TASHLANADI —
 *      o'sha yo'lning avvalgi xatti-harakati aynan shunday edi.
 * Yangi yo'lda ikkalasi ham QAT'IY: qamrov majburiy, yaroqsiz qator xato.
 * Tekshiruvning o'zi esa BITTA — ikki nusxa bo'lsa, biriga qo'shilgan
 * shart ikkinchisida tushib qolardi.
 *
 * @param {Array} raw
 * @param {{legacy?: boolean}} options
 * @returns {Array|null} normallashtirilgan qatorlar (bo'sh bo'lsa null)
 */
function parseBlueprint(raw, { legacy = false } = {}) {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const input0 = legacy
    ? raw.filter((row) => row?.subjectId && rowTotal(row) > 0)
    : raw;
  if (input0.length === 0) return null;

  if (input0.length > MAX_ROWS) {
    throw new BadRequestError(`Bitta testda ${MAX_ROWS} tadan ko'p fan qatori bo'lmaydi`);
  }

  const rows = input0.map((input, index) => {
    const nth = `${index + 1}-qator`;
    const row = input || {};

    const subjectId = row.subjectId ? String(row.subjectId) : null;
    if (!subjectId) throw new BadRequestError(`${nth}: fan tanlanmagan`);

    const grade = _int(row.grade);
    if (grade !== null && (grade < 1 || grade > 11)) {
      throw new BadRequestError(`${nth}: sinf darajasi 1 dan 11 gacha bo'lishi kerak`);
    }

    const source = row.source ? String(row.source) : "bank";
    if (!BLUEPRINT_SOURCES.includes(source)) {
      throw new BadRequestError(`${nth}: noma'lum savol manbasi "${source}"`);
    }

    const counts = {
      easy: _count(row.easy, nth),
      medium: _count(row.medium, nth),
      hard: _count(row.hard, nth),
    };
    const total = rowTotal(counts);
    if (total <= 0) {
      throw new BadRequestError(`${nth}: hech bo'lmasa bitta darajada savol soni kiritilsin`);
    }

    const parsed = { subjectId, grade, source, ...counts };

    // ── MAVZU QAMROVI ────────────────────────
    const rawMode = row.topicMode ? String(row.topicMode) : null;
    if (!rawMode) {
      if (!legacy) throw new BadRequestError(`${nth}: mavzu qamrovi tanlanmagan`);
      // Eski yo'l: qamrov yo'q — savol butun fan bo'yicha olinadi.
      parsed.topicMode = null;
      parsed.topicFrom = null;
      parsed.topicTo = null;
      return parsed;
    }

    if (!TOPIC_MODES.includes(rawMode)) {
      throw new BadRequestError(`${nth}: noma'lum mavzu qamrovi "${rawMode}"`);
    }
    parsed.topicMode = rawMode;

    if (rawMode === "current") {
      // Chegara sinfning joriy mavzusidan olinadi — bu yerda emas.
      parsed.topicFrom = 1;
      parsed.topicTo = null;
      return parsed;
    }

    const from = _int(row.topicFrom);
    const to = _int(row.topicTo);
    if (from === null || to === null) {
      throw new BadRequestError(`${nth}: mavzular oralig'ining ikkala chegarasi kiritilsin`);
    }
    if (from < 1 || to < 1 || from > MAX_TOPIC_ORDER || to > MAX_TOPIC_ORDER) {
      throw new BadRequestError(`${nth}: mavzu raqami 1 dan ${MAX_TOPIC_ORDER} gacha bo'lishi kerak`);
    }
    if (from > to) {
      throw new BadRequestError(`${nth}: oraliqning boshi oxiridan katta bo'lmasligi kerak`);
    }

    parsed.topicFrom = from;
    parsed.topicTo = to;
    return parsed;
  });

  if (!rows.length) return null;

  const total = rows.reduce((sum, row) => sum + rowTotal(row), 0);
  if (total > MAX_TOTAL) {
    throw new BadRequestError(
      `Jami ${total} ta savol so'raldi — bitta testda ${MAX_TOTAL} tadan ko'p savol bo'lmaydi`,
    );
  }

  return rows;
}

/**
 * SAVOL YOZILADIGAN MAVZULARNI ORALIQDAN TENG TAQSIMLAB TANLAYDI.
 *
 * ⚠️ AI GENERATSIYASIDA MAVZULAR TANLANADI, HAMMASI BERILMAYDI.
 * "Hozirgi mavzugacha" oralig'i yuzlab mavzu bo'lishi mumkin (ingliz
 * tilida 1165 ta): hammasini promptga solish ham mumkin emas, ham
 * ma'nosiz — 20 savol 100 mavzuni baribir qamrab olmaydi. Shuning
 * uchun oraliqdan TENG masofada joylashgan mavzular tanlanadi va
 * savollar ular bo'ylab taqsimlanadi.
 *
 * ⚠️ BITTA SAVOL SO'RALGANDA ENG OXIRGI MAVZU olinadi: "bir savol bilan
 * qayerda turganini o'lchash" deganda eng yaqin material nazarda
 * tutiladi, o'rtadagi mavzu emas.
 *
 * @param {Array<{order: number}>} topics - oraliqdagi mavzular (order asc)
 * @param {number} count - yozilishi kerak savollar soni
 * @returns {Array<{topic: object, count: number}>}
 */
function spreadTopics(topics, count) {
  const list = Array.isArray(topics) ? topics : [];
  const want = Math.max(0, Number(count) || 0);
  if (!list.length || want === 0) return [];

  if (list.length >= want) {
    const picked =
      want === 1
        ? [list[list.length - 1]]
        : Array.from({ length: want }, (_, i) =>
            list[Math.round((i * (list.length - 1)) / (want - 1))],
          );
    // Teng masofa bir xil indeksga tushishi mumkin emas (want <= length),
    // lekin yaxlitlash chegarada takrorlashi mumkin — noyob holga keltiramiz.
    const seen = new Set();
    const unique = [];
    for (const topic of picked) {
      if (seen.has(topic.order)) continue;
      seen.add(topic.order);
      unique.push(topic);
    }
    // Takror tushgani bo'lsa, qolgan savollar oxirgi mavzularga qo'shiladi.
    const rows = unique.map((topic) => ({ topic, count: 1 }));
    let leftover = want - unique.length;
    let i = rows.length - 1;
    while (leftover > 0 && rows.length) {
      rows[i].count += 1;
      leftover -= 1;
      i = i === 0 ? rows.length - 1 : i - 1;
    }
    return rows;
  }

  // Mavzu savoldan kam — har mavzuga bir nechta savol.
  const base = Math.floor(want / list.length);
  const extra = want % list.length;
  return list.map((topic, index) => ({
    topic,
    // ⚠️ ORTIQCHASI OXIRGI MAVZULARGA: yaqin material ko'proq so'raladi.
    count: base + (index >= list.length - extra ? 1 : 0),
  }));
}

module.exports = {
  BLUEPRINT_SOURCES,
  SOURCE_LABELS,
  TOPIC_MODES,
  TOPIC_MODE_LABELS,
  LEVEL_KEYS,
  LEVEL_POOLS,
  LEVEL_KEY_LABELS,
  MAX_PER_LEVEL,
  MAX_TOTAL,
  MAX_ROWS,
  parseBlueprint,
  rowTotal,
  levelCounts,
  spreadTopics,
};
