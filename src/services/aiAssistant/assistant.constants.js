/**
 * AI YORDAMCHI — o'zgarmas sozlamalar (faqat tizim egasi uchun).
 *
 * ⚠️ MODEL NOMLARI KODDA QAT'IY YOZILADI, `.env` DAN OLINMAYDI. Bu
 * egasining qarori: model almashtirish — kod o'zgarishi, tasodifiy env
 * tahriri emas. `.env` dan faqat `OPENAI_API_KEY` o'qiladi (`config`).
 *
 * ⚠️ LIMITLAR XAVFSIZLIK CHEGARASI, "sozlama" emas. Har biri nima uchun
 * shunday ekani yonida yozilgan — "biroz oshiraman" deyishdan oldin o'qing.
 */

/** Modellar. `reasoning: true` — Responses API da `reasoning.effort` qabul qiladi, `temperature` qabul qilmaydi. */
const MODELS = Object.freeze({
  /** Asosiy suhbat + vosita chaqirish. */
  chat: Object.freeze({ id: "gpt-5.4", reasoning: true, effort: "medium" }),
  /**
   * Asosiy model topilmasa (`model_not_found`) — BIR MARTA shu bilan qayta
   * uriniladi. Kalit boshqa loyihaga tegishli bo'lib, yangi modelga ruxsat
   * bo'lmasa suhbat butunlay to'xtab qolmasligi uchun.
   */
  chatFallback: Object.freeze({ id: "gpt-4.1", reasoning: false }),
  /** Suhbat sarlavhasi — arzon va tez. */
  title: Object.freeze({ id: "gpt-5.4-mini", reasoning: true, effort: "low" }),
  /** Ovozli xabarni matnga aylantirish. */
  transcribe: "gpt-4o-transcribe",
  /** Javobni ovozda o'qish. */
  speech: "gpt-4o-mini-tts",
});

/** Ovoz (TTS) sozlamalari. */
const SPEECH = Object.freeze({
  voice: "marin",
  format: "mp3",
  contentType: "audio/mpeg",
  instructions:
    "O'zbek tilida (lotin yozuvi) gapir. Ohang — xotirjam, aniq va rasmiy, " +
    "maktab rahbariga hisobot berayotgan tajribali tahlilchi kabi. Sonlarni " +
    "o'zbekcha to'liq o'qi.",
  /** OpenAI TTS kirish chegarasi — 4096 belgi. */
  maxInputChars: 4000,
});

/** Transkripsiya sozlamalari. */
const TRANSCRIBE = Object.freeze({
  language: "uz",
  /**
   * Model uchun lug'at: soha atamalari to'g'ri yozilishi uchun. Ism-sharif
   * bu yerga QO'SHILMAYDI — prompt OpenAI'ga ketadi, u esa ma'lumotlar
   * bazasi emas.
   */
  prompt:
    "Maktab boshqaruvi platformasi. Atamalar: o'quvchi, xodim, o'qituvchi, " +
    "oylik, hisob-faktura, to'lov, qarzdorlik, chegirma, tarif, depozit, " +
    "davomat, baho, jarima, topshiriq, o'rinbosar, dars jadvali, filial, " +
    "xarajat, kirim, chiqim, inventar, lid, ta'til oyi, muzlatish.",
});

const LIMITS = Object.freeze({
  /** Bitta matnli xabar. Uzunroq matn — deyarli har doim nusxalangan hujjat, savol emas. */
  maxTextLength: 4000,
  /** Ovozli xabar hajmi (OpenAI chegarasi 25MB; bizda xotirada ushlanadi). */
  maxVoiceBytes: 10 * 1024 * 1024,
  /** Ovozli xabar davomiyligi. */
  maxVoiceSeconds: 300,
  /** Bitta javob ichida model necha marta vosita chaqira oladi. Cheksiz sikl — cheksiz hisob. */
  maxToolRounds: 10,
  /** Bitta javobda nechta amal taklif qilinishi mumkin. */
  maxActionsPerTurn: 5,
  /** Bitta vosita natijasining modelga boradigan JSON hajmi (belgi). */
  maxToolResultChars: 20000,
  /** Tarix: modelga yuboriladigan oldingi xabarlar. */
  historyMaxMessages: 40,
  historyCharBudget: 48000,
  /** Bitta model javobining token chegarasi. */
  maxCompletionTokens: 8000,
  /** Oddiy vosita vaqti. */
  toolTimeoutMs: 30000,
  /** Umumiy tahlil (ko'p bo'limni parallel o'qiydi). */
  healthScanTimeoutMs: 60000,
  /**
   * Bitta model raundining TO'LIQ muddati — oqim oxirigacha (mulohaza + 8000
   * tokengacha javob). Faqat sarlavhalargacha emas: SDK timeout'i oqimli
   * javobda amalda ishlamaydi (`streamRound` izohi).
   */
  modelTimeoutMs: 180000,
  /** Transkripsiya / TTS vaqti. */
  audioTimeoutMs: 60000,
  /** Tasdiqlanmagan amal shuncha vaqtdan keyin eskiradi. */
  actionTtlMs: 15 * 60 * 1000,
  /** Bir vaqtda ochiq turadigan bo'limlar (asosiy to'plamdan tashqari). */
  maxActiveToolsets: 4,
  /** SSE yurak urishi — proksi (Cloudflare/nginx) ulanishni uzmasligi uchun. */
  heartbeatMs: 15000,
  /** Sarlavha uzunligi. */
  maxTitleLength: 80,
});

