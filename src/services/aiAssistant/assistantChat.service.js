/**
 * AI YORDAMCHI — bitta suhbat turi (orkestrator).
 *
 *   (ovoz → matn) → suhbat → egasining xabari → model ⇄ vositalar (≤ N raund)
 *   → yordamchi xabari → (birinchi turda) sarlavha
 *
 * ⚠️ MODEL BILAN ALOQA — RESPONSES API (`client.responses.create`), Chat
 * Completions EMAS: faqat shu yerda gpt-5.4 vosita chaqirayotganda ham
 * mulohaza qiladi. Batafsil — `buildResponsesRequest`.
 *
 * ⚠️ `runTurn` HECH QACHON XATO OTMAYDI. U SSE sarlavhalari yuborilgandan
 * keyin ishlaydi: tashqariga chiqqan xato global error handler'ga yetib,
 * `headersSent` da yiqilardi. Har qanday nosozlik `error` hodisasi bo'lib
 * chiqadi va (egasining xabari saqlangan bo'lsa) yordamchi xabari `error`
 * holatida yoziladi — ekran yangilanganda ham javobsiz savol qolmaydi.
 *
 * ⚠️ MIJOZ UZILSA ish to'xtaydi (model so'rovi va vositalar `signal` bilan),
 * yozilgan qism `interrupted` bo'lib saqlanadi. Taklif qilingan amallar
 * xabarga baribir bog'lanadi — ular kartada ko'rinishi va tasdiqlanishi
 * mumkin bo'lib qoladi.
 *
 * ⚠️ BAND QULFI bitta jarayon xotirasida (`Set`). Server bitta jarayon
 * bo'lib ishlaydi; ko'p jarayonga o'tilsa bu qulf ham umumiy omborga
 * ko'chirilishi shart.
 */

const prisma = require("../../config/prisma");
const logger = require("../../utils/logger");
const { ConflictError, TooManyRequestsError } = require("../../utils/errors");
const { MODELS, LIMITS } = require("./assistant.constants");
const {
  OpenAI,
  ResponseStreamError,
  getClient,
  isAbortError,
  isModelNotFound,
  mapOpenAiError,
} = require("./assistant.client");
const { buildSystemPrompt } = require("./assistant.prompt");
const {
  AiAbortedError,
  buildToolContext,
  describeToolset,
  getToolDefinitions,
  mergeToolsets,
  normalizeToolsets,
  resolveTool,
  runTool,
  stepLabel,
} = require("./assistant.registry");
const assistantConversationService = require("./assistantConversation.service");
const assistantActionService = require("./assistantAction.service");
const assistantVoiceService = require("./assistantVoice.service");

/** Bitta egada bir vaqtda yoziladigan javoblar (turli suhbatlarda). */
const MAX_CONCURRENT_TURNS_PER_OWNER = 2;
const TITLE_TIMEOUT_MS = 8000;
const TITLE_MAX_OUTPUT_TOKENS = 400;
const TITLE_ANSWER_CHARS = 600;

const PHASES = Object.freeze({
  transcribing: { phase: "transcribing", label: "Ovozli xabar matnga aylantirilmoqda" },
  thinking: { phase: "thinking", label: "Tahlil qilinmoqda" },
});

// ─────────────────────────────────────────────────────────────────────────
// Band qulfi
// ─────────────────────────────────────────────────────────────────────────

const busyConversations = new Set();
const ownerTurnCounts = new Map();

/**
 * Tur uchun qulf oladi. SSE sarlavhalaridan OLDIN chaqiriladi — band
 * holati oddiy JSON xato (409/429) bo'lib qaytishi uchun.
 *
 * @returns {{ attachConversation: (id: string) => void, release: () => void }}
 */
function acquireTurnLock({ schemaName, ownerId, conversationId }) {
  const keyOf = (id) => `${schemaName}:${id}`;
  if (conversationId && busyConversations.has(keyOf(conversationId))) {
    throw new ConflictError("Bu suhbatda javob hali yozilmoqda", { reason: "busy" });
  }
  const running = ownerTurnCounts.get(ownerId) || 0;
  if (running >= MAX_CONCURRENT_TURNS_PER_OWNER) {
    throw new TooManyRequestsError(
      `Bir vaqtda ko'pi bilan ${MAX_CONCURRENT_TURNS_PER_OWNER} ta javob yoziladi. Joriy javob tugashini kuting.`,
    );
  }

  ownerTurnCounts.set(ownerId, running + 1);
  const heldKeys = [];
  const attachConversation = (id) => {
    const key = keyOf(id);
    if (heldKeys.includes(key)) return;
    busyConversations.add(key);
    heldKeys.push(key);
  };
  if (conversationId) attachConversation(conversationId);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const key of heldKeys) busyConversations.delete(key);
    const left = (ownerTurnCounts.get(ownerId) || 1) - 1;
    if (left > 0) ownerTurnCounts.set(ownerId, left);
    else ownerTurnCounts.delete(ownerId);
  };
  return { attachConversation, release };
}

