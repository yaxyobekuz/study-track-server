/**
 * GURUH XABARLARI — AI TAHLILI.
 *
 * Rasmiy guruhlardan to'plangan xabarlarni o'qib, ularning orasidan
 * MA'MURIYAT KO'RISHI KERAK BO'LGANLARINI ajratadi: shikoyat, taklif va
 * javobsiz qolgan savol.
 *
 * ⚠️ `null` QAYTARADI, XATO OTMAYDI (`diagnosticAi.service.js` bilan ayni
 * siyosat). Bu fon ishi: kalit yo'q bo'lsa, model yiqilsa yoki javob
 * shaklga to'g'ri kelmasa — xabarlar tahlil qilinmagan holida QOLADI va
 * keyingi aylanishda qayta uriniladi. Hech kim bo'sh ekran ko'rmaydi,
 * chunki bu ekranni hech kim kutib turmaydi.
 *
 * ⚠️ MODEL NOMI KODDA — `aiAssistant/assistant.constants.js` bilan ayni
 * doktrina: model almashtirish kod o'zgarishi, tasodifiy `.env` tahriri
 * emas. `.env` dan faqat `OPENAI_API_KEY` o'qiladi.
 *
 * ⚠️ NIMA UCHUN "NANO": bu ish KUNIGA 48 MARTA va har safar o'nlab
 * xabar bilan ishlaydi. Vazifa esa og'ir emas — "bu gap shikoyatmi"
 * degan tasniflash. Katta model bu yerda pulni bir necha o'nlab barobar
 * oshirib, aniqlikka deyarli qo'shmasdi.
 *
 * ⚠️ MODEL IQTIBOSNI O'YLAB TOPMAYDI: `quote` xabar matnidan OLINADI va
 * biz uni haqiqatan matnda borligiga tekshiramiz (`_pickQuote`). Aks
 * holda panelda hech kim yozmagan gap "iqtibos" bo'lib turardi.
 */

const OpenAI = require("openai");

const { config } = require("../config/env.config");
const logger = require("../utils/logger");

/**
 * Tasnif modeli — arzon va tez.
 *
 * ⚠️ `gpt-5.4-nano` `temperature` QABUL QILMAYDI (5.x oilasidagi barcha
 * modellar kabi). Yuborilsa 400 bilan rad etiladi, ya'ni tahlil butunlay
 * ishlamay qolardi.
 */
const MODEL = "gpt-5.4-nano";

/** Bitta chaqiruvning eng uzun umri va qayta urinishlar soni. */
const AI_TIMEOUT_MS = 60000;
const AI_MAX_RETRIES = 1;

/**
 * Bitta so'rovga ketadigan eng ko'p xabar.
 *
 * ⚠️ CHEGARA KERAK: faol guruhda 30 daqiqada yuzlab xabar yig'ilishi
 * mumkin va hammasini bitta so'rovga tiqish kontekst chegarasiga urardi.
 * Ortig'i keyingi to'plamda ko'riladi — navbat yo'qolmaydi.
 */
const MAX_MESSAGES_PER_CALL = 60;

/** Modeldan so'raladigan eng ko'p signal — bitta to'plamdan. */
const MAX_SIGNALS = 10;

/** Javob token chegarasi. */
const MAX_OUTPUT_TOKENS = 2000;

/** AI qaytaradigan toifalar — boshqasi rad etiladi. */
const SIGNAL_KINDS = new Set(["complaint", "suggestion", "question"]);

/** Jiddiylik darajalari. */
const SEVERITIES = new Set(["low", "normal", "high"]);

let _client = null;

/**
 * ⚠️ Kalit bo'lmasa `null` — xato EMAS. Bu fon ishi va AI'siz tizim
 * o'z ishini davom ettiraveradi (guruh kuzatuvi shunchaki ishlamaydi).
 */
function _getClient() {
  if (!config.openaiApiKey) return null;
  if (!_client) _client = new OpenAI({ apiKey: config.openaiApiKey });
  return _client;
}

/** AI yoqilganmi — job shuni tekshirib, bo'sh aylanmaydi. */
const isEnabled = () => Boolean(config.openaiApiKey);

/**
 * TIZIM PROMPTI.
 *
 * ⚠️ MISOLLAR HAQIQIY HOLATLARDAN olingan. Dastlabki variantda faqat
 * umumiy ta'rif ("shikoyat, norozilik") bor edi va model XODIM haqidagi
 * hamda TIZIM haqidagi shikoyatni o'tkazib yuborardi — ular "oddiy
 * suhbat" ga o'xshab ko'rinadi. Ta'rif emas, MISOL ishlaydi.
 *
 * ⚠️ "KAM BO'LSIN" DEYILMAYDI. Model ehtiyotkor bo'lsa haqiqiy shikoyat
 * yo'qoladi va ma'muriyat uni umuman ko'rmaydi. Ortiqcha signalni odam
 * bir bosishda "bu muammo emas" deb yopadi — yo'qolgan shikoyatni esa
 * hech kim qaytarib bera olmaydi. Shuning uchun SHUBHADA — SIGNAL.
 */
