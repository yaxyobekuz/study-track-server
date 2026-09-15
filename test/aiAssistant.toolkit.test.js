const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AiToolError,
  defineTool,
  defineAction,
  validateArgs,
  lintSchema,
  idSchema,
  monthSchema,
  limitSchema,
  requireId,
  monthArg,
  dayArg,
  reqLike,
  formatMoneyUz,
  monthLabel,
  sliceList,
  pick,
  personName,
} = require("../src/services/aiAssistant/assistant.toolkit");
const { currentMonthKey, todayIsoTashkent } = require("../src/helpers/month.helpers");

const SCHEMA = {
  type: "object",
  properties: {
    month: monthSchema(),
    limit: limitSchema(50),
    active: { type: "boolean", description: "Only active rows." },
    name: { type: "string", description: "Name filter.", maxLength: 10 },
    status: { type: "string", description: "Status.", enum: ["open", "closed"], default: "open" },
    ids: { type: "array", description: "Ids.", items: idSchema("Id"), maxItems: 2 },
  },
  additionalProperties: false,
};

test("validateArgs: raqamli satr songa, 'true' booleanga aylanadi, satr trim qilinadi", () => {
  const out = validateArgs(SCHEMA, { month: "202609", limit: "15", active: "true", name: "  Ali  " });
  assert.equal(out.month, 202609);
  assert.equal(out.limit, 15);
  assert.equal(out.active, true);
  assert.equal(out.name, "Ali");
});

test("validateArgs: noma'lum kalit tashlanadi, bo'sh ixtiyoriy maydon default oladi", () => {
  const out = validateArgs(SCHEMA, { extra: 1, name: "", status: null });
  assert.equal("extra" in out, false);
  assert.equal("name" in out, false);
  assert.equal(out.status, "open");
});

test("validateArgs: chegara, enum, pattern va tur buzilsa AiToolError", () => {
  assert.throws(() => validateArgs(SCHEMA, { limit: 51 }), AiToolError);
  assert.throws(() => validateArgs(SCHEMA, { status: "archived" }), AiToolError);
  assert.throws(() => validateArgs(SCHEMA, { ids: ["zz"] }), AiToolError);
  assert.throws(() => validateArgs(SCHEMA, { ids: ["a".repeat(24), "b".repeat(24), "c".repeat(24)] }), AiToolError);
  assert.throws(() => validateArgs(SCHEMA, { active: "ha" }), AiToolError);
  assert.throws(() => validateArgs(SCHEMA, { name: "x".repeat(11) }), AiToolError);
});

test("validateArgs: majburiy maydon yo'q bo'lsa xato", () => {
  const schema = {
    type: "object",
    properties: { id: idSchema("Target id.") },
    required: ["id"],
    additionalProperties: false,
  };
  assert.throws(() => validateArgs(schema, {}), /majburiy/);
});

test("lintSchema: toza sxema muammosiz, noto'g'ri kalit va description yo'qligi topiladi", () => {
  assert.deepEqual(lintSchema(SCHEMA), []);
  const problems = lintSchema({
    type: "object",
    properties: { a: { type: "string", format: "date" }, b: { type: "array" } },
    required: ["c"],
  });
  assert.ok(problems.some((p) => p.includes('"format"')));
  assert.ok(problems.some((p) => p.includes('parameters.a: "description"')));
  assert.ok(problems.some((p) => p.includes('"items"')));
  assert.ok(problems.some((p) => p.includes('required "c"')));
});

test("defineTool / defineAction: shakl buzilsa require paytida xato otadi", () => {
  const base = {
    toolset: "core",
    description: "Returns a compact summary used by tests only.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  };
  assert.throws(() => defineTool({ ...base, name: "Bad-Name", label: "X", handler: async () => ({}) }));
  assert.throws(() => defineTool({ ...base, name: "propose_x_y", label: "X", handler: async () => ({}) }));
  assert.throws(() => defineTool({ ...base, name: "no_label_tool", handler: async () => ({}) }));
  const tool = defineTool({ ...base, name: "valid_tool", label: "Sinov", handler: async () => ({}) });
  assert.equal(tool.kind, "read");
  assert.equal(Object.isFrozen(tool), true);

  const action = {
    ...base,
    toolset: "people",
    type: "people.test_action",
    toolName: "propose_test_action",
    title: "Sinov amali",
    risk: "low",
    prepare: async () => ({}),
    execute: async () => ({}),
  };
  assert.equal(defineAction(action).kind, "action");
  assert.throws(() => defineAction({ ...action, risk: "extreme" }));
  assert.throws(() => defineAction({ ...action, toolName: "test_action" }));
  assert.throws(() => defineAction({ ...action, type: "noDot" }));
});

test("requireId / monthArg / dayArg: bo'sh qiymat joriy oy va bugunga tushadi", () => {
  assert.equal(requireId("a".repeat(24)), "a".repeat(24));
  assert.throws(() => requireId("123"), AiToolError);
  assert.equal(monthArg(undefined), currentMonthKey());
  assert.equal(monthArg("2026-09"), 202609);
  assert.throws(() => monthArg("2026-13"), AiToolError);
  assert.equal(dayArg(""), todayIsoTashkent());
  assert.equal(dayArg("2026-09-14"), "2026-09-14");
  assert.throws(() => dayArg("2026-02-30"), AiToolError);
});

test("reqLike: qiymatlar satrga, limit doim beriladi, bo'shlari tashlanadi", () => {
  const ctx = { user: { id: "u" }, branch: { id: "b" } };
  const req = reqLike(ctx, { page: 2, activeOnly: true, search: "", ids: [1, 2] });
  assert.deepEqual(req.query, { page: "2", activeOnly: "true", ids: ["1", "2"], limit: "20" });
  assert.equal(req.user, ctx.user);
  assert.equal(req.branch, ctx.branch);
});

test("formatMoneyUz / monthLabel / sliceList / pick / personName", () => {
  assert.equal(formatMoneyUz("4500000.00"), "4 500 000 so'm");
  assert.equal(formatMoneyUz("-1200.50"), "−1 200,50 so'm");
  assert.equal(formatMoneyUz(null), "—");
  assert.equal(monthLabel(202609), "Sentabr, 2026");
  assert.deepEqual(sliceList([1, 2, 3], 2), { items: [1, 2], total: 3, truncated: true });
  assert.deepEqual(sliceList(null, 2), { items: [], total: 0, truncated: false });
  assert.deepEqual(pick({ a: 1, b: 2, c: undefined }, ["a", "c"]), { a: 1 });
  assert.equal(personName({ firstName: "Vali", lastName: "Aliyev" }), "Vali Aliyev");
  assert.equal(personName(null), "—");
});