// ─────────────────────────────────────────────────────────────────────────
// Model so'rovi
// ─────────────────────────────────────────────────────────────────────────

/**
 * Registr vositalari (`{ type, function: { name, description, parameters } }`)
 * → Responses API shakli. Registr o'z shaklida qoladi: argument validatsiyasi
 * va registr testlari unga tayanadi, o'girish faqat so'rov chegarasida.
 *
 * ⚠️ `strict: false` ATAYLAB va ANIQ yoziladi: Responses API da u yozilmasa
 * `true` hisoblanadi, strict rejim esa har bir xususiyatni `required` da
 * talab qiladi — ixtiyoriy argumentli vositalarimiz sxemasi rad etilardi.
 * Argumentlar baribir registrdagi `validateArgs` dan o'tadi.
 */
function toResponsesTools(definitions) {
  return (definitions || []).map((definition) => ({
    type: "function",
    name: definition.function.name,
    description: definition.function.description,
    parameters: definition.function.parameters,
    strict: false,
  }));
}

/**
 * Responses API so'rovi tanasi (bitta raund).
 *
 * ⚠️ NIMA UCHUN RESPONSES API: gpt-5.4 `/v1/chat/completions` da function
 * tools bilan `reasoning_effort` ni faqat "none" da qabul qiladi (2026-09-14
 * da tekshirilgan). Tahlilchi esa aynan vosita tanlab, natijani tahlil
 * qilayotganda mulohaza qilishi kerak — Responses API da ikkalasi birga ishlaydi.
 *
 * ⚠️ `store: false` — suhbat OpenAI tomonida SAQLANMAYDI (`previous_response_id`
 * ishlatilmaydi, u saqlashni talab qiladi). Raundlar orasida mulohaza uzilmasligi
 * uchun `reasoning.encrypted_content` so'raladi: shifrlangan mulohaza keyingi
 * raund `input` iga qaytariladi, biz uni o'qiy olmaymiz va bazaga yozmaymiz.
 *
 * ⚠️ `temperature` HECH QACHON YUBORILMAYDI: reasoning modellar uni rad
 * etadi, zaxira model uchun esa standart qiymat yetarli.
 *
 * ⚠️ MAJBURIY YAKUNIY JAVOBDA HAM VOSITALAR YUBORILADI (`tool_choice: "none"`):
 * vositalar so'rov prefiksining bir qismi — olib tashlansa prompt keshi
 * yo'qolib, turning eng uzun so'rovi to'liq narxda ketardi. Bundan tashqari
 * `input` dagi `function_call` elementlari o'z vositasi ta'rifisiz qolmaydi.
 *
 * ⚠️ MULOHAZASIZ MODEL (zaxira) uchun `reasoning`/`include` yuborilmaydi va
 * `input` dagi `reasoning` elementlari olib tashlanadi: ularni boshqa model
 * shifrlagan, zaxira model esa ularni qabul qilmaydi.
 *
 * @param {{ id: string, reasoning: boolean, effort?: string }} model
 * @param {{ instructions: string, input: object[], tools?: object[], toolChoice?: "auto"|"none" }} options
 */
function buildResponsesRequest(model, { instructions, input, tools, toolChoice = "auto" }) {
  const body = {
    model: model.id,
    instructions,
    input: model.reasoning ? input : input.filter((item) => item.type !== "reasoning"),
    stream: true,
    store: false,
    max_output_tokens: LIMITS.maxCompletionTokens,
  };
  if (tools && tools.length) {
    body.tools = toResponsesTools(tools);
    body.tool_choice = toolChoice;
    body.parallel_tool_calls = true;
  }
  if (model.reasoning) {
    body.reasoning = { effort: model.effort };
    body.include = ["reasoning.encrypted_content"];
  }
  return body;
}

