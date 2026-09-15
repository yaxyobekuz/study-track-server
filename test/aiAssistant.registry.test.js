const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LIMITS,
  TOOLSETS,
  OPENABLE_TOOLSETS,
  TOOL_NAME_PATTERN,
  RISK,
} = require("../src/services/aiAssistant/assistant.constants");
const { lintSchema } = require("../src/services/aiAssistant/assistant.toolkit");
const registry = require("../src/services/aiAssistant/assistant.registry");

/**
 * Domen fayllari registrdan MUSTAQIL qayta o'qiladi: registr takrorni jim
 * tashlab yuborsa ham, test uni shu yerda ko'radi.
 */
function readDomainFiles() {
  const entries = [];
  for (const domain of registry.DOMAINS) {
    for (const group of ["tools", "actions"]) {
      const exported = require(`../src/services/aiAssistant/${group}/${domain}.${group}.js`);
      assert.ok(Array.isArray(exported), `${group}/${domain} massiv eksport qilishi kerak`);
      for (const def of exported) entries.push({ domain, group, def });
    }
  }
  return entries;
}

const ctx = Object.freeze({
  user: { id: "a".repeat(24), role: "owner" },
  branch: { id: "b".repeat(24), name: "Sinov", schemaName: "public" },
  conversationId: "c".repeat(24),
  signal: new AbortController().signal,
  now: new Date(),
  monthKey: 202609,
  today: "2026-09-14",
});

const noHooks = {
  onOpenToolsets: () => {
    throw new Error("chaqirilmasligi kerak");
  },
  reserveActionSlot: () => true,
};

test("registr: yuklashda hech qanday muammo yo'q (ta'rif, takror, toolset tokchasi)", () => {
  const { problems } = registry.lintRegistry();
  assert.deepEqual(problems, []);
});

test("registr: barcha vosita va amal nomlari 14 fayl bo'ylab yagona", () => {
  const seenNames = new Map();
  const seenTypes = new Map();
  for (const { domain, group, def } of readDomainFiles()) {
    const name = group === "tools" ? def.name : def.toolName;
    assert.notEqual(name, registry.OPEN_TOOLSETS_NAME, `${name}: ichki nom band`);
    assert.equal(seenNames.has(name), false, `"${name}" takrorlangan: ${seenNames.get(name)} va ${group}/${domain}`);
    seenNames.set(name, `${group}/${domain}`);
    if (group === "actions") {
      assert.equal(seenTypes.has(def.type), false, `amal turi "${def.type}" takrorlangan`);
      seenTypes.set(def.type, domain);
    }
  }
});

test("registr: har ta'rif sxemasi toza, toolset to'g'ri, yorliq/sarlavha bor", () => {
  for (const { domain, group, def } of readDomainFiles()) {
    const name = group === "tools" ? def.name : def.toolName;
    const where = `${group}/${domain} ${name}`;

    assert.match(name, TOOL_NAME_PATTERN, `${where}: nom formati`);
    assert.ok(TOOLSETS[def.toolset], `${where}: noma'lum toolset`);
    assert.ok(registry.ALLOWED_TOOLSETS[group][domain].includes(def.toolset), `${where}: toolset tokchasi`);
    assert.deepEqual(lintSchema(def.parameters), [], `${where}: sxema`);
    assert.equal(def.parameters.type, "object", `${where}: parameters obyekt`);
    assert.equal(def.parameters.additionalProperties, false, `${where}: additionalProperties`);
    assert.ok(def.description.length >= 20 && def.description.length <= 1024, `${where}: description`);
    assert.ok(Number.isFinite(def.timeoutMs) && def.timeoutMs > 0, `${where}: timeoutMs`);

    if (group === "tools") {
      assert.equal(def.kind, "read", `${where}: defineTool bilan yaratilmagan`);
      assert.equal(name.startsWith("propose_"), false, `${where}: o'qish vositasi propose_ bilan boshlanmaydi`);
      assert.ok(typeof def.label === "string" && def.label.trim() && def.label.length <= 80, `${where}: label`);
      assert.equal(typeof def.handler, "function", `${where}: handler`);
    } else {
      assert.equal(def.kind, "action", `${where}: defineAction bilan yaratilmagan`);
      assert.ok(name.startsWith("propose_"), `${where}: propose_ prefiksi`);
      assert.ok(RISK[def.risk], `${where}: risk`);
      assert.ok(typeof def.title === "string" && def.title.trim() && def.title.length <= 160, `${where}: title`);
      assert.ok(def.type.length <= 80, `${where}: type uzunligi`);
      assert.equal(typeof def.prepare, "function", `${where}: prepare`);
      assert.equal(typeof def.execute, "function", `${where}: execute`);
    }
  }
});

test("getToolDefinitions: core + ochiq bo'limlar + open_toolsets, OpenAI shaklida", () => {
  const coreOnly = registry.getToolDefinitions([]);
  const names = coreOnly.map((d) => d.function.name);
  assert.ok(names.includes(registry.OPEN_TOOLSETS_NAME));
  for (const definition of coreOnly) {
    assert.equal(definition.type, "function");
    assert.equal(typeof definition.function.description, "string");
    assert.equal(definition.function.parameters.type, "object");
    const resolved = registry.resolveTool(definition.function.name);
    if (resolved.kind !== "system") assert.equal(resolved.def.toolset, "core");
  }

  const all = registry.getToolDefinitions([...OPENABLE_TOOLSETS]);
  const allNames = all.map((d) => d.function.name);
  assert.equal(new Set(allNames).size, allNames.length, "vosita nomlari takrorlanmasin");
  const { toolCount, actionCount } = registry.lintRegistry();
  // `maxActiveToolsets` dan ko'p bo'lim so'ralsa eng oxirgilari qoladi.
  const expectedOpen = registry.normalizeToolsets([...OPENABLE_TOOLSETS]);
  const visible = new Set(["core", ...expectedOpen]);
  const expectedCount = all.filter((d) => {
    const resolved = registry.resolveTool(d.function.name);
    return resolved.kind === "system" || visible.has(resolved.def.toolset);
  }).length;
  assert.equal(all.length, expectedCount);
  assert.ok(all.length <= toolCount + actionCount + 1);
});

