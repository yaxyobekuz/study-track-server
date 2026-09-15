const test = require("node:test");
const assert = require("node:assert/strict");

const { LIMITS, MODELS } = require("../src/services/aiAssistant/assistant.constants");
const {
  buildHistory,
  actionNote,
  fallbackTitle,
  parseTitle,
} = require("../src/services/aiAssistant/assistantConversation.service");
const {
  stableStringify,
  fingerprintOf,
  normalizePreview,
  serializeAction,
} = require("../src/services/aiAssistant/assistantAction.service");
const {
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
  MAX_CONCURRENT_TURNS_PER_OWNER,
} = require("../src/services/aiAssistant/assistantChat.service");
const {
  OpenAI,
  ResponseStreamError,
  isModelNotFound,
  mapOpenAiError,
} = require("../src/services/aiAssistant/assistant.client");
const { AiAbortedError } = require("../src/services/aiAssistant/assistant.registry");
const {
  extensionForMime,
  parseVoiceDuration,
  assertVoiceFile,
  stripMarkdownForSpeech,
  cutAtSentence,
} = require("../src/services/aiAssistant/assistantVoice.service");
const { buildSystemPrompt } = require("../src/services/aiAssistant/assistant.prompt");

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 1000);

function actionRow(overrides = {}) {
  return {
    id: "a".repeat(24),
    conversationId: "c".repeat(24),
    messageId: null,
    type: "payroll.change_salary",
    title: "Oylikni o'zgartirish",
    risk: "high",
    permission: "payroll.assign",
    status: "pending",
    preview: { summary: "S", target: null, fields: [], effects: [], warnings: [] },
    result: null,
    errorMessage: null,
    expiresAt: FUTURE,
    createdAt: new Date("2026-09-14T09:30:00.000Z"),
    decidedAt: null,
    executedAt: null,
    ...overrides,
  };
}

// ── Tarix ──────────────────────────────────────────────────────────────

test("buildHistory: rollar saqlanadi, amal izohi yordamchi xabariga qo'shiladi", () => {
  const history = buildHistory([
    { role: "user", content: "Oylikni 5 mln qil", actions: [] },
    {
      role: "assistant",
      content: "Taklif tayyor.",
      actions: [
        actionRow({ status: "succeeded", result: { summary: "Oylik 5 000 000 so'm bo'ldi" } }),
        actionRow({ id: "b".repeat(24), status: "failed", errorMessage: "Xodim topilmadi" }),
      ],
    },
  ]);
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], { role: "user", content: "Oylikni 5 mln qil" });
  assert.match(history[1].content, /\[Amal #a{24}: Oylikni o'zgartirish — holat: Bajarildi — natija: Oylik 5 000 000 so'm bo'ldi\]/);
  assert.match(history[1].content, /holat: Bajarilmadi — xato: Xodim topilmadi\]/);
});

test("buildHistory: muddati o'tgan pending amal 'Muddati o'tdi' deb yoziladi", () => {
  const note = actionNote(actionRow({ expiresAt: PAST }));
  assert.match(note, /holat: Muddati o'tdi\]$/);
});

test("buildHistory: bo'sh xabar tashlanadi, soni va belgi byudjeti eskisini kesadi", () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `${i}:${"x".repeat(98)}`,
    actions: [],
  }));
  messages.splice(3, 0, { role: "assistant", content: "", actions: [] });

  const byCount = buildHistory(messages, { maxMessages: 4, charBudget: 100000 });
  assert.equal(byCount.length, 4);
  assert.ok(byCount[3].content.startsWith("9:"));

  const byChars = buildHistory(messages, { maxMessages: 40, charBudget: 350 });
  assert.equal(byChars.length, 3);
  assert.ok(byChars[0].content.startsWith("7:"));

  const tiny = buildHistory(messages, { maxMessages: 40, charBudget: 50 });
  assert.equal(tiny.length, 1);
  assert.equal(tiny[0].content.length, 50);
});

test("fallbackTitle / parseTitle: birinchi qator, uzunlik va xss-clean", () => {
  assert.equal(fallbackTitle("\n  Qarzdorlar   ro'yxati \n ikkinchi qator"), "Qarzdorlar ro'yxati");
  const long = fallbackTitle("a".repeat(200));
  assert.equal(long.length, LIMITS.maxTitleLength);
  assert.ok(long.endsWith("…"));
  assert.equal(fallbackTitle(""), "Yangi suhbat");
  assert.equal(parseTitle("  x &lt; y  "), "x < y");
  assert.throws(() => parseTitle("   "));
  assert.throws(() => parseTitle("a".repeat(121)));
});