/**
 * Bitta raund oqimining holati. Chiqish elementlari `output_index` bo'yicha
 * yig'iladi: parallel vosita chaqiruvlarining argument bo'laklari aralash
 * kelishi mumkin, `output_index` esa har element uchun barqaror.
 */
function createStreamState() {
  return { slots: [], text: "", terminal: null, incompleteReason: null };
}

function slotFor(state, event) {
  if (Number.isInteger(event.output_index) && state.slots[event.output_index]) {
    return state.slots[event.output_index];
  }
  return state.slots.find((slot) => slot && slot.item.id && slot.item.id === event.item_id) || null;
}

/**
 * Bitta oqim hodisasini holatga qo'shadi.
 *
 * ⚠️ `response.failed` va `error` shu yerda XATO OTADI (sabab kodi bilan),
 * `usage` esa undan OLDIN `onUsage` ga beriladi — yiqilgan raund ham hisobga
 * yozilgan tokenlarni sarflagan.
 *
 * @param {ReturnType<typeof createStreamState>} state
 * @param {object} event
 * @param {{ onText?: (delta: string, itemId: string) => void, onUsage?: (usage: object) => void }} [hooks]
 */
function applyResponseEvent(state, event, hooks = {}) {
  switch (event?.type) {
    case "response.output_item.added":
      state.slots[event.output_index] = { item: { ...event.item }, done: false };
      break;
    case "response.function_call_arguments.delta": {
      const slot = slotFor(state, event);
      if (slot) slot.item.arguments = `${slot.item.arguments || ""}${event.delta || ""}`;
      break;
    }
    case "response.function_call_arguments.done": {
      const slot = slotFor(state, event);
      if (slot) {
        slot.item.arguments = event.arguments ?? slot.item.arguments;
        if (event.name) slot.item.name = event.name;
      }
      break;
    }
    case "response.output_text.delta":
    case "response.refusal.delta":
      if (typeof event.delta === "string" && event.delta) {
        state.text += event.delta;
        hooks.onText?.(event.delta, event.item_id);
      }
      break;
    case "response.output_item.done":
      state.slots[event.output_index] = { item: event.item, done: true };
      break;
    case "response.completed":
    case "response.incomplete": {
      const response = event.response || {};
      if (response.usage) hooks.onUsage?.(response.usage);
      // Oqimda `output_item.done` tushib qolgan element bo'lsa — yakuniy
      // javobdagi ro'yxatdan to'ldiriladi (u to'liq va tartibli).
      (response.output || []).forEach((item, index) => {
        if (item && !state.slots[index]?.done) state.slots[index] = { item, done: true };
      });
      state.terminal = event.type === "response.completed" ? "completed" : "incomplete";
      state.incompleteReason = response.incomplete_details?.reason || null;
      break;
    }
    case "response.failed": {
      const response = event.response || {};
      if (response.usage) hooks.onUsage?.(response.usage);
      throw new ResponseStreamError({
        kind: "failed",
        code: response.error?.code || null,
        message: response.error?.message,
      });
    }
    case "error":
      throw new ResponseStreamError({ kind: "error", code: event.code || null, message: event.message });
    default:
      break;
  }
  return state;
}

/**
 * Raund natijasi: keyingi raundga qaytariladigan elementlar va bajariladigan
 * chaqiruvlar.
 *
 * ⚠️ TUGAMAGAN `function_call` (token chegarasida kesilgan) BAJARILMAYDI
 * va QAYTARILMAYDI: argumentlari yarim JSON, qaytarilsa esa API unga
 * `function_call_output` talab qilardi. Undan oldingi `reasoning` elementi
 * ham tashlanadi — API mulohazani "o'zidan keyingi elementsiz" rad etadi.
 *
 * @returns {{ items: object[], toolCalls: { id: string, name: string, arguments: string }[] }}
 */
function finalizeRound(state, round) {
  const items = [];
  const toolCalls = [];
  let pendingReasoning = [];

  state.slots.forEach((slot, index) => {
    if (!slot) return;
    const { item, done } = slot;
    if (item.type === "reasoning") {
      if (done) pendingReasoning.push(item);
      return;
    }
    let kept = null;
    if (item.type === "function_call") {
      if (done && item.status !== "incomplete" && item.name) {
        const callId = item.call_id || `call_${round}_${index}`;
        kept = item.call_id === callId ? item : { ...item, call_id: callId };
        toolCalls.push({ id: callId, name: item.name, arguments: item.arguments || "" });
      }
    } else if (done) {
      kept = item;
    }
    if (kept) items.push(...pendingReasoning, kept);
    pendingReasoning = [];
  });
  return { items, toolCalls };
}

