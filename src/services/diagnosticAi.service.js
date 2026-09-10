/**
 * DIAGNOSTIKA — AI TAHLILI.
 *
 * ⚠️ AI BU YERDA QO'SHIMCHA QATLAM, ASOS EMAS. Diagnostikaning va'dasi —
 * "qayerda turibsiz va nima qilish kerak" degan javob. Bu javob AI'siz ham
 * to'liq beriladi: ball, mavzular kesimi, xato sabablari va hafta-hafta
 * reja QOIDALAR bilan hisoblanadi (`diagnostic.helpers.js`). Model faqat
 * o'sha raqamlarni ODAM TILIDA tushuntiradi.
 *
 * Shu sababli:
 *   - kalit yo'q → heuristik matn yoziladi (`source: "rules"`), xato emas;
 *   - model yiqildi → heuristik matn yoziladi;
 *   - model javobi shaklga to'g'ri kelmadi → heuristik matn yoziladi.
 * Foydalanuvchi hech qachon bo'sh ekran ko'rmaydi.
 *
 * ⚠️ RAQAM MODELDAN CHIQMAYDI. Model matn yozadi, raqamlar esa unga
 * KIRISH sifatida beriladi va javobdan olinmaydi — ballni model "aytib
 * yuborishi" mumkin bo'lgan joy umuman yo'q (`academicInsight.service.js`
 * bilan bir xil doktrina).
 */

const OpenAI = require("openai");
const prisma = require("../config/prisma");
const { config } = require("../config/env.config");
const logger = require("../utils/logger");
const {
  NotFoundError,
  BadRequestError,
  ForbiddenError,
} = require("../utils/errors");
const {
  buildRoadmap,
  diagnosisTone,
  gradeLabel,
  formatDuration,
} = require("../helpers/diagnostic.helpers");
const { getDiagnosticSettings } = require("./settings.service");

const SOURCE = { AI: "ai", RULES: "rules" };

/** Bitta chaqiruvning eng uzun umri va qayta urinishlar soni. */
const AI_TIMEOUT_MS = 45000;
const AI_MAX_RETRIES = 1;
const TEMPERATURE = 0.4;

let _client = null;

/**
 * ⚠️ `null` QAYTARADI, XATO OTMAYDI (`academicInsight.service.js` bilan
 * bir xil siyosat): AI bu modulda qo'shimcha qatlam va uning yo'qligi
 * normal ish rejimi. `ai.service.js` dagi `_getClient` esa xato otadi —
 * u yerda foydalanuvchi "savol generatsiya qil" tugmasini bosgan va
 * javobsiz qolmasligi kerak.
 */
function _getClient() {
  if (!config.openaiApiKey) return null;
  if (!_client) _client = new OpenAI({ apiKey: config.openaiApiKey });
  return _client;
}

/**
 * Modeldan JSON so'raydi. Har qanday nosozlikda `null` — chaqiruvchi
 * heuristikaga tushadi.
 */