// ── Iz va amal ko'rinishi ──────────────────────────────────────────────

test("fingerprint: kalit tartibi va Date/Decimal shakli izni o'zgartirmaydi, qiymat o'zgartiradi", () => {
  const a = { staffId: "s1", fields: [{ after: "5", before: "4" }], at: new Date("2026-09-01T00:00:00Z") };
  const b = { at: new Date("2026-09-01T00:00:00Z"), fields: [{ before: "4", after: "5" }], staffId: "s1" };
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(fingerprintOf(a), fingerprintOf(b));
  assert.equal(fingerprintOf(a).length, 64);
  assert.notEqual(fingerprintOf(a), fingerprintOf({ ...b, staffId: "s2" }));
  assert.notEqual(fingerprintOf({ list: [1, 2] }), fingerprintOf({ list: [2, 1] }));
});

test("normalizePreview: UI shakliga keltiradi, xulosasiz ko'rinish rad etiladi", () => {
  const preview = normalizePreview(
    {
      summary: "  Oylik o'zgaradi ",
      target: "Aliyev Vali — o'qituvchi",
      fields: [{ label: "Oylik", before: null, after: 5000000 }, { before: "x" }],
      effects: ["Ta'sir", "", 5],
      warnings: undefined,
    },
    { type: "payroll.change_salary" },
  );
  assert.deepEqual(preview, {
    summary: "Oylik o'zgaradi",
    target: "Aliyev Vali — o'qituvchi",
    fields: [{ label: "Oylik", before: "—", after: "5000000" }],
    effects: ["Ta'sir"],
    warnings: [],
  });
  assert.throws(() => normalizePreview({ summary: "" }, { type: "x.y" }));
});

test("serializeAction: muddati o'tgan pending → expired, critical → acknowledge", () => {
  const expired = serializeAction(actionRow({ expiresAt: PAST }));
  assert.equal(expired.status, "expired");
  assert.equal(expired.statusLabel, "Muddati o'tdi");
  assert.equal(expired.isExpired, true);
  assert.equal(expired.requiresAcknowledge, false);
  assert.equal(expired.riskLabel, "Yuqori xavf");
  assert.equal(expired.createdAtLabel, "14-sentabr, 2026 14:30");
  assert.equal("conversationTitle" in expired, false);

  const critical = serializeAction(actionRow({ risk: "critical" }), { conversationTitle: "Suhbat" });
  assert.equal(critical.status, "pending");
  assert.equal(critical.requiresAcknowledge, true);
  assert.equal(critical.conversationTitle, "Suhbat");
  assert.equal(critical.result, null);
  assert.equal(critical.executedAtLabel, null);
});

// ── Model so'rovi ──────────────────────────────────────────────────────

const REGISTRY_TOOLS = [
  { type: "function", function: { name: "x_tool", description: "d", parameters: { type: "object", properties: {} } } },
];

test("toResponsesTools: tekis shakl, strict aniq false", () => {
  assert.deepEqual(toResponsesTools(REGISTRY_TOOLS), [
    { type: "function", name: "x_tool", description: "d", parameters: { type: "object", properties: {} }, strict: false },
  ]);
  assert.deepEqual(toResponsesTools(undefined), []);
});

test("buildResponsesRequest: vositali raundda ham mulohaza, store false, shifrlangan mulohaza so'raladi", () => {
  const input = [{ role: "user", content: "Savol" }];
  const main = buildResponsesRequest(MODELS.chat, { instructions: "SYS", input, tools: REGISTRY_TOOLS });
  assert.equal(main.model, MODELS.chat.id);
  assert.equal(main.instructions, "SYS");
  assert.equal(main.input, input);
  assert.equal(main.stream, true);
  assert.equal(main.store, false);
  assert.deepEqual(main.reasoning, { effort: MODELS.chat.effort });
  assert.equal(MODELS.chat.effort, "medium");
  assert.deepEqual(main.include, ["reasoning.encrypted_content"]);
  assert.equal(main.tools[0].name, "x_tool");
  assert.equal(main.tools[0].strict, false);
  assert.equal(main.tool_choice, "auto");
  assert.equal(main.parallel_tool_calls, true);
  assert.equal(main.max_output_tokens, LIMITS.maxCompletionTokens);
  for (const legacy of ["messages", "temperature", "reasoning_effort", "stream_options", "max_completion_tokens", "previous_response_id"]) {
    assert.equal(legacy in main, false, legacy);
  }

  // Majburiy yakuniy javob: vositalar (kesh prefiksi) va mulohaza qoladi, chaqiruv taqiqlanadi.
  const finalRound = buildResponsesRequest(MODELS.chat, { instructions: "SYS", input, tools: REGISTRY_TOOLS, toolChoice: "none" });
  assert.equal(finalRound.tool_choice, "none");
  assert.equal(finalRound.tools.length, 1);
  assert.deepEqual(finalRound.reasoning, { effort: MODELS.chat.effort });
});