/**
 * Vosita natijalari → keyingi raund `input` iga qo'shiladigan elementlar:
 * modelning o'z chiqishi (shifrlangan mulohaza bilan, o'zgartirilmasdan),
 * so'ng har chaqiruvga `function_call_output` — chaqiruv tartibida.
 */
function buildNextRoundInput(items, toolCalls, outcomes) {
  return [
    ...items,
    ...toolCalls.map((call, i) => ({
      type: "function_call_output",
      call_id: call.id,
      output: outcomes[i].content,
    })),
  ];
}

/**
 * Oqimni oxirigacha o'qiydi.
 *
 * ⚠️ MIJOZ UZILGANDA SDK oqimni XATOSIZ tugatadi (abort'ni yutib yuboradi).
 * Shuning uchun yakuniy hodisa kelmagan oqim alohida tekshiriladi: signal
 * bo'lsa — uzilish, raund muddati tugagan bo'lsa — vaqt xatosi, aks holda
 * oqim yarim yo'lda uzilgan (`ended`).
 *
 * @param {{ signal?: AbortSignal, deadline?: AbortSignal, onText?: Function, onUsage?: Function }} [options]
 */
async function consumeResponseStream(stream, { signal, deadline, onText, onUsage } = {}) {
  const state = createStreamState();
  for await (const event of stream) {
    applyResponseEvent(state, event, { onText, onUsage });
  }
  if (signal?.aborted) throw new AiAbortedError();
  if (deadline?.aborted) throw roundTimeoutError();
  if (!state.terminal) throw new ResponseStreamError({ kind: "ended" });
  return state;
}

/** Raund muddati tugadi — `mapOpenAiError` uni `timeout` kodiga o'giradi. */
function roundTimeoutError() {
  return new OpenAI.APIConnectionTimeoutError({ message: "Model raundi belgilangan muddatda tugamadi" });
}