async function _askJson(system, user, { maxTokens = 1200 } = {}) {
  const client = _getClient();
  if (!client) return null;

  const settings = await getDiagnosticSettings();
  if (!settings.aiEnabled) return null;

  try {
    const completion = await client.chat.completions.create(
      {
        model: config.openaiModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: TEMPERATURE,
        max_tokens: maxTokens,
      },
      { timeout: AI_TIMEOUT_MS, maxRetries: AI_MAX_RETRIES },
    );

    const choice = completion.choices?.[0];
    // ⚠️ Kesilgan javob PARSE QILINMAYDI. Yarim JSON ba'zan yaroqli
    // ko'rinadi (massiv yopilib qolgan) va yarim ro'yxat to'liq javob
    // bo'lib chiqardi.
    if (choice?.finish_reason === "length") {
      logger.warn("Diagnostika AI javobi token chegarasida kesildi");
      return null;
    }

    const content = choice?.message?.content;
    if (!content) return null;

    return { data: JSON.parse(content), model: config.openaiModel };
  } catch (error) {
    logger.warn(`Diagnostika AI chaqiruvi muvaffaqiyatsiz: ${error.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// TIZIM PROMPTLARI
// ─────────────────────────────────────────────
//
// ⚠️ IELTS / SAT / "band" ATAMALARI ATAYLAB YO'Q. Bu platforma 1–11 sinf
// MAKTAB tizimi: natija foizda va uch darajada (Yaxshi / O'rta / Zaif)
// ifodalanadi. Asl loyihada bu atamalar promptlarda qolib ketgan va
// maktab o'quvchisiga "IELTS 6.5" deb yozib yuborardi.

const FEEDBACK_SYSTEM = `Sen maktab o'quv markazining AI mentorisan. O'quvchining diagnostika natijasini (foizli ball va mavzular kesimi) tahlil qilib ILIQ, RAG'BATLANTIRUVCHI va ANIQ fikr yozasan.

Qoidalar:
- Ohang: aqlli mentor ("Sizda ... yaxshi chiqdi", "Agar shu mavzuni yopsangiz ...").
- Bu 1–11 sinf MAKTAB fanlari. "IELTS", "SAT", "band" so'zlarini ISHLATMA.
- Natijani FOIZ (%) va daraja (Yaxshi / O'rta / Zaif) bilan izohla.
- Berilgan raqamlardan boshqa raqam O'YLAB TOPMA.
- Har bir mavzu nomini berilgan ro'yxatdan ol, yangisini qo'shma.
- Til: O'ZBEK (lotin).

FAQAT quyidagi JSON qaytar:
{"summary": string, "strengths": [{"title": string, "body": string}], "weaknesses": [{"title": string, "body": string}], "recommendations": [{"topic": string, "reason": string, "estimatedMinutes": number}]}`;

const EXPLAIN_SYSTEM = `Sen shaxsiy repetitorsan. O'quvchi AYNAN bergan javobga qarab, nega xato (yoki to'g'ri) ekanini iliq, aniq va qisqa (2–3 gap) tushuntirasan — umumiy emas, aynan shu javobga oid. To'g'ri javobni ayt va keyingi qadam uchun bitta maslahat ber. Til: o'zbek (lotin).

FAQAT JSON: {"explanation": string}`;

const PLAN_SYSTEM = `Sen maktab o'quvchisiga BUGUNGI KUN uchun aniq, bajarilishi mumkin bo'lgan reja tuzasan. 3–5 ta qadam, har biri 10–40 daqiqa. Qadamlar zaif mavzulardan boshlanadi. Til: o'zbek (lotin).

FAQAT JSON: {"title": string, "totalMinutes": number, "items": [{"title": string, "detail": string, "minutes": number, "topic": string}]}`;

const ROADMAP_SYSTEM = `Sen maktab o'quvchisi uchun 4 HAFTALIK o'quv yo'l xaritasini tuzasan. Har hafta — bitta asosiy mavzu, nima qilish kerakligi va kutilayotgan natija (foizda). Oxirgi haftada nazorat testi bo'ladi. Berilgan mavzulardan tashqari mavzu qo'shma. Til: o'zbek (lotin).

FAQAT JSON: {"goal": number, "current": number, "steps": [{"week": number, "title": string, "detail": string, "projected": number, "checkpoint": string|null}]}`;

const TUTOR_SYSTEM = `Sen Sokratik repetitorsan. HECH QACHON to'g'ridan-to'g'ri javob bermaysan — o'quvchini savol berib, kichik qadamlar bilan javobga yetaklaysan. Iliq va qisqa (1–2 gap). Til: o'zbek (lotin).

FAQAT JSON: {"message": string}`;

const ESSAY_SYSTEM = `Sen insho murabbiysisan. O'quvchining inshosiga qarab TOPSHIRISHDAN OLDIN aniq va qisqa maslahatlar berasan — javobni O'ZING YOZMAYSAN, faqat yo'naltirasan. Har maslahat turi: "structure" | "grammar" | "vocabulary" | "coherence" | "content". Til: o'zbek (lotin).

FAQAT JSON: {"suggestions": [{"type": string, "message": string}], "overallTip": string}`;

// ─────────────────────────────────────────────
// HEURISTIK ZAXIRA
// ─────────────────────────────────────────────

const ERROR_ADVICE = {
  rushing:
    "Xatolarning katta qismi shoshilishdan. Har savolga kamida o'ylab javob bering — vaqt yetadi.",
  knowledge:
    "Xatolarning katta qismi bilim yetishmasligidan. Mavzuni qaytadan o'qib, misollar ishlang.",
  misread:
    "Xatolarning katta qismi savolni noto'g'ri tushunishdan. Savolni oxirigacha, sekin o'qing.",
};

function _heuristicFeedback({ score, grade, breakdown, errorPatterns, weakThreshold }) {
  const sorted = [...(breakdown || [])].sort((a, b) => a.score - b.score);
  const weak = sorted.filter((t) => t.score < weakThreshold).slice(0, 3);
  const strong = sorted.filter((t) => t.score >= weakThreshold).slice(-2).reverse();

  const dominant = errorPatterns
    ? ["rushing", "knowledge", "misread"].reduce(
        (best, key) =>
          (errorPatterns[key] || 0) > (errorPatterns[best] || 0) ? key : best,
        "knowledge",
      )
    : null;

  const summaryParts = [
    `Natija: ${Math.round(score)}% — daraja "${gradeLabel(grade)}".`,
  ];
  if (strong[0]) {
    summaryParts.push(
      `Kuchli tomoningiz — "${strong[0].topic}" (${strong[0].score}%).`,
    );
  }
  if (weak[0]) {
    summaryParts.push(
      `Eng katta o'sish imkoniyati "${weak[0].topic}" mavzusini yopishdan boshlanadi.`,
    );
  } else {
    summaryParts.push("Barcha mavzular yaxshi o'zlashtirilgan — endi murakkabroq bosqichga o'tish vaqti.");
  }
  if (dominant && errorPatterns?.wrongCount > 0) {
    summaryParts.push(ERROR_ADVICE[dominant]);
  }

  return {
    summary: summaryParts.join(" "),
    strengths: strong.map((t) => ({
      title: t.topic,
      body: `Bu mavzuda ${t.score}% — barqaror kuchli tomon. Uni saqlab qolish uchun vaqti-vaqti bilan takrorlab turing.`,
    })),
    weaknesses: weak.map((t) => ({
      title: t.topic,
      body:
        t.score < 40
          ? `Bu mavzuda ${t.score}%. Asosiy qoidalarni qaytadan mustahkamlash kerak.`
          : t.score < 65
            ? `Bu mavzuda ${t.score}%. Qoida tushunilgan, ammo amaliyot yetishmayapti — ko'proq mashq qiling.`
            : `Bu mavzuda ${t.score}%. Kichik xatolar — diqqat va muntazam mashq bilan yopiladi.`,
    })),
    recommendations: weak.map((t) => ({
      topic: t.topic,
      reason: `${t.score}% — mustahkamlash kerak`,
      estimatedMinutes: t.score < 40 ? 60 : 40,
    })),
  };
}

function _heuristicPlan({ breakdown, weakThreshold }) {
  const weak = [...(breakdown || [])]
    .filter((t) => t.score < weakThreshold)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3);

  const items = weak.length
    ? weak.map((t, i) => ({
        title: `"${t.topic}" mavzusini takrorlash`,
        detail:
          i === 0
            ? "Qoidani qaytadan o'qing va 5 ta oddiy misol ishlang."
            : "Namunaviy misollarni tahlil qiling va o'zingiz 5 ta yechib ko'ring.",
        minutes: i === 0 ? 30 : 20,
        topic: t.topic,
      }))
    : [
        {
          title: "Murakkabroq mashqlar",
          detail: "Barcha mavzular yaxshi — endi qiyinroq savollarni sinab ko'ring.",
          minutes: 30,
          topic: "Umumiy",
        },
      ];

  items.push({
    title: "Xatolarni ko'rib chiqish",
    detail: "Diagnostikadagi har bir xato javobning sababini yozib chiqing.",
    minutes: 15,
    topic: "Umumiy",
  });

  return {
    title: "Bugungi reja",
    totalMinutes: items.reduce((sum, i) => sum + i.minutes, 0),
    items,
  };
}