test("buildResponsesRequest: zaxira modelda reasoning parametrlari va reasoning elementlari yo'q", () => {
  const input = [
    { role: "user", content: "Savol" },
    { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "gAAA" },
    { id: "fc_1", type: "function_call", call_id: "call_1", name: "x_tool", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
  ];
  const fallback = buildResponsesRequest(MODELS.chatFallback, { instructions: "SYS", input, tools: REGISTRY_TOOLS });
  assert.equal(fallback.model, MODELS.chatFallback.id);
  assert.equal("reasoning" in fallback, false);
  assert.equal("include" in fallback, false);
  assert.equal("temperature" in fallback, false);
  assert.equal(fallback.store, false);
  assert.deepEqual(fallback.input.map((item) => item.type || item.role), ["user", "function_call", "function_call_output"]);
  assert.equal(input.length, 4, "asl input o'zgarmaydi");
});

test("buildTitleRequest: Responses shakli, store false, kichik model effort", () => {
  const body = buildTitleRequest("Qarzdorlar?", "x".repeat(2000));
  assert.equal(body.model, MODELS.title.id);
  assert.equal(body.store, false);
  assert.equal(typeof body.instructions, "string");
  assert.equal(body.input[0].role, "user");
  assert.ok(body.input[0].content.length < 700);
  assert.deepEqual(body.reasoning, { effort: MODELS.title.effort });
  assert.equal("stream" in body, false);
  assert.equal("messages" in body, false);
});

/** gpt-5.4 ning haqiqiy oqimiga o'xshash hodisalar: mulohaza, matn, ikki parallel chaqiruv. */
function parallelCallEvents({ usage = { input_tokens: 1200, output_tokens: 340, output_tokens_details: { reasoning_tokens: 256 } } } = {}) {
  const reasoning = { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "gAAAA-secret" };
  const message = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    phase: "commentary",
    content: [{ type: "output_text", text: "Tekshiraman.", annotations: [] }],
  };
  const callA = { id: "fc_a", type: "function_call", call_id: "call_a", name: "finance_dashboard", arguments: "", status: "in_progress" };
  const callB = { id: "fc_b", type: "function_call", call_id: "call_b", name: "open_toolsets", arguments: "", status: "in_progress" };
  return [
    { type: "response.created", response: { id: "resp_1", status: "in_progress", error: null } },
    { type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: null } },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 1, item_id: "msg_1", content_index: 0, delta: "Tekshi" },
    { type: "response.output_text.delta", output_index: 1, item_id: "msg_1", content_index: 0, delta: "raman." },
    { type: "response.output_item.done", output_index: 1, item: message },
    { type: "response.output_item.added", output_index: 2, item: callA },
    { type: "response.output_item.added", output_index: 3, item: callB },
    { type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_a", delta: '{"mo' },
    { type: "response.function_call_arguments.delta", output_index: 3, item_id: "fc_b", delta: '{"toolsets":' },
    { type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_a", delta: 'nth":202609}' },
    { type: "response.function_call_arguments.delta", output_index: 3, item_id: "fc_b", delta: '["finance"]}' },
    { type: "response.function_call_arguments.done", output_index: 2, item_id: "fc_a", name: "finance_dashboard", arguments: '{"month":202609}' },
    { type: "response.output_item.done", output_index: 2, item: { ...callA, arguments: '{"month":202609}', status: "completed" } },
    { type: "response.output_item.done", output_index: 3, item: { ...callB, arguments: '{"toolsets":["finance"]}', status: "completed" } },
    { type: "response.completed", response: { id: "resp_1", status: "completed", usage, output: [] } },
  ];
}