/** Tezlik chegaralari (foydalanuvchi bo'yicha, `protect` dan keyin). */
const RATE_LIMITS = Object.freeze({
  chat: { windowMs: 5 * 60 * 1000, max: 40 },
  speech: { windowMs: 5 * 60 * 1000, max: 40 },
  actions: { windowMs: 60 * 1000, max: 30 },
});

/** Amal xavf darajalari. `critical` — tasdiqdan oldin alohida "tushundim" belgisi majburiy. */
const RISK = Object.freeze({
  low: { key: "low", label: "Past xavf" },
  medium: { key: "medium", label: "O'rta xavf" },
  high: { key: "high", label: "Yuqori xavf" },
  critical: { key: "critical", label: "Juda yuqori xavf" },
});

const ACTION_STATUS_LABELS = Object.freeze({
  pending: "Tasdiq kutilmoqda",
  executing: "Bajarilmoqda",
  succeeded: "Bajarildi",
  failed: "Bajarilmadi",
  rejected: "Bekor qilindi",
  expired: "Muddati o'tdi",
});

/**
 * VOSITA TO'PLAMLARI (toolset).
 *
 * ⚠️ Model har so'rovda HAMMA vositani ko'rmaydi: 100+ vosita sxemasi har
 * raundda ~20k token va noto'g'ri vosita tanlash degani. `core` doim ochiq,
 * qolganlari model `open_toolsets` chaqirganda qo'shiladi va suhbatda
 * saqlanadi (`AiConversation.activeToolsets`).
 */
const TOOLSETS = Object.freeze({
  core: {
    key: "core",
    label: "Asosiy",
    description:
      "Always available: whole-platform health scan, branch comparison, people search and person profile, opening other toolsets.",
  },
  people: {
    key: "people",
    label: "Foydalanuvchilar",
    description:
      "Users, staff, students, classes, subjects, roles, permissions, branches. Actions: edit profile/phone, login on/off, archive/restore, classes, permissions.",
  },
  finance: {
    key: "finance",
    label: "Moliya (kirim)",
    description:
      "Income side: finance dashboard, debtors, invoices, payments, cashflow, tariffs, discounts, enrollments, freezes, external income, payment accounts, reconciliation. Actions: tariffs, discounts, enrollment close, freeze, invoices, payments, debt reminders, income.",
  },
  payroll: {
    key: "payroll",
    label: "Oylik va xarajatlar",
    description:
      "Outcome side: salary rules, payroll entries and debts, salary payments, positions and salary categories, expenses and budgets, penalties, premium, coins. Actions: change salary, generate/pay payroll, expenses, budgets, penalties, premium, coins.",
  },
  academic: {
    key: "academic",
    label: "Ta'lim",
    description:
      "Education dashboard, grades, student and staff attendance, attendance reports, excuses, tests and seasons, diagnostics, achievements, clubs, teacher KPIs. Actions: academic targets, achievements, excuses, attendance corrections, clubs.",
  },
  schedule: {
    key: "schedule",
    label: "Dars jadvali",
    description:
      "Timetable, today's lessons, teacher load and lesson hours, substitutions (o'rinbosar), holidays, Google Sheets sync health, planner. Actions: create/cancel substitutions, holidays.",
  },
  operations: {
    key: "operations",
    label: "Operatsiyalar",
    description:
      "Tasks, leads (CRM), Telegram messages and delivery queue, inventory and damages, staff/parent activity, security (sessions, alerts), monitors, changelog, market, background jobs and data integrity. Actions: tasks, leads, messages, security, market orders.",
  },
});

/** `open_toolsets` bilan ochiladigan to'plamlar (core doim ochiq). */
const OPENABLE_TOOLSETS = Object.freeze(
  Object.keys(TOOLSETS).filter((key) => key !== "core"),
);

/** Vosita va amal nomining shakli (OpenAI function name). */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

module.exports = {
  MODELS,
  SPEECH,
  TRANSCRIBE,
  LIMITS,
  RATE_LIMITS,
  RISK,
  ACTION_STATUS_LABELS,
  TOOLSETS,
  OPENABLE_TOOLSETS,
  TOOL_NAME_PATTERN,
};