function _heuristicEssay(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  const sentences = String(text || "")
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const suggestions = [];
  if (words < 120) {
    suggestions.push({
      type: "content",
      message: `Hozir ~${words} so'z. Fikringizni to'liq ochish uchun kamida 150–200 so'z yozing.`,
    });
  }
  if (!/\b(chunki|shuning uchun|birinchidan|ikkinchidan|masalan|bundan tashqari|xulosa)\b/i.test(text || "")) {
    suggestions.push({
      type: "coherence",
      message:
        "Bog'lovchi so'zlar qo'shing (birinchidan, chunki, masalan, xulosa qilib) — g'oyalar aniqroq bog'lanadi.",
    });
  }
  const first = sentences[0] || "";
  if (first && first.split(/\s+/).length < 5) {
    suggestions.push({
      type: "structure",
      message: "Birinchi gap asosiy fikringizni aniq bildirsin.",
    });
  }
  const longOnes = sentences.filter((s) => s.split(/\s+/).length > 30);
  if (longOnes.length) {
    suggestions.push({
      type: "grammar",
      message: `${longOnes.length} ta juda uzun gap bor — qisqartiring, aniqlik oshadi.`,
    });
  }
  if (!suggestions.length) {
    suggestions.push({
      type: "vocabulary",
      message: "Struktura yaxshi. Endi lug'atni boyitishga harakat qiling.",
    });
  }

  return {
    suggestions: suggestions.slice(0, 4),
    overallTip: "Har bir paragraf bitta asosiy g'oyaga qaratilsin.",
  };
}

