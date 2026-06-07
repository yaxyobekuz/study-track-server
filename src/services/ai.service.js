// OpenAI orqali test savollarini generatsiya qilish servisi.
// Matn prompti, rasmlar (Vision) yoki fayldan ajratilgan matn asosida ishlaydi.
const OpenAI = require("openai");
const { config } = require("../config/env.config");
const logger = require("../utils/logger");
const { BadRequestError } = require("../utils/errors");

const MAX_COUNT = config.aiMaxQuestionsPerRequest;

let _client = null;

function _getClient() {
  if (!config.openaiApiKey) {
    throw new BadRequestError(
      "AI sozlanmagan. Administrator OPENAI_API_KEY ni kiritishi kerak.",
    );
  }
  if (!_client) {
    _client = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return _client;
}

function _clampCount(count) {
  const n = parseInt(count, 10);
  if (Number.isNaN(n) || n < 1) return 5;
  return Math.min(n, MAX_COUNT);
}

function _buildSystemPrompt({ count, difficulty, type }) {
  const difficultyText =
    { easy: "oson", medium: "o'rta", hard: "qiyin" }[difficulty] || "o'rta";

  const typeRules =
    type === "open"
      ? `Savollar "open" turida bo'lsin (ochiq, matnli javob). "options" massivi bo'sh bo'lsin.`
      : `Savollar "standard" turida bo'lsin (variantli). Har bir savolda aynan 4 ta "options" bo'lsin va ulardan FAQAT bittasida "isCorrect": true bo'lsin, qolganlarida false.`;

  return [
    "Sen tajribali o'qituvchi va test tuzuvchisan.",
    `Berilgan mavzu yoki material asosida ${count} ta ${difficultyText} darajadagi test savolini tuz.`,
    "Barcha savol va javob matnlari O'ZBEK tilida bo'lishi shart.",
    typeRules,
    "Har bir savolning 'points' qiymati 1 bo'lsin.",
    "Javobni FAQAT quyidagi JSON formatda qaytar (boshqa hech narsa yozma):",
    `{"questions":[{"type":"${type}","text":"savol matni","points":1,"options":[{"text":"variant","isCorrect":true}]}]}`,
  ].join(" ");
}

function _buildUserText({ prompt, extractedText }) {
  const parts = [];
  if (prompt && prompt.trim()) {
    parts.push(`Mavzu / ko'rsatma: ${prompt.trim()}`);
  }
  if (extractedText && extractedText.trim()) {
    parts.push(
      `Quyidagi material asosida savollar tuz:\n"""\n${extractedText.trim()}\n"""`,
    );
  }
  if (parts.length === 0) {
    parts.push("Umumiy bilim asosida savollar tuz.");
  }
  return parts.join("\n\n");
}

function _normalizeAndValidate(rawQuestions, requestedType) {
  if (!Array.isArray(rawQuestions)) return [];

  const result = [];

  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== "object") continue;

    const type = raw.type === "open" ? "open" : "standard";
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (!text) continue; // matnsiz savol yaroqsiz (AI rasm yaratmaydi)

    const points =
      typeof raw.points === "number" && raw.points >= 0 ? raw.points : 1;

    if (type === "open") {
      result.push({ type: "open", text, points, options: [] });
      continue;
    }

    // standard
    const rawOptions = Array.isArray(raw.options) ? raw.options : [];
    const options = rawOptions
      .map((opt) => ({
        text: typeof opt?.text === "string" ? opt.text.trim() : "",
        isCorrect: Boolean(opt?.isCorrect),
      }))
      .filter((opt) => opt.text.length > 0);

    if (options.length < 2) continue; // kamida 2 variant kerak

    // Aynan bitta to'g'ri variant bo'lishini ta'minlash
    const correctCount = options.filter((o) => o.isCorrect).length;
    if (correctCount === 0) {
      options[0].isCorrect = true;
    } else if (correctCount > 1) {
      let seen = false;
      for (const o of options) {
        if (o.isCorrect && !seen) {
          seen = true;
        } else {
          o.isCorrect = false;
        }
      }
    }

    result.push({ type: "standard", text, points, options: options.slice(0, 99) });
  }

  // requestedType "open" bo'lsa ham faqat yaroqli savollarni qaytaramiz
  return result;
}

async function _requestQuestions(messages, type) {
  const client = _getClient();

  let completion;
  try {
    completion = await client.chat.completions.create({
      model: config.openaiModel,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.7,
    });
  } catch (error) {
    logger.error(`AI generatsiya xatosi: ${error.message}`);
    throw new BadRequestError(
      "AI savol generatsiya qila olmadi. Keyinroq qayta urinib ko'ring.",
    );
  }

  const content = completion.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    logger.warn("AI javobini JSON sifatida o'qib bo'lmadi");
    throw new BadRequestError("AI noto'g'ri formatda javob qaytardi.");
  }

  return _normalizeAndValidate(parsed.questions, type);
}

async function generateFromPrompt({ prompt, count, difficulty, type }) {
  const safeCount = _clampCount(count);
  const messages = [
    { role: "system", content: _buildSystemPrompt({ count: safeCount, difficulty, type }) },
    { role: "user", content: _buildUserText({ prompt }) },
  ];
  return _requestQuestions(messages, type);
}

async function generateFromText({ extractedText, prompt, count, difficulty, type }) {
  const safeCount = _clampCount(count);
  const messages = [
    { role: "system", content: _buildSystemPrompt({ count: safeCount, difficulty, type }) },
    { role: "user", content: _buildUserText({ prompt, extractedText }) },
  ];
  return _requestQuestions(messages, type);
}

async function generateFromImages({
  images,
  prompt,
  extractedText,
  count,
  difficulty,
  type,
}) {
  const safeCount = _clampCount(count);

  const userContent = [
    { type: "text", text: _buildUserText({ prompt, extractedText }) },
  ];

  for (const img of images || []) {
    if (!img?.buffer) continue;
    const base64 = img.buffer.toString("base64");
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${base64}` },
    });
  }

  const messages = [
    { role: "system", content: _buildSystemPrompt({ count: safeCount, difficulty, type }) },
    { role: "user", content: userContent },
  ];

  return _requestQuestions(messages, type);
}
function isAiEnabled() {
  return Boolean(config.openaiApiKey);
}

module.exports = {
  generateFromPrompt,
  generateFromText,
  generateFromImages,
  isAiEnabled,
};