test("open_toolsets ta'rifi: enum ochiladigan bo'limlar bilan bir xil", () => {
  const schema = registry.OPEN_TOOLSETS_DEFINITION.function.parameters;
  assert.deepEqual(lintSchema(schema), []);
  assert.deepEqual(schema.properties.toolsets.items.enum, [...OPENABLE_TOOLSETS]);
});

test("mergeToolsets: takror yo'q, yangisi oxirida, chegaradan oshsa eskisi yopiladi", () => {
  assert.deepEqual(registry.mergeToolsets(["finance"], ["people", "finance"]), ["people", "finance"]);
  assert.deepEqual(registry.mergeToolsets([], ["core", "unknown", "schedule"]), ["schedule"]);
  const many = registry.mergeToolsets(["people", "finance", "payroll", "academic"], ["schedule"]);
  assert.equal(many.length, LIMITS.maxActiveToolsets);
  assert.equal(many[many.length - 1], "schedule");
  assert.equal(many.includes("people"), false);
});

test("parseToolArguments: bo'sh → {}, yaroqsiz JSON va massiv → AiToolError", () => {
  assert.deepEqual(registry.parseToolArguments(""), {});
  assert.deepEqual(registry.parseToolArguments('{"a":1}'), { a: 1 });
  assert.throws(() => registry.parseToolArguments("{a:1"), /JSON/);
  assert.throws(() => registry.parseToolArguments("[1]"), /obyekt/);
});

test("runTool: noma'lum vosita va buzuq argument xato OTMAYDI, konvert qaytaradi", async () => {
  const unknown = await registry.runTool({ id: "c1", name: "no_such_tool", arguments: "{}" }, ctx, noHooks);
  assert.equal(unknown.step.status, "error");
  assert.equal(unknown.step.kind, "system");
  assert.equal(JSON.parse(unknown.content).ok, false);

  const bad = await registry.runTool(
    { id: "c2", name: registry.OPEN_TOOLSETS_NAME, arguments: "{oops" },
    ctx,
    noHooks,
  );
  assert.equal(JSON.parse(bad.content).ok, false);
  assert.equal(bad.step.id, "c2");
});

test("runTool: open_toolsets hook orqali ochadi va noto'g'ri kalitni rad etadi", async () => {
  let received = null;
  const hooks = {
    ...noHooks,
    onOpenToolsets: (keys) => {
      received = keys;
      return { activeToolsets: keys, opened: keys.map(registry.describeToolset) };
    },
  };
  const ok = await registry.runTool(
    { id: "c3", name: registry.OPEN_TOOLSETS_NAME, arguments: '{"toolsets":["finance"]}' },
    ctx,
    hooks,
  );
  assert.deepEqual(received, ["finance"]);
  const envelope = JSON.parse(ok.content);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.opened[0].key, "finance");
  assert.equal(ok.step.kind, "system");
  assert.equal(ok.step.label, registry.OPEN_TOOLSETS_LABEL);

  const rejected = await registry.runTool(
    { id: "c4", name: registry.OPEN_TOOLSETS_NAME, arguments: '{"toolsets":["core"]}' },
    ctx,
    hooks,
  );
  assert.equal(JSON.parse(rejected.content).ok, false);
});

test("runTool: amal chegarasi tugagan bo'lsa taklif bazaga yetmay rad etiladi", async (t) => {
  const { actions } = registry.loadRegistry();
  const first = actions.values().next().value;
  if (!first) {
    t.skip("hozircha ro'yxatdan o'tgan amal yo'q");
    return;
  }
  const outcome = await registry.runTool(
    { id: "c5", name: first.def.toolName, arguments: "{}" },
    ctx,
    { ...noHooks, reserveActionSlot: () => false },
  );
  const envelope = JSON.parse(outcome.content);
  assert.equal(envelope.ok, false);
  assert.match(envelope.error, new RegExp(`${LIMITS.maxActionsPerTurn} ta amal`));
  assert.equal(outcome.step.kind, "action");
});

test("withTimeout: vaqt tugashi va bekor qilish poygada yutadi", async () => {
  await assert.rejects(
    registry.withTimeout(() => new Promise(() => {}), { timeoutMs: 20, timeoutMessage: "kech qoldi" }),
    (err) => err instanceof registry.AiTimeoutError && err.message === "kech qoldi",
  );

  const controller = new AbortController();
  const pending = registry.withTimeout(() => new Promise(() => {}), {
    timeoutMs: 5000,
    signal: controller.signal,
    timeoutMessage: "x",
  });
  controller.abort();
  await assert.rejects(pending, (err) => err instanceof registry.AiAbortedError);

  assert.equal(await registry.withTimeout(async () => 42, { timeoutMs: 100, timeoutMessage: "x" }), 42);
});

test("publicErrorMessage: 5xx ichki tafsiloti yashiriladi", () => {
  const internal = Object.assign(new Error("PrismaClientKnownRequestError: secret"), { statusCode: 500 });
  assert.equal(registry.publicErrorMessage(internal, "umumiy"), "umumiy");
  const expected = Object.assign(new Error("Xodim topilmadi"), { statusCode: 404 });
  assert.equal(registry.publicErrorMessage(expected, "umumiy"), "Xodim topilmadi");
});