const TUTOR_NUDGES = [
  "Yaxshi savol. Avval o'zingiz nima deb o'ylaysiz — birinchi qadam qanday bo'lishi mumkin?",
  "To'g'ri yo'ldasiz. Endi shu qoidani misolga qo'llasak, nima kelib chiqadi?",
  "Deyarli! Yana bir bor tekshiring — qaysi qadamda ishonchingiz komil emas?",
  "Ajoyib. Nega aynan shunday bo'lishini tushuntira olasizmi?",
];

// ─────────────────────────────────────────────
// JAVOB SHAKLINI TEKSHIRISH
// ─────────────────────────────────────────────
//
// ⚠️ MODEL JAVOBI ISHONCHSIZ MA'LUMOT. Shakli to'g'ri kelmasa, u
// "tuzatilmaydi" — butunlay rad etiladi va heuristika ishlaydi. Yarim
// javobni yamash modelning nimani noto'g'ri qilganini yashirardi.

const _str = (v, max = 600) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

function _validFeedback(data) {
  if (!data || typeof data !== "object") return null;

  const summary = _str(data.summary, 900);
  if (!summary) return null;

  const list = (arr, max) =>
    (Array.isArray(arr) ? arr : [])
      .map((item) => ({
        title: _str(item?.title, 120),
        body: _str(item?.body, 500),
      }))
      .filter((item) => item.title && item.body)
      .slice(0, max);

  const recommendations = (Array.isArray(data.recommendations) ? data.recommendations : [])
    .map((item) => ({
      topic: _str(item?.topic, 120),
      reason: _str(item?.reason, 300),
      estimatedMinutes: Math.min(
        240,
        Math.max(5, parseInt(item?.estimatedMinutes, 10) || 30),
      ),
    }))
    .filter((item) => item.topic)
    .slice(0, 5);

  return {
    summary,
    strengths: list(data.strengths, 3),
    weaknesses: list(data.weaknesses, 4),
    recommendations,
  };
}

function _validPlan(data) {
  if (!data || typeof data !== "object") return null;

  const items = (Array.isArray(data.items) ? data.items : [])
    .map((item) => ({
      title: _str(item?.title, 160),
      detail: _str(item?.detail, 400) || "",
      minutes: Math.min(180, Math.max(5, parseInt(item?.minutes, 10) || 20)),
      topic: _str(item?.topic, 120) || "Umumiy",
    }))
    .filter((item) => item.title)
    .slice(0, 6);

  if (!items.length) return null;

  return {
    title: _str(data.title, 120) || "Bugungi reja",
    totalMinutes: items.reduce((sum, i) => sum + i.minutes, 0),
    items,
  };
}

function _validRoadmap(data, fallbackCurrent) {
  if (!data || typeof data !== "object") return null;

  const steps = (Array.isArray(data.steps) ? data.steps : [])
    .map((step, index) => ({
      week: Math.min(12, Math.max(1, parseInt(step?.week, 10) || index + 1)),
      title: _str(step?.title, 140),
      detail: _str(step?.detail, 400) || "",
      projected: Math.min(100, Math.max(0, parseInt(step?.projected, 10) || 0)),
      checkpoint: _str(step?.checkpoint, 120),
    }))
    .filter((step) => step.title)
    .slice(0, 8);

  if (!steps.length) return null;

  return {
    goal: Math.min(100, Math.max(0, parseInt(data.goal, 10) || 0)),
    current: Math.min(
      100,
      Math.max(0, parseInt(data.current, 10) || Math.round(fallbackCurrent)),
    ),
    steps,
  };
}

// ─────────────────────────────────────────────
// URINISH TAHLILI
// ─────────────────────────────────────────────