/** Sarlavha modeli javobini tozalaydi. Yaroqsiz → `null`. */
function cleanTitle(raw) {
  let title = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!title) return null;
  // Model ba'zan tipografik apostrof (o‘, o’, oʻ) yozadi; platforma matnlari
  // oddiy `'` bilan — qidiruv va ro'yxatda bir so'z ikki xil ko'rinmasin.
  title = title.replace(/[‘’ʻʼ]/g, "'").replace(/^(sarlavha|title)\s*:\s*/i, "");
  title = title.replace(/^[\s"«»“”„`*#]+|[\s"«»“”„`*]+$/g, "");
  if (title.length > 1 && title.startsWith("'") && title.endsWith("'")) title = title.slice(1, -1);
  title = title.replace(/[.!?,;:…\s]+$/u, "").replace(/\s+/g, " ").trim();
  if (!title) return null;
  if (title.length > LIMITS.maxTitleLength) title = `${title.slice(0, LIMITS.maxTitleLength - 1).trimEnd()}…`;
  return title;
}

/**
 * Sarlavha so'rovi — oqimsiz, o'sha Responses API va o'sha `store: false`
 * bilan: suhbat matni OpenAI'da saqlanmasligi har chaqiruvga tegishli.
 * `max_output_tokens` mulohaza tokenlarini ham o'z ichiga oladi — shuning
 * uchun 6 so'zlik sarlavhaga 400 token.
 */
function buildTitleRequest(userText, answer) {
  const body = {
    model: MODELS.title.id,
    instructions:
      "Write a title for this conversation in Uzbek (Latin script): max 6 words, no quotes, no trailing punctuation. Reply with the title only.",
    input: [
      {
        role: "user",
        content: `Savol:\n${userText}\n\nJavob:\n${String(answer || "").slice(0, TITLE_ANSWER_CHARS)}`,
      },
    ],
    store: false,
    max_output_tokens: TITLE_MAX_OUTPUT_TOKENS,
  };
  if (MODELS.title.reasoning) body.reasoning = { effort: MODELS.title.effort };
  return body;
}

async function generateTitle(userText, answer, signal) {
  const client = getClient();
  const response = await client.responses.create(buildTitleRequest(userText, answer), {
    signal,
    timeout: TITLE_TIMEOUT_MS,
    maxRetries: 0,
  });
  return cleanTitle(response.output_text);
}

// ─────────────────────────────────────────────────────────────────────────
// Tur
// ─────────────────────────────────────────────────────────────────────────

/** Turning o'z xatosi (model bo'sh javob qaytardi va h.k.). */
class TurnError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TurnError";
    this.code = code;
  }
}

const isAborted = (err, signal) => Boolean(signal?.aborted) || isAbortError(err) || err instanceof AiAbortedError;

function mapTurnError(err) {
  if (err instanceof TurnError) return { code: err.code, message: err.message };
  const mapped = mapOpenAiError(err);
  return { code: mapped.code, message: mapped.message };
}

/**
 * @param {{
 *   user: object, branch: object,
 *   conversation: object|null,           // mavjud suhbat (egalik tekshirilgan) yoki null
 *   text?: string,                       // matnli xabar (tozalangan)
 *   voice?: { buffer: Buffer, mimeType: string, sizeBytes: number, durationMs: number|null } | null,
 *   emit: (event: string, data: object) => void,
 *   signal: AbortSignal,
 *   lock?: { attachConversation: (id: string) => void },
 * }} input
 */
async function runTurn({ user, branch, conversation = null, text = "", voice = null, emit, signal, lock }) {
  const send = (event, data) => {
    if (signal.aborted) return;
    try {
      emit(event, data);
    } catch (err) {
      logger.warn(`[AiAssistant] SSE yozishda xato: ${err.message}`);
    }
  };

  const turn = {
    conversation,
    isFirstTurn: false,
    userText: text,
    userMessage: null,
    assistantPersisted: false,
    content: "",
    steps: [],
    actionIds: [],
    activeToolsets: normalizeToolsets(conversation?.activeToolsets),
    model: MODELS.chat,
    promptTokens: 0,
    completionTokens: 0,
    hasUsage: false,
  };

  try {
    if (voice) {
      send("status", PHASES.transcribing);
      try {
        turn.userText = await assistantVoiceService.transcribe(voice.buffer, voice.mimeType, { signal });
      } catch (err) {
        if (isAborted(err, signal)) return;
        const mapped = mapOpenAiError(err);
        logger.warn(`[AiAssistant] transkripsiya xatosi: ${err.message}`, { code: mapped.code });
        const passThrough = ["not_configured", "rate_limited", "quota_exceeded", "timeout"];
        send("error", {
          code: passThrough.includes(mapped.code) ? mapped.code : "transcription_failed",
          message: passThrough.includes(mapped.code)
            ? mapped.message
            : "Ovozli xabarni matnga aylantirib bo'lmadi. Qaytadan yozib ko'ring.",
        });
        return;
      }
      if (!turn.userText) {
        send("error", {
          code: "empty_transcript",
          message: "Ovozli xabarda nutq aniqlanmadi. Qaytadan yozib ko'ring.",
        });
        return;
      }
    }
    if (signal.aborted) return;

    if (!turn.conversation) {
      turn.conversation = await assistantConversationService.create({
        ownerId: user.id,
        title: assistantConversationService.fallbackTitle(turn.userText),
      });
    }
    lock?.attachConversation(turn.conversation.id);

    const voiceKey = voice
      ? await assistantVoiceService.storeVoiceClip({
          buffer: voice.buffer,
          mimeType: voice.mimeType,
          schemaName: branch.schemaName,
          conversationId: turn.conversation.id,
        })
      : null;
    try {
      await persistUserMessage(turn, voice, voiceKey);
    } catch (err) {
      await assistantVoiceService.discardVoiceClip(voiceKey);
      throw err;
    }
    // Tranzaksiyada qaytgan hisobdan: oldindan o'qilgan suhbatdagi son
    // eskirgan bo'lishi mumkin, bu esa bazaning o'zi.
    turn.isFirstTurn = turn.conversation.messageCount === 1;
    send("conversation", {
      conversation: assistantConversationService.serializeConversation(turn.conversation),
    });
    send("user_message", {
      message: assistantConversationService.serializeMessage(turn.userMessage, []),
    });

    await runModelLoop(turn, { user, branch, signal, send });

    if (!turn.content.trim() && turn.actionIds.length === 0) {
      throw new TurnError("internal", "Model bo'sh javob qaytardi. Savolni qayta yuboring.");
    }

    const assistantMessage = await persistAssistantMessage(turn, { status: "complete" });
    send("assistant_message", { message: assistantMessage });

    if (turn.isFirstTurn && !signal.aborted) {
      await applyGeneratedTitle(turn, signal);
      send("conversation", {
        conversation: assistantConversationService.serializeConversation(turn.conversation),
      });
    }
  } catch (err) {
    if (isAborted(err, signal)) {
      await persistSafely(turn, { status: "interrupted" });
      logger.info(`[AiAssistant] tur uzildi`, { conversationId: turn.conversation?.id, ownerId: user.id });
      return;
    }
    const mapped = mapTurnError(err);
    if (err instanceof TurnError || err instanceof ResponseStreamError || mapped.code !== "internal" || err?.status) {
      logger.warn(`[AiAssistant] tur xatosi (${mapped.code}): ${err.message}`, {
        conversationId: turn.conversation?.id,
      });
    } else {
      logger.error(`[AiAssistant] tur xatosi: ${err?.message}`, {
        conversationId: turn.conversation?.id,
        stack: err?.stack,
      });
    }
    await persistSafely(turn, { status: "error", errorMessage: mapped.message });
    send("error", mapped);
  }
}

async function persistUserMessage(turn, voice, voiceKey = null) {
  const conversationId = turn.conversation.id;
  const now = new Date();
  const [message, conversation] = await prisma.$transaction(async (tx) => {
    const created = await tx.aiMessage.create({
      data: {
        conversationId,
        role: "user",
        content: turn.userText,
        inputMode: voice ? "voice" : "text",
        audioDurationMs: voice ? voice.durationMs : null,
        status: "complete",
        ...(voice && voiceKey
          ? {
              audio: {
                create: {
                  mimeType: voice.mimeType,
                  sizeBytes: voice.sizeBytes,
                  durationMs: voice.durationMs,
                  storageKey: voiceKey,
                },
              },
            }
          : {}),
      },
      include: { audio: { select: { id: true } } },
    });
    const updated = await tx.aiConversation.update({
      where: { id: conversationId },
      data: { messageCount: { increment: 1 }, lastMessageAt: now },
    });
    return [created, updated];
  });
  turn.userMessage = message;
  turn.conversation = conversation;
}

/**
 * Oqimga matn qo'shadi. Yangi matn bloki (boshqa raund yoki bir raunddagi
 * boshqa xabar elementi) oldingisidan bo'sh qator bilan ajraladi.
 */
function appendText(turn, chunk, isFirstChunkOfBlock, send) {
  let piece = chunk;
  if (isFirstChunkOfBlock && turn.content && !turn.content.endsWith("\n\n")) {
    piece = `${turn.content.endsWith("\n") ? "\n" : "\n\n"}${chunk}`;
  }
  turn.content += piece;
  send("delta", { text: piece });
}

/** Responses `usage` → xabardagi hisob (`output_tokens` mulohaza tokenlarini ham o'z ichiga oladi). */
function addUsage(turn, usage) {
  turn.hasUsage = true;
  turn.promptTokens += usage.input_tokens || 0;
  turn.completionTokens += usage.output_tokens || 0;
}

/**
 * Bitta raund: oqimli so'rov. Asosiy model topilmasa — raund zaxira model
 * bilan BIR MARTA qaytariladi va tur oxirigacha o'sha model qoladi.
 *
 * ⚠️ TOKEN CHEGARASIDA KESILGAN raund (`incomplete: max_output_tokens`)
 * yozilgan matni yoki to'liq chaqiruvlari bo'lsa DAVOM etadi (avvalgi
 * `finish_reason: "length"` kabi, faqat log). Hech narsa chiqmagan bo'lsa —
 * mulohaza butun byudjetni yegan — aniq sababli xato.
 *
 * ⚠️ RAUND MUDDATI OQIMNING O'ZIGA HAM TEGISHLI. SDK dagi `timeout` faqat
 * javob SARLAVHALARIGACHA ishlaydi (keyin `clearTimeout`), oqimli javobda
 * esa sarlavhalar darhol keladi — ya'ni u amalda hech narsani cheklamasdi va
 * to'xtab qolgan oqim band qulfini cheksiz ushlab turardi. Shuning uchun
 * so'rovga turning signali bilan `LIMITS.modelTimeoutMs` muddati birlashtirilib
 * beriladi; muddat tugashi mijoz uzilishi bilan chalkashmasligi uchun alohida
 * `timeout` xatosiga o'giriladi.
 *
 * @param {object} [client] Testlar uchun; odatda yagona OpenAI mijozi.
 */
async function streamRound(
  turn,
  { instructions, input, tools, toolChoice, round, signal, send, timeoutMs = LIMITS.modelTimeoutMs },
  client = getClient(),
) {
  for (;;) {
    const model = turn.model;
    let emitted = false;
    const deadline = AbortSignal.timeout(timeoutMs);
    const requestSignal = AbortSignal.any([signal, deadline]);
    try {
      const stream = await client.responses.create(
        buildResponsesRequest(model, { instructions, input, tools, toolChoice }),
        { signal: requestSignal, timeout: timeoutMs, maxRetries: 1 },
      );
      let lastItemId = null;
      const state = await consumeResponseStream(stream, {
        signal,
        deadline,
        onText: (delta, itemId) => {
          appendText(turn, delta, !emitted || itemId !== lastItemId, send);
          emitted = true;
          lastItemId = itemId;
        },
        onUsage: (usage) => addUsage(turn, usage),
      });
      const { items, toolCalls } = finalizeRound(state, round);
      if (state.terminal === "incomplete") {
        const context = { conversationId: turn.conversation.id, round, reason: state.incompleteReason };
        if (!state.text && toolCalls.length === 0) {
          throw new ResponseStreamError({ kind: "incomplete", reason: state.incompleteReason });
        }
        logger.warn(`[AiAssistant] javob yakunlanmay qoldi (${state.incompleteReason || "noma'lum"})`, context);
      }
      return { text: state.text, items, toolCalls };
    } catch (err) {
      // Muddat so'rov sarlavhalarigacha tugasa SDK `APIUserAbortError` otadi —
      // u egasining "to'xtatish"i emas, vaqt xatosi.
      if (deadline.aborted && !signal.aborted) {
        throw err instanceof OpenAI.APIConnectionTimeoutError ? err : roundTimeoutError();
      }
      const canFallBack = model === MODELS.chat && !emitted && !signal.aborted && isModelNotFound(err);
      if (!canFallBack) throw err;
      logger.warn(`[AiAssistant] ${MODELS.chat.id} topilmadi — ${MODELS.chatFallback.id} ga o'tildi: ${err.message}`);
      turn.model = MODELS.chatFallback;
    }
  }
}