test("applyResponseEvent: parallel chaqiruv argument bo'laklari output_index bo'yicha yig'iladi", () => {
  const state = createStreamState();
  const texts = [];
  const usages = [];
  const events = parallelCallEvents();
  // `output_item.done` kelmasdan oldingi holat: bo'laklardan yig'ilgan argumentlar.
  for (const event of events.slice(0, 13)) {
    applyResponseEvent(state, event, { onText: (delta, itemId) => texts.push([delta, itemId]), onUsage: (u) => usages.push(u) });
  }
  assert.equal(state.slots[2].item.arguments, '{"month":202609}');
  assert.equal(state.slots[3].item.arguments, '{"toolsets":["finance"]}');
  assert.equal(state.slots[3].done, false);
  for (const event of events.slice(13)) {
    applyResponseEvent(state, event, { onText: (delta, itemId) => texts.push([delta, itemId]), onUsage: (u) => usages.push(u) });
  }
  assert.deepEqual(texts, [["Tekshi", "msg_1"], ["raman.", "msg_1"]]);
  assert.equal(state.text, "Tekshiraman.");
  assert.equal(state.terminal, "completed");
  assert.equal(usages.length, 1);
  assert.equal(usages[0].output_tokens_details.reasoning_tokens, 256);

  const { items, toolCalls } = finalizeRound(state, 0);
  assert.deepEqual(toolCalls, [
    { id: "call_a", name: "finance_dashboard", arguments: '{"month":202609}' },
    { id: "call_b", name: "open_toolsets", arguments: '{"toolsets":["finance"]}' },
  ]);
  assert.deepEqual(items.map((item) => item.id), ["rs_1", "msg_1", "fc_a", "fc_b"]);
  // Mulohaza elementi O'ZGARTIRILMASDAN qaytadi — shifrlangan matn bilan.
  assert.equal(items[0].encrypted_content, "gAAAA-secret");
  assert.equal(items[1].phase, "commentary");
});

test("buildNextRoundInput: model chiqishi + chaqiruv tartibida function_call_output", () => {
  const state = createStreamState();
  for (const event of parallelCallEvents()) applyResponseEvent(state, event);
  const { items, toolCalls } = finalizeRound(state, 0);
  const next = buildNextRoundInput(items, toolCalls, [{ content: '{"ok":true,"data":1}' }, { content: '{"ok":false,"error":"x"}' }]);
  assert.deepEqual(
    next.map((item) => item.type),
    ["reasoning", "message", "function_call", "function_call", "function_call_output", "function_call_output"],
  );
  assert.deepEqual(next.slice(4), [
    { type: "function_call_output", call_id: "call_a", output: '{"ok":true,"data":1}' },
    { type: "function_call_output", call_id: "call_b", output: '{"ok":false,"error":"x"}' },
  ]);
});

test("finalizeRound: kesilgan chaqiruv va undan oldingi mulohaza tashlanadi, call_id bo'lmasa beriladi", () => {
  const state = createStreamState();
  const events = [
    { type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "e1" } },
    { type: "response.output_item.done", output_index: 1, item: { id: "fc_1", type: "function_call", name: "x_tool", arguments: "{}", status: "completed" } },
    { type: "response.output_item.done", output_index: 2, item: { id: "rs_2", type: "reasoning", summary: [], encrypted_content: "e2" } },
    { type: "response.output_item.added", output_index: 3, item: { id: "fc_2", type: "function_call", call_id: "call_2", name: "y_tool", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 3, item_id: "fc_2", delta: '{"a":' },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
  ];
  for (const event of events) applyResponseEvent(state, event);
  assert.equal(state.terminal, "incomplete");
  assert.equal(state.incompleteReason, "max_output_tokens");
  const { items, toolCalls } = finalizeRound(state, 4);
  assert.deepEqual(toolCalls, [{ id: "call_4_1", name: "x_tool", arguments: "{}" }]);
  assert.deepEqual(items.map((item) => item.id), ["rs_1", "fc_1"]);
  assert.equal(items[1].call_id, "call_4_1");
});

test("applyResponseEvent: yakuniy javobdagi output tushib qolgan elementni to'ldiradi", () => {
  const state = createStreamState();
  applyResponseEvent(state, {
    type: "response.completed",
    response: {
      usage: { input_tokens: 5, output_tokens: 7 },
      output: [{ id: "fc_9", type: "function_call", call_id: "call_9", name: "x_tool", arguments: '{"q":1}', status: "completed" }],
    },
  });
  assert.deepEqual(finalizeRound(state, 0).toolCalls, [{ id: "call_9", name: "x_tool", arguments: '{"q":1}' }]);
});