/** Modelga beriladigan kirish — RAQAMLAR shu yerdan boradi. */
function _attemptContext(attempt) {
  return {
    score: Math.round(attempt.score ?? 0),
    grade: gradeLabel(attempt.grade),
    correct: attempt.correctCount ?? 0,
    wrong: attempt.wrongCount ?? 0,
    skipped: attempt.skippedCount ?? 0,
    totalQuestions: attempt.totalQuestions ?? 0,
    timeSpent: formatDuration(attempt.timeSpentSec),
    topics: (attempt.breakdown || []).map((t) => ({
      topic: t.topic,
      score: t.score,
      questions: t.questions,
    })),
    errorPatterns: attempt.errorPatterns || null,
  };
}

/**
 * Insight qatorini "band qilib" oladi (bir vaqtda ikkita ishlov bermaslik
 * uchun) va tayyor bo'lganda yozadi.
 *
 * ⚠️ SHARTLI YANGILANISH (`updateMany` + `status: "queued"`): ikkita
 * parallel so'rov bir xil qatorga tushsa, faqat bittasi `processing` ga
 * o'tkaza oladi va model FAQAT BIR MARTA chaqiriladi.
 */
async function _claim(insightId) {
  const claimed = await prisma.diagnosticInsight.updateMany({
    where: { id: insightId, status: { in: ["queued", "failed"] } },
    data: { status: "processing" },
  });
  return claimed.count === 1;
}

async function _loadAttempt(attemptId) {
  const attempt = await prisma.diagnosticAttempt.findUnique({
    where: { id: attemptId },
  });
  if (!attempt) throw new NotFoundError("Urinish topilmadi");
  return attempt;
}

/**
 * Tahlilni SO'RAYDI — javobni kutmaydi.
 *
 * ⚠️ NATIJA SAHIFASI AI'NI KUTMAYDI. Ball, mavzular kesimi va xato
 * sabablari shu zahoti tayyor; AI matni tayyor bo'lgach qo'shiladi
 * (mijoz `getInsights` bilan so'rab turadi). Model chaqiruvini so'rov
 * ichida kutish sahifani 10–40 soniyaga muzlatib qo'yardi.
 */
async function requestAnalysis(attemptId, kinds = ["feedback", "roadmap"]) {
  const attempt = await _loadAttempt(attemptId);
  if (attempt.status === "in_progress") {
    throw new BadRequestError("Urinish hali yakunlanmagan");
  }

  const created = [];
  for (const kind of kinds) {
    const insight = await prisma.diagnosticInsight.upsert({
      // `targetId: "-"` — "urinishning o'zi haqida" (savolga bog'liq emas).
      where: { attemptId_kind_targetId: { attemptId, kind, targetId: "-" } },
      create: {
        attemptId,
        studentId: attempt.studentId,
        kind,
        status: "queued",
      },
      // Qayta so'ralganda O'SHA qator qayta ishlanadi — tarixga takroriy
      // qator qo'shilmaydi.
      update: { status: "queued", error: null },
    });
    created.push(insight);
  }

  // ⚠️ "Yozib qo'y va unut": so'rovni KUTIB TURMAYDI. Filial konteksti
  // AsyncLocalStorage orqali shu zanjirda saqlanadi, shuning uchun
  // `prisma` to'g'ri schema'ga boradi. Jarayon qayta ishga tushsa,
  // `queued` qatorlarni cron ko'tarib oladi.
  Promise.all(created.map((insight) => _process(insight.id))).catch((error) => {
    logger.error(`Diagnostika AI fon ishlovi xatosi: ${error.message}`);
  });

  return created.map((i) => ({ id: i.id, kind: i.kind, status: "queued" }));
}