/** Bir raunddagi vositalar: o'qishlar parallel, amallar ketma-ket. */
async function runToolCalls(turn, calls, ctx, hooks, send) {
  const outcomes = new Array(calls.length);
  const stepIndexes = calls.map((call) => {
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
    turn.steps.push(step);
    send("tool_start", { step });
    return { index: turn.steps.length - 1, kind: step.kind };
  });

  const runOne = async (i) => {
    const outcome = await runTool(calls[i], ctx, hooks);
    outcomes[i] = outcome;
    turn.steps[stepIndexes[i].index] = outcome.step;
    if (outcome.action) turn.actionIds.push(outcome.action.id);
    send("tool_end", { step: outcome.step });
  };

  const readIndexes = [];
  const actionIndexes = [];
  stepIndexes.forEach((entry, i) => (entry.kind === "action" ? actionIndexes : readIndexes).push(i));

  await Promise.all([
    Promise.all(readIndexes.map(runOne)),
    (async () => {
      for (const i of actionIndexes) await runOne(i);
    })(),
  ]);
  return outcomes;
}

async function runModelLoop(turn, { user, branch, signal, send }) {
  const history = assistantConversationService.buildHistory(
    await assistantConversationService.loadHistoryMessages(turn.conversation.id, {
      excludeId: turn.userMessage.id,
    }),
  );
  const ctx = buildToolContext({ user, branch, conversationId: turn.conversation.id, signal });
  const instructions = buildSystemPrompt({
    user,
    branch,
    now: ctx.now,
    monthKey: ctx.monthKey,
    activeToolsets: turn.activeToolsets,
  });
  // Tarix `{ role, content }` shaklida — Responses API ning oddiy xabar
  // elementi bilan bir xil, o'girish kerak emas.
  const input = [...history, { role: "user", content: turn.userText }];

  let reservedActions = 0;
  const hooks = {
    onOpenToolsets: (keys) => {
      turn.activeToolsets = mergeToolsets(turn.activeToolsets, keys);
      return {
        activeToolsets: turn.activeToolsets,
        opened: normalizeToolsets(keys).map(describeToolset),
      };
    },
    reserveActionSlot: () => {
      if (reservedActions >= LIMITS.maxActionsPerTurn) return false;
      reservedActions += 1;
      return true;
    },
    emit: send,
  };

  send("status", PHASES.thinking);

  for (let round = 0; round <= LIMITS.maxToolRounds; round += 1) {
    const forceAnswer = round === LIMITS.maxToolRounds;
    const { items, toolCalls } = await streamRound(turn, {
      instructions,
      input,
      tools: getToolDefinitions(turn.activeToolsets),
      toolChoice: forceAnswer ? "none" : "auto",
      round,
      signal,
      send,
    });
    if (forceAnswer || toolCalls.length === 0) return;

    const outcomes = await runToolCalls(turn, toolCalls, ctx, hooks, send);
    if (signal.aborted) throw new AiAbortedError();
    input.push(...buildNextRoundInput(items, toolCalls, outcomes));
  }
}