test("applyResponseEvent: failed va error hodisalari kod bilan xato otadi, usage oldin yoziladi", () => {
  const usages = [];
  assert.throws(
    () =>
      applyResponseEvent(
        createStreamState(),
        {
          type: "response.failed",
          response: { usage: { input_tokens: 10, output_tokens: 0 }, error: { code: "rate_limit_exceeded", message: "slow down" } },
        },
        { onUsage: (u) => usages.push(u) },
      ),
    (err) => err instanceof ResponseStreamError && err.kind === "failed" && err.code === "rate_limit_exceeded",
  );
  assert.equal(usages.length, 1);
  assert.throws(
    () => applyResponseEvent(createStreamState(), { type: "error", code: "server_error", message: "boom" }),
    (err) => err instanceof ResponseStreamError && err.kind === "error" && err.code === "server_error",
  );
});

async function* eventStream(events, { abortAfter = null, controller = null } = {}) {
  for (const [index, event] of events.entries()) {
    if (abortAfter !== null && index === abortAfter) {
      controller.abort();
      return; // SDK uzilishda oqimni jim tugatadi
    }
    yield event;
  }
}

test("consumeResponseStream: uzilish → AiAbortedError, yakuniy hodisasiz oqim → ended", async () => {
  const controller = new AbortController();
  await assert.rejects(
    consumeResponseStream(eventStream(parallelCallEvents(), { abortAfter: 5, controller }), { signal: controller.signal }),
    (err) => err instanceof AiAbortedError,
  );
  await assert.rejects(
    consumeResponseStream(eventStream(parallelCallEvents().slice(0, 8)), { signal: new AbortController().signal }),
    (err) => err instanceof ResponseStreamError && err.kind === "ended",
  );
});

function fakeTurn(model = MODELS.chat) {
  return { model, conversation: { id: "c".repeat(24) }, content: "", promptTokens: 0, completionTokens: 0, hasUsage: false };
}

function fakeClient(responders) {
  const requests = [];
  return {
    requests,
    responses: {
      create: async (body, options) => {
        requests.push({ body, options });
        const next = responders.shift();
        if (next instanceof Error) throw next;
        return eventStream(next);
      },
    },
  };
}

test("streamRound: deltalar SSE ga, usage input/output → prompt/completion, bloklar bo'sh qator bilan", async () => {
  const events = parallelCallEvents();
  // Ikkinchi xabar elementi — alohida blok bo'lib ajralishi kerak.
  events.splice(7, 0,
    { type: "response.output_item.added", output_index: 9, item: { id: "msg_2", type: "message", role: "assistant", content: [] } },
    { type: "response.output_text.delta", output_index: 9, item_id: "msg_2", delta: "Keyin" },
  );
  const client = fakeClient([events]);
  const turn = fakeTurn();
  turn.content = "Oldingi raund.";
  const sent = [];
  const result = await streamRound(
    turn,
    { instructions: "SYS", input: [], tools: REGISTRY_TOOLS, toolChoice: "auto", round: 1, signal: new AbortController().signal, send: (e, d) => sent.push([e, d]) },
    client,
  );
  assert.deepEqual(sent, [["delta", { text: "\n\nTekshi" }], ["delta", { text: "raman." }], ["delta", { text: "\n\nKeyin" }]]);
  assert.equal(turn.content, "Oldingi raund.\n\nTekshiraman.\n\nKeyin");
  assert.equal(turn.hasUsage, true);
  assert.equal(turn.promptTokens, 1200);
  assert.equal(turn.completionTokens, 340);
  assert.equal(result.toolCalls.length, 2);
  assert.equal(client.requests[0].body.reasoning.effort, "medium");
  assert.equal(client.requests[0].options.timeout, LIMITS.modelTimeoutMs);
});