/** Bitta insight qatorini ishlaydi (fon yoki cron). */
async function _process(insightId) {
  const insight = await prisma.diagnosticInsight.findUnique({
    where: { id: insightId },
  });
  if (!insight || !insight.attemptId) return null;
  if (!(await _claim(insightId))) return null;

  const settings = await getDiagnosticSettings();

  try {
    const attempt = await _loadAttempt(insight.attemptId);
    const context = _attemptContext(attempt);

    let output;
    let model = null;

    if (insight.kind === "feedback") {
      const result = await _askJson(
        FEEDBACK_SYSTEM,
        `Diagnostika natijasi:\n${JSON.stringify(context)}`,
        { maxTokens: 1400 },
      );
      const valid = result && _validFeedback(result.data);
      if (valid) {
        output = { ...valid, source: SOURCE.AI };
        model = result.model;
      } else {
        output = {
          ..._heuristicFeedback({
            score: attempt.score ?? 0,
            grade: attempt.grade,
            breakdown: attempt.breakdown || [],
            errorPatterns: attempt.errorPatterns,
            weakThreshold: settings.weakTopicScore,
          }),
          source: SOURCE.RULES,
        };
      }
    } else if (insight.kind === "roadmap") {
      const heuristic = buildRoadmap(
        attempt.breakdown || [],
        attempt.score ?? 0,
        settings.weakTopicScore,
      );
      const result = await _askJson(
        ROADMAP_SYSTEM,
        `O'quvchi natijasi:\n${JSON.stringify({
          ...context,
          suggestedGoal: heuristic.goal,
        })}`,
        { maxTokens: 1200 },
      );
      const valid = result && _validRoadmap(result.data, attempt.score ?? 0);
      output = valid
        ? { ...valid, source: SOURCE.AI }
        : { ...heuristic, source: SOURCE.RULES };
      if (valid) model = result.model;
    } else if (insight.kind === "plan") {
      const result = await _askJson(
        PLAN_SYSTEM,
        `O'quvchi natijasi:\n${JSON.stringify(context)}`,
        { maxTokens: 900 },
      );
      const valid = result && _validPlan(result.data);
      output = valid
        ? { ...valid, source: SOURCE.AI }
        : {
            ..._heuristicPlan({
              breakdown: attempt.breakdown || [],
              weakThreshold: settings.weakTopicScore,
            }),
            source: SOURCE.RULES,
          };
      if (valid) model = result.model;
    } else {
      // `explain` sinxron yo'l bilan yoziladi — bu yerga tushmaydi.
      await prisma.diagnosticInsight.update({
        where: { id: insightId },
        data: { status: "failed", error: "Noma'lum tahlil turi" },
      });
      return null;
    }

    const updated = await prisma.diagnosticInsight.update({
      where: { id: insightId },
      data: { status: "done", output, model, error: null },
    });

    // Urinish "baholangan" holatiga faqat asosiy tahlil tayyor bo'lganda
    // o'tadi — bu holat "AI ham ko'rib chiqdi" degani.
    if (insight.kind === "feedback") {
      await prisma.diagnosticAttempt.updateMany({
        where: { id: insight.attemptId, status: "submitted" },
        data: { status: "evaluated" },
      });
    }

    return updated;
  } catch (error) {
    logger.error(`Diagnostika AI ishlovi yiqildi (${insightId}): ${error.message}`);
    await prisma.diagnosticInsight
      .update({
        where: { id: insightId },
        data: { status: "failed", error: error.message.slice(0, 500) },
      })
      .catch(() => {});
    return null;
  }
}

/**
 * Navbatda qolgan tahlillarni ishlaydi (cron).
 *
 * ⚠️ Fon ishlovi jarayon qayta ishga tushganda uzilib qoladi va qator
 * `queued`/`processing` holatida osilib qolardi. Bu funksiya ularni
 * ko'tarib oladi — o'quvchi "tahlil tayyorlanmoqda" yozuvi bilan abadiy
 * qolmaydi.
 */