const SYSTEM_PROMPT = [
  "Sen maktab ma'muriyatining yordamchisisan.",
  "Senga maktabning rasmiy Telegram guruhidan kelgan xabarlar beriladi (ota-onalar va xodimlar yozadi).",
  "Vazifang — ma'muriyat KO'RISHI KERAK bo'lgan xabarlarni ajratish.",
  "",
  "AJRATILADIGAN TOIFALAR:",
  '- "complaint" — shikoyat, norozilik, e\'tiroz, nosozlik haqida xabar.',
  '- "suggestion" — taklif, yaxshilash istagi, "shunday qilish kerak" degan gap.',
  '- "question" — javobsiz qolgan savol.',
  "",
  "SHIKOYAT NIMA — MISOLLAR (hammasi signal bo'ladi):",
  '- XODIM haqida: "falonchi opa yoqmayapti", "o\'qituvchi darsga kech keladi",',
  '  "bu odamni ishdan olib tashlash kerak", "xodim qo\'pol gapiryapti".',
  '- O\'QUVCHI haqida: "falon sinfdagi bola doim janjal qilaveryapti",',
  '  "bolalar urishyapti", "sinfda tartib yo\'q".',
  '- TIZIM/DASTUR haqida: "platforma yaxshi ishlamayapti", "ilova ochilmayapti",',
  '  "baholar ko\'rinmayapti", "to\'lov o\'tmadi".',
  '- SHAROIT haqida: "sinfda isitish yo\'q", "ovqat sifatsiz", "jihoz buzilgan".',
  '- TASHKILIY: "dars jadvali chalkash", "hech kim javob bermayapti".',
  "",
  "MUHIM: shikoyat QISQA va BEPARVO yozilgan bo'lishi mumkin —",
  '"yoqmayabdi", "ishlamayabdi", "janjal qilaveryapti" kabi. Rasmiy til va',
  "tafsilot talab QILMA: qisqa norozilik ham shikoyatdir. Kim yozganiga",
  "qarama — rahbar yozgan tanqid ham signal bo'ladi.",
  "",
  "E'TIBORGA OLINMAYDI (bularni umuman qaytarma):",
  "- salomlashuv, minnatdorchilik, tabrik, xayrlashuv;",
  '- faqat smaylik yoki "ha", "ok", "zo\'r" kabi qisqa roziliklar;',
  "- maqtov va ijobiy fikr;",
  "- ma'muriyatning o'z e'lonlari va eslatmalari;",
  "- guruhda allaqachon javob berilgan savol.",
  "",
  "QOIDALAR:",
  "- SHUBHA BO'LSA — SIGNAL QAYTAR. Ortiqcha signalni odam o'zi yopadi,",
  "  lekin o'tkazib yuborilgan shikoyat butunlay yo'qoladi.",
  "- Bir mavzudagi bir nechta xabarni BITTA signalga birlashtir.",
  "- Har xil mavzudagi shikoyatlarni ALOHIDA signal qil.",
  '- "summary" — o\'zbek tilida, bitta aniq jumla, ma\'muriyat o\'qishi uchun.',
  '- "quote" — xabar matnidan AYNAN ko\'chirilgan parcha. O\'zingdan gap qo\'shma.',
  '- "messageId" — signal asos bo\'lgan xabarning raqami (ro\'yxatdagi "#" qiymati).',
  '- "severity": "high" — bolaning xavfsizligi/sog\'lig\'i, pul masalasi,',
  "  xodimni ishdan bo'shatish talabi yoki takrorlanayotgan jiddiy nizo;",
  '  "normal" — oddiy shikoyat/taklif; "low" — mayda izoh.',
  `- Eng ko'pi ${MAX_SIGNALS} ta signal qaytar. Hech narsa topilmasa — bo'sh ro'yxat.`,
  "",
  "Javobni FAQAT shu JSON shaklida qaytar (boshqa hech narsa yozma):",
  '{"signals":[{"messageId":"123","kind":"complaint","severity":"normal","summary":"...","quote":"..."}]}',
].join("\n");

/**
 * Xabarlarni modelga beriladigan matnga aylantiradi.
 *
 * Har qator "#<id> [vaqt] Ism: matn" — model `messageId` ni shundan
 * oladi va biz signalni haqiqiy xabarga bog'lay olamiz.
 */