test("streamRound: model_not_found → zaxira model bilan bir marta, reasoning'siz", async () => {
  const notFound = new OpenAI.NotFoundError(404, { code: "model_not_found", message: "The model does not exist" }, undefined, new Headers());
  assert.equal(isModelNotFound(notFound), true);
  const client = fakeClient([
    notFound,
    [
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } },
      { type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "Javob" },
      { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 4 } } },
    ],
  ]);
  const turn = fakeTurn();
  const input = [{ id: "rs_1", type: "reasoning", summary: [], encrypted_content: "e" }, { role: "user", content: "Savol" }];
  const result = await streamRound(
    turn,
    { instructions: "SYS", input, tools: REGISTRY_TOOLS, toolChoice: "auto", round: 0, signal: new AbortController().signal, send: () => {} },
    client,
  );
  assert.equal(result.text, "Javob");
  assert.equal(turn.model, MODELS.chatFallback);
  assert.equal(client.requests.length, 2);
  assert.equal(client.requests[1].body.model, MODELS.chatFallback.id);
  assert.equal("reasoning" in client.requests[1].body, false);
  assert.deepEqual(client.requests[1].body.input, [{ role: "user", content: "Savol" }]);
});

test("streamRound: token chegarasida hech narsa chiqmasa aniq xato, matn bo'lsa davom etadi", async () => {
  const incomplete = { type: "response.incomplete", response: { usage: { input_tokens: 9, output_tokens: 8000 }, incomplete_details: { reason: "max_output_tokens" } } };
  const signal = new AbortController().signal;
  const options = { instructions: "SYS", input: [], tools: REGISTRY_TOOLS, toolChoice: "auto", round: 0, signal, send: () => {} };

  const emptyTurn = fakeTurn();
  await assert.rejects(streamRound(emptyTurn, options, fakeClient([[incomplete]])), (err) => {
    assert.ok(err instanceof ResponseStreamError);
    const mapped = mapOpenAiError(err);
    assert.equal(mapped.code, "internal");
    assert.match(mapped.message, /token chegarasi/);
    return true;
  });
  assert.equal(emptyTurn.completionTokens, 8000);

  const partialTurn = fakeTurn();
  const partial = await streamRound(
    partialTurn,
    options,
    fakeClient([[{ type: "response.output_text.delta", item_id: "msg_1", delta: "Qisman" }, incomplete]]),
  );
  assert.equal(partial.text, "Qisman");
  assert.deepEqual(partial.toolCalls, []);
});