/** Yordamchi xabarini saqlaydi, amallarni bog'laydi, suhbatni yangilaydi. */
async function persistAssistantMessage(turn, { status, errorMessage = null }) {
  const steps = turn.steps.map((step) =>
    step.status === "running" ? { ...step, status: "error", error: "Bekor qilindi" } : step,
  );
  const now = new Date();
  const [message, conversation] = await prisma.$transaction(async (tx) => {
    const created = await tx.aiMessage.create({
      data: {
        conversationId: turn.conversation.id,
        role: "assistant",
        content: turn.content,
        inputMode: "text",
        steps,
        status,
        errorMessage,
        model: turn.model.id,
        promptTokens: turn.hasUsage ? turn.promptTokens : null,
        completionTokens: turn.hasUsage ? turn.completionTokens : null,
      },
    });
    await assistantActionService.linkToMessage(turn.actionIds, created.id, tx);
    const updated = await tx.aiConversation.update({
      where: { id: turn.conversation.id },
      data: {
        messageCount: { increment: 1 },
        lastMessageAt: now,
        activeToolsets: turn.activeToolsets,
      },
    });
    return [created, updated];
  });
  turn.conversation = conversation;
  turn.assistantPersisted = true;

  const actions = turn.actionIds.length
    ? await prisma.aiAction.findMany({
        where: { messageId: message.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    : [];
  return assistantConversationService.serializeMessage({ ...message, audio: null }, actions);
}

/**
 * Xato/uzilish yo'lida saqlash. Egasining xabari yozilmagan bo'lsa saqlanadigan
 * narsa yo'q; yordamchi xabari allaqachon saqlangan bo'lsa (xato sarlavha
 * bosqichida chiqqan) — ikkinchi nusxa yozilmaydi. Saqlashning o'zi yiqilsa —
 * faqat log (tur allaqachon xato yo'lida).
 */
async function persistSafely(turn, { status, errorMessage = null }) {
  if (!turn.userMessage || turn.assistantPersisted) return;
  try {
    await persistAssistantMessage(turn, { status, errorMessage });
  } catch (err) {
    logger.error(`[AiAssistant] yordamchi xabarini saqlab bo'lmadi: ${err.message}`, {
      conversationId: turn.conversation?.id,
      stack: err.stack,
    });
  }
}

/**
 * Birinchi turdan keyin sarlavha. Model yiqilsa zaxira (birinchi qator)
 * qoladi. Ega shu orada nomni o'zi o'zgartirgan bo'lsa — tegilmaydi.
 *
 * ⚠️ HECH QACHON XATO OTMAYDI: javob allaqachon saqlangan va yuborilgan.
 * Sarlavhani yozishdagi baza xatosi tashqariga chiqsa, to'liq javobdan keyin
 * egaga "kutilmagan xato" ko'rsatilardi.
 */
async function applyGeneratedTitle(turn, signal) {
  const fallback = turn.conversation.title;
  try {
    const title = await generateTitle(turn.userText, turn.content, signal);
    if (!title || title === fallback) return;

    const { count } = await prisma.aiConversation.updateMany({
      where: { id: turn.conversation.id, title: fallback },
      data: { title },
    });
    if (count === 1) turn.conversation = { ...turn.conversation, title };
  } catch (err) {
    if (!isAborted(err, signal)) logger.warn(`[AiAssistant] sarlavha yaratilmadi: ${err.message}`);
  }
}

module.exports = {
  PHASES,
  MAX_CONCURRENT_TURNS_PER_OWNER,
  acquireTurnLock,
  toResponsesTools,
  buildResponsesRequest,
  buildTitleRequest,
  createStreamState,
  applyResponseEvent,
  finalizeRound,
  buildNextRoundInput,
  consumeResponseStream,
  streamRound,
  cleanTitle,
  runTurn,
};