async function processPending({ limit = 25, staleMinutes = 10 } = {}) {
  const staleBefore = new Date(Date.now() - staleMinutes * 60 * 1000);

  const rows = await prisma.diagnosticInsight.findMany({
    where: {
      kind: { in: ["feedback", "roadmap", "plan"] },
      OR: [
        { status: "queued" },
        { status: "processing", updatedAt: { lt: staleBefore } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, status: true },
  });

  let processed = 0;
  for (const row of rows) {
    // Osilib qolgan `processing` qatorni qayta olish uchun avval
    // `queued` ga qaytaramiz — `_claim` faqat shu ikki holatni oladi.
    if (row.status === "processing") {
      await prisma.diagnosticInsight.updateMany({
        where: { id: row.id, status: "processing", updatedAt: { lt: staleBefore } },
        data: { status: "queued" },
      });
    }
    const result = await _process(row.id);
    if (result) processed += 1;
  }

  return { found: rows.length, processed };
}

/** Urinishning barcha tahlillari (mijoz shu bilan so'rab turadi). */
async function getInsights(attemptId) {
  const rows = await prisma.diagnosticInsight.findMany({
    where: { attemptId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      kind: true,
      status: true,
      output: true,
      model: true,
      error: true,
      targetId: true,
      updatedAt: true,
    },
  });

  return rows.map(({ targetId, ...row }) => ({
    ...row,
    // Mijozga `targetId` o'rniga tushunarli nom: `explain` uchun bu
    // muhrlangan savol id'si, qolganlari uchun `null`.
    attemptQuestionId: targetId === "-" ? null : targetId,
    // Model nomi ichki ma'lumot — mijozga "AI" yoki "Qoidalar" yetarli.
    source: row.output?.source || (row.model ? SOURCE.AI : null),
  }));
}

// ─────────────────────────────────────────────
// "NEGA XATO?" — SINXRON
// ─────────────────────────────────────────────

/**
 * Bitta savol uchun tushuntirish.
 *
 * ⚠️ SINXRON, chunki foydalanuvchi savolni ochib TURIB kutadi. Natija
 * keshlanadi: bir xil savol qayta ochilganda model qayta chaqirilmaydi.
 */
async function explainAnswer(attemptId, attemptQuestionId, { staff = false } = {}) {
  const question = await prisma.diagnosticAttemptQuestion.findUnique({
    where: { id: attemptQuestionId },
    include: { options: { orderBy: { position: "asc" } }, answer: true },
  });
  if (!question || question.attemptId !== attemptId) {
    throw new NotFoundError("Savol topilmadi");
  }

  const attempt = await prisma.diagnosticAttempt.findUnique({
    where: { id: attemptId },
    include: { test: { select: { showAnswers: true } } },
  });
  if (!attempt) throw new NotFoundError("Urinish topilmadi");

  // ⚠️ IZOH TUGAMAGAN URINISHDA BERILMAYDI. Izoh matni TO'G'RI JAVOBNI
  // o'z ichiga oladi ("To'g'ri javob: ..."), ya'ni test davomida uni
  // so'rash javob kalitini so'rash bilan barobar edi: o'quvchi
  // `/active` dan savollar ro'yxatini olib, har biriga izoh so'rab
  // chiqsa, 100% olardi. Bu tekshiruv `requestAnalysis` dagi bilan
  // AYNI qoida.
  if (attempt.status === "in_progress") {
    throw new BadRequestError("Urinish hali yakunlanmagan");
  }

  // ⚠️ "JAVOBLARNI KO'RSATMA" SOZLAMASI SHU YERDA HAM AMAL QILADI.
  // Aks holda o'qituvchi testni `showAnswers: false` qilib qo'ysa ham,
  // o'quvchi izoh orqali javoblarni bilib olardi — sozlama esa ishlayotgan
  // bo'lib ko'rinardi. Xodim (`staff`) baribir ko'radi: u testni
  // tekshirishi kerak.
  if (!staff && attempt.test && attempt.test.showAnswers === false) {
    throw new ForbiddenError(
      "Bu testda to'g'ri javoblar ko'rsatilmaydi",
    );
  }

  const cached = await prisma.diagnosticInsight.findFirst({
    where: { attemptId, kind: "explain", targetId: attemptQuestionId, status: "done" },
  });
  if (cached) return cached.output;

  const answer = question.answer;

  const label = (id) => question.options.find((o) => o.id === id)?.text || "—";
  const correctText = question.options
    .filter((o) => o.isCorrect)
    .map((o) => o.text)
    .filter(Boolean)
    .join(", ");
  const yourText = answer?.textAnswer
    ? answer.textAnswer
    : (answer?.selectedOptionIds || []).map(label).join(", ") || "javob berilmagan";

  const isCorrect = answer?.isCorrect === true;

  let output;
  const result = await _askJson(
    EXPLAIN_SYSTEM,
    JSON.stringify({
      question: question.text,
      topic: question.topicName || "Umumiy",
      options: question.options.map((o) => o.text).filter(Boolean),
      correct: correctText,
      studentAnswer: yourText,
      isCorrect,
      // Muallif yozgan izoh bo'lsa, model uni QAYTA AYTMASLIGI uchun
      // beriladi — takrorlanish o'rniga to'ldiradi.
      authorExplanation: question.explanation || null,
    }),
    { maxTokens: 500 },
  );

  const explanation = result && _str(result.data?.explanation, 900);
  if (explanation) {
    output = { explanation, correct: correctText, yourAnswer: yourText, isCorrect, source: SOURCE.AI };
  } else {
    output = {
      explanation: _heuristicExplain({
        isCorrect,
        correctText,
        yourText,
        topic: question.topicName || "bu mavzu",
        authorExplanation: question.explanation,
        isSkipped: answer?.isSkipped,
      }),
      correct: correctText,
      yourAnswer: yourText,
      isCorrect,
      source: SOURCE.RULES,
    };
  }

  await prisma.diagnosticInsight
    .upsert({
      where: {
        attemptId_kind_targetId: {
          attemptId,
          kind: "explain",
          targetId: attemptQuestionId,
        },
      },
      create: {
        attemptId,
        studentId: attempt.studentId,
        targetId: attemptQuestionId,
        kind: "explain",
        status: "done",
        model: result?.model || null,
        output,
      },
      update: { status: "done", output, model: result?.model || null },
    })
    .catch((error) => {
      // Kesh yozilmasa ham javob berilishi kerak.
      logger.warn(`Diagnostika izohi keshlanmadi: ${error.message}`);
    });

  return output;
}

function _heuristicExplain({
  isCorrect,
  correctText,
  yourText,
  topic,
  authorExplanation,
  isSkipped,
}) {
  if (authorExplanation) return authorExplanation;

  if (isCorrect) {
    return `To'g'ri! "${correctText}" — aynan shu javob to'g'ri. "${topic}" mavzusini yaxshi o'zlashtiribsiz.`;
  }
  if (isSkipped) {
    return `Bu savolga javob bermadingiz. To'g'ri javob: "${correctText}". "${topic}" mavzusini qaytadan ko'rib chiqing.`;
  }
  return `To'g'ri javob: "${correctText}". Siz "${yourText}" ni tanladingiz. Bu "${topic}" mavzusidagi tipik xato — qoidani qayta ko'rib chiqing va yana urinib ko'ring.`;
}

// ─────────────────────────────────────────────
// JONLI YORDAMCHILAR
// ─────────────────────────────────────────────

/** Sokratik repetitor — javobni bermaydi, savol bilan yetaklaydi. */
async function tutorTurn({ history = [], topic = null, message = "" }) {
  const trimmed = history.slice(-10).map((turn) => ({
    role: turn.role === "tutor" ? "tutor" : "student",
    text: String(turn.text || "").slice(0, 1500),
  }));

  const result = await _askJson(
    TUTOR_SYSTEM,
    JSON.stringify({ topic, history: trimmed, studentMessage: String(message).slice(0, 1500) }),
    { maxTokens: 350 },
  );

  const text = result && _str(result.data?.message, 700);
  if (text) return { message: text, source: SOURCE.AI };

  const turns = trimmed.filter((t) => t.role === "student").length;
  return {
    message: TUTOR_NUDGES[Math.min(turns, TUTOR_NUDGES.length - 1)],
    source: SOURCE.RULES,
  };
}

/** Insho murabbiy — topshirishdan oldingi maslahatlar. */
async function essayCoach(text) {
  const essay = String(text || "").trim();
  if (essay.length < 20) {
    throw new BadRequestError("Insho matni juda qisqa");
  }

  const result = await _askJson(ESSAY_SYSTEM, `Insho matni:\n${essay.slice(0, 6000)}`, {
    maxTokens: 700,
  });

  const suggestions = (Array.isArray(result?.data?.suggestions) ? result.data.suggestions : [])
    .map((item) => ({
      type: _str(item?.type, 24) || "content",
      message: _str(item?.message, 400),
    }))
    .filter((item) => item.message)
    .slice(0, 5);

  if (suggestions.length) {
    return {
      suggestions,
      overallTip: _str(result.data?.overallTip, 300) || "",
      wordCount: essay.split(/\s+/).filter(Boolean).length,
      source: SOURCE.AI,
    };
  }

  return {
    ..._heuristicEssay(essay),
    wordCount: essay.split(/\s+/).filter(Boolean).length,
    source: SOURCE.RULES,
  };
}

/** AI umuman sozlanganmi — panel shu bilan ogohlantirish ko'rsatadi. */
async function getAiStatus() {
  const settings = await getDiagnosticSettings();
  return {
    configured: Boolean(config.openaiApiKey),
    enabled: settings.aiEnabled && Boolean(config.openaiApiKey),
    model: config.openaiApiKey ? config.openaiModel : null,
  };
}

module.exports = {
  SOURCE,
  requestAnalysis,
  processPending,
  getInsights,
  explainAnswer,
  tutorTurn,
  essayCoach,
  getAiStatus,
  _heuristicFeedback,
  _heuristicPlan,
};