test("streamRound: to'xtab qolgan oqim raund muddatida timeout bo'ladi, egasining uzilishi bilan chalkashmaydi", async () => {
  /** SDK kabi: signal uzilganda oqim XATOSIZ tugaydi. */
  const stalledClient = (phase) => ({
    responses: {
      create: async (body, options) => {
        const waitForAbort = () =>
          new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
        if (phase === "headers") {
          await waitForAbort();
          throw new OpenAI.APIUserAbortError();
        }
        return (async function* stalled() {
          yield { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", content: [] } };
          await waitForAbort();
        })();
      },
    },
  });
  const base = { instructions: "SYS", input: [], tools: REGISTRY_TOOLS, toolChoice: "auto", round: 0, send: () => {}, timeoutMs: 30 };

  for (const phase of ["headers", "body"]) {
    await assert.rejects(
      streamRound(fakeTurn(), { ...base, signal: new AbortController().signal }, stalledClient(phase)),
      (err) => {
        assert.equal(mapOpenAiError(err).code, "timeout", phase);
        return true;
      },
    );
  }

  const owner = new AbortController();
  setTimeout(() => owner.abort(), 5);
  await assert.rejects(
    streamRound(fakeTurn(), { ...base, timeoutMs: 60000, signal: owner.signal }, stalledClient("body")),
    (err) => err instanceof AiAbortedError,
  );
});

test("buildHistory: yakunlanmagan javob belgilanadi", () => {
  const [partial] = buildHistory([{ role: "assistant", status: "interrupted", content: "| Sinf | Qarz |", actions: [] }]);
  assert.match(partial.content, /\[Bu javob yakunlanmay qolgan\]$/);
  const [complete] = buildHistory([{ role: "assistant", status: "complete", content: "Tayyor.", actions: [] }]);
  assert.equal(complete.content, "Tayyor.");
});

test("mapOpenAiError: Responses oqim xatolari o'zbekcha kodlarga", () => {
  const codeOf = (err) => mapOpenAiError(err).code;
  assert.equal(codeOf(new ResponseStreamError({ kind: "failed", code: "rate_limit_exceeded" })), "rate_limited");
  assert.equal(codeOf(new ResponseStreamError({ kind: "error", code: "insufficient_quota" })), "quota_exceeded");
  assert.equal(codeOf(new ResponseStreamError({ kind: "failed", code: "server_error" })), "model_unavailable");
  assert.equal(codeOf(new ResponseStreamError({ kind: "failed", code: "something_new" })), "model_unavailable");
  assert.equal(codeOf(new ResponseStreamError({ kind: "ended" })), "model_unavailable");
  assert.match(mapOpenAiError(new ResponseStreamError({ kind: "incomplete", reason: "content_filter" })).message, /filtri/);
  assert.match(mapOpenAiError(new ResponseStreamError({ kind: "failed", code: "context_length_exceeded" })).message, /sig'imidan/);
  // SDK oqimdagi `{ error: {...} }` dan holatsiz APIError yasaydi.
  assert.equal(codeOf(new OpenAI.APIError(undefined, { code: "rate_limit_exceeded", message: "x" }, undefined, undefined)), "rate_limited");
  assert.equal(codeOf(new OpenAI.APIError(undefined, { message: "x" }, undefined, undefined)), "model_unavailable");
  assert.equal(codeOf(new OpenAI.BadRequestError(400, { message: "bad" }, undefined, new Headers())), "internal");
  assert.equal(
    codeOf(new OpenAI.RateLimitError(429, { code: "insufficient_quota", message: "q" }, undefined, new Headers())),
    "quota_exceeded",
  );
  const first = mapOpenAiError(new Error("x"));
  first.message = "o'zgardi";
  assert.notEqual(mapOpenAiError(new Error("x")).message, "o'zgardi");
});

test("cleanTitle: qo'shtirnoq va oxirgi tinish belgisi olinadi, apostrof qoladi", () => {
  assert.equal(cleanTitle('"O\'quvchilar qarzdorligi tahlili."'), "O'quvchilar qarzdorligi tahlili");
  assert.equal(cleanTitle("Sarlavha: To'lovlar holati!\nortiqcha"), "To'lovlar holati");
  assert.equal(cleanTitle("Bugungi o‘quvchilar soni"), "Bugungi o'quvchilar soni");
  assert.equal(cleanTitle("  "), null);
  assert.equal(cleanTitle("a".repeat(120)).length, LIMITS.maxTitleLength);
});

test("acquireTurnLock: bitta suhbat band, egada 2 tadan ortiq tur yo'q, release idempotent", () => {
  const ownerId = "o".repeat(24);
  const first = acquireTurnLock({ schemaName: "public", ownerId, conversationId: "c1" });
  assert.throws(
    () => acquireTurnLock({ schemaName: "public", ownerId: "other", conversationId: "c1" }),
    (err) => err.statusCode === 409 && err.details.reason === "busy",
  );
  // Boshqa filialdagi xuddi shu id — boshqa suhbat.
  const otherBranch = acquireTurnLock({ schemaName: "br_x", ownerId: "other", conversationId: "c1" });
  otherBranch.release();

  const second = acquireTurnLock({ schemaName: "public", ownerId, conversationId: null });
  assert.equal(MAX_CONCURRENT_TURNS_PER_OWNER, 2);
  assert.throws(
    () => acquireTurnLock({ schemaName: "public", ownerId, conversationId: "c2" }),
    (err) => err.statusCode === 429,
  );
  second.attachConversation("c3");
  assert.throws(() => acquireTurnLock({ schemaName: "public", ownerId: "other", conversationId: "c3" }));

  first.release();
  first.release();
  second.release();
  const again = acquireTurnLock({ schemaName: "public", ownerId, conversationId: "c3" });
  again.release();
});

// ── Ovoz ───────────────────────────────────────────────────────────────

test("ovoz: mime → kengaytma, davomiylik va fayl tekshiruvi", () => {
  assert.equal(extensionForMime("audio/webm;codecs=opus"), "webm");
  assert.equal(extensionForMime("audio/x-m4a"), "m4a");
  assert.equal(extensionForMime("image/png"), null);

  assert.equal(parseVoiceDuration(undefined), null);
  assert.equal(parseVoiceDuration("abc"), null);
  assert.equal(parseVoiceDuration("-5"), null);
  assert.equal(parseVoiceDuration("1234.6"), 1235);
  assert.throws(() => parseVoiceDuration(LIMITS.maxVoiceSeconds * 1000 + 1));

  assert.deepEqual(assertVoiceFile({ buffer: Buffer.from("x"), size: 1, mimetype: "audio/webm" }).mimeType, "audio/webm");
  assert.throws(() => assertVoiceFile({ buffer: Buffer.alloc(0), size: 0, mimetype: "audio/webm" }));
  assert.throws(() => assertVoiceFile({ buffer: Buffer.from("x"), size: LIMITS.maxVoiceBytes + 1, mimetype: "audio/webm" }));
  assert.throws(() => assertVoiceFile({ buffer: Buffer.from("x"), size: 1, mimetype: "application/pdf" }));
});

test("ovoz: markdown o'qiladigan matnga aylanadi va gap chegarasida kesiladi", () => {
  const markdown = [
    "### Umumiy holat",
    "",
    "- **Qarzdorlik**: 4 500 000 so'm",
    "- `Batafsil` [hisobot](/finance)",
    "",
    "| Sinf | Qarz |",
    "|---|---:|",
    "| 5-A | 1 200 000 so'm |",
  ].join("\n");
  assert.equal(
    stripMarkdownForSpeech(markdown),
    "Umumiy holat Qarzdorlik: 4 500 000 so'm Batafsil hisobot Sinf, Qarz. 5-A, 1 200 000 so'm.",
  );
  assert.equal(cutAtSentence("Birinchi gap tugadi. Ikkinchi gap juda uzun davom etadi", 30), "Birinchi gap tugadi.");
  assert.equal(cutAtSentence("Qisqa. Keyingi gap juda uzun davom etadi", 30), "Qisqa. Keyingi gap juda uzun");
  assert.equal(cutAtSentence("qisqa", 30), "qisqa");
});

// ── Prompt ─────────────────────────────────────────────────────────────

test("buildSystemPrompt: ega, filial, sana, oy va bo'limlar holati kiradi", () => {
  const prompt = buildSystemPrompt({
    user: { firstName: "Vali", lastName: "Aliyev" },
    branch: { name: "Chilonzor" },
    now: new Date("2026-09-14T06:00:00.000Z"),
    monthKey: 202609,
    activeToolsets: ["finance"],
  });
  assert.match(prompt, /Vali Aliyev/);
  assert.match(prompt, /Chilonzor/);
  assert.match(prompt, /14-sentabr, 2026/);
  assert.match(prompt, /Sentabr, 2026/);
  assert.match(prompt, /`finance` \(OPEN\)/);
  assert.match(prompt, /`payroll` \(closed\)/);
  assert.match(prompt, /platform_health_scan/);
  assert.match(prompt, /Tasdiqlash/);
});

test("ovoz: Spaces kaliti filial schema'si va suhbat bo'yicha, kengaytma mime'dan", () => {
  const { buildVoiceKey } = require("../src/services/aiAssistant/assistantVoice.service");
  const key = buildVoiceKey({ schemaName: "br_chilonzor", conversationId: "a".repeat(24), mimeType: "audio/mp4" });
  assert.match(key, /^ai-assistant\/voice\/br_chilonzor\/a{24}\/[a-f0-9]{24}\.mp4$/);
});

test("ovoz: Spaces'ga yuklash yiqilsa suhbat to'xtamaydi (kalit null)", async () => {
  const voiceService = require("../src/services/aiAssistant/assistantVoice.service");
  const fileStorage = require("../src/services/fileStorage.service");
  const original = fileStorage.uploadPrivateBuffer;
  let uploaded = null;
  try {
    fileStorage.uploadPrivateBuffer = async () => {
      throw new Error("network down");
    };
    const failed = await voiceService.storeVoiceClip({
      buffer: Buffer.from("x"),
      mimeType: "audio/webm",
      schemaName: "public",
      conversationId: "b".repeat(24),
    });
    if (voiceService.isVoiceStorageConfigured()) assert.equal(failed, null);

    fileStorage.uploadPrivateBuffer = async (params) => {
      uploaded = params;
      return { key: params.key, size: params.buffer.length };
    };
    const key = await voiceService.storeVoiceClip({
      buffer: Buffer.from("x"),
      mimeType: "audio/webm",
      schemaName: "public",
      conversationId: "b".repeat(24),
    });
    if (voiceService.isVoiceStorageConfigured()) {
      assert.equal(key, uploaded.key);
      assert.equal(uploaded.contentType, "audio/webm");
    }
  } finally {
    fileStorage.uploadPrivateBuffer = original;
  }
});