function _buildUserText(messages) {
  return messages
    .map((m) => {
      const who = m.senderName || "Noma'lum";
      // Soat:daqiqa yetarli — sana bitta to'plam ichida bir xil.
      const time = m.sentAt
        ? `${String(m.sentAt.getHours()).padStart(2, "0")}:${String(
            m.sentAt.getMinutes(),
          ).padStart(2, "0")}`
        : "--:--";
      const reply = m.replyToText
        ? ` (javob: "${m.replyToText.slice(0, 120)}")`
        : "";
      return `#${m.messageId} [${time}] ${who}${reply}: ${m.text}`;
    })
    .join("\n");
}

/**
 * Model bergan iqtibosni TEKSHIRADI.
 *
 * ⚠️ MODEL IQTIBOSNI O'YLAB TOPISHI MUMKIN. Panelda "iqtibos" deb
 * turgan gap haqiqatan yozilmagan bo'lsa, ma'muriyat yo'q gap uchun
 * odamni chaqirardi. Shuning uchun iqtibos manba matnida bor-yo'qligi
 * tekshiriladi; bo'lmasa — xabarning o'z boshi olinadi.
 */
function _pickQuote(rawQuote, sourceText) {
  const quote = typeof rawQuote === "string" ? rawQuote.trim() : "";
  if (quote && sourceText.includes(quote)) return quote.slice(0, 500);
  return sourceText.slice(0, 500);
}

/**
 * Model javobidagi bitta yozuvni tozalaydi.
 *
 * @returns {object|null} yaroqsiz bo'lsa `null` — o'sha yozuv tashlanadi
 */
function _normalizeSignal(raw, byMessageId) {
  if (!raw || typeof raw !== "object") return null;

  const kind = String(raw.kind || "").trim();
  if (!SIGNAL_KINDS.has(kind)) return null;

  const summary = String(raw.summary || "").trim();
  if (!summary) return null;

  // ⚠️ XABARGA BOG'LANMAGAN SIGNAL TASHLANADI: havola ham, muallif ham,
  // vaqt ham o'sha xabardan keladi. Ularsiz signal "kimdir nimadir
  // dedi" bo'lib qolardi va tekshirib bo'lmasdi.
  const messageId = String(raw.messageId ?? "").trim();
  const source = byMessageId.get(messageId);
  if (!source) return null;

  const severity = String(raw.severity || "").trim();

  return {
    messageId,
    kind,
    severity: SEVERITIES.has(severity) ? severity : "normal",
    summary: summary.slice(0, 500),
    quote: _pickQuote(raw.quote, source.text),
    chatId: source.chatId,
    senderTgId: source.senderTgId,
    senderName: source.senderName,
    sentAt: source.sentAt,
  };
}

/**
 * Bitta guruhning xabarlarini tahlil qiladi.
 *
 * @param {object[]} messages Bitta chatning xabarlari (vaqt bo'yicha)
 * @returns {Promise<{signals: object[], model: string}|null>} nosozlikda `null`
 */
async function analyze(messages) {
  const client = _getClient();
  if (!client || !messages?.length) return null;

  const batch = messages.slice(0, MAX_MESSAGES_PER_CALL);
  const byMessageId = new Map(batch.map((m) => [m.messageId, m]));

  let completion;
  try {
    completion = await client.chat.completions.create(
      {
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: _buildUserText(batch) },
        ],
        response_format: { type: "json_object" },
        // ⚠️ `temperature` YUBORILMAYDI — 5.x modellari uni qabul
        // qilmaydi va so'rov 400 bilan rad etilardi.
        max_completion_tokens: MAX_OUTPUT_TOKENS,
      },
      { timeout: AI_TIMEOUT_MS, maxRetries: AI_MAX_RETRIES },
    );
  } catch (error) {
    logger.warn(`[GroupSignal] AI chaqiruvi muvaffaqiyatsiz: ${error.message}`);
    return null;
  }

  const choice = completion.choices?.[0];

  // ⚠️ KESILGAN JAVOB PARSE QILINMAYDI: yarim JSON ba'zan yaroqli
  // ko'rinadi (massiv yopilib qolgan) va yarim ro'yxat to'liq javob
  // bo'lib chiqardi.
  if (choice?.finish_reason === "length") {
    logger.warn("[GroupSignal] AI javobi token chegarasida kesildi");
    return null;
  }

  const content = choice?.message?.content;
  if (!content) return null;

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    logger.warn("[GroupSignal] AI javobi JSON emas");
    return null;
  }

  const rawSignals = Array.isArray(parsed?.signals) ? parsed.signals : [];

  const signals = rawSignals
    .map((raw) => _normalizeSignal(raw, byMessageId))
    .filter(Boolean)
    .slice(0, MAX_SIGNALS);

  return { signals, model: MODEL };
}

module.exports = {
  MODEL,
  MAX_MESSAGES_PER_CALL,
  SIGNAL_KINDS,
  SEVERITIES,
  isEnabled,
  analyze,
};
