const test = require("node:test");
const assert = require("node:assert/strict");
const { Prisma } = require("../src/generated/prisma");

const {
  sanitizeValue,
  toJsonSafe,
  toStorableJson,
  toModelJson,
  decodeXssText,
} = require("../src/services/aiAssistant/assistant.sanitize");

test("sanitize: sirli kalitlar har qanday chuqurlikda tashlanadi", () => {
  const out = sanitizeValue({
    id: "u1",
    password: "x",
    PlainPassword: "y",
    profile: { token: "t", botToken: "b", apiKey: "k", jti: "j", otp: "1", name: "Ali" },
    sessions: [{ refreshToken: "r", device: "Chrome" }],
  });
  assert.deepEqual(out, { id: "u1", profile: { name: "Ali" }, sessions: [{ device: "Chrome" }] });
});

test("sanitize: Decimal, BigInt, Date satrga; Buffer, funksiya, undefined tashlanadi", () => {
  const out = sanitizeValue({
    amount: new Prisma.Decimal("450000.50"),
    big: 12345678901234567890n,
    at: new Date("2026-09-14T10:00:00.000Z"),
    file: Buffer.from("abc"),
    bytes: new Uint8Array([1, 2]),
    fn: () => 1,
    missing: undefined,
    nan: Number.NaN,
  });
  assert.deepEqual(out, {
    amount: "450000.5",
    big: "12345678901234567890",
    at: "2026-09-14T10:00:00.000Z",
    nan: null,
  });
});

test("sanitize: aylanma havola va juda chuqur obyekt JSON ni buzmaydi", () => {
  const node = { name: "root" };
  node.self = node;
  assert.deepEqual(sanitizeValue(node), { name: "root", self: "[circular]" });

  let deep = { leaf: true };
  for (let i = 0; i < 15; i += 1) deep = { child: deep };
  assert.doesNotThrow(() => JSON.stringify(toJsonSafe(deep)));
  assert.match(JSON.stringify(toJsonSafe(deep)), /too deep/);
});

test("sanitize: bir obyekt ikki joyda uchrasa ikkalasi ham chiqadi (aylanma emas)", () => {
  const shared = { id: "c1" };
  assert.deepEqual(sanitizeValue({ a: shared, b: shared }), { a: { id: "c1" }, b: { id: "c1" } });
});

test("sanitize: uzun satr kesiladi, 100 dan uzun massivga belgi qo'yiladi", () => {
  const out = sanitizeValue({ text: "a".repeat(2500), list: Array.from({ length: 130 }, (_, i) => i) });
  assert.equal(out.text.length, 2001);
  assert.ok(out.text.endsWith("…"));
  assert.equal(out.list.length, 101);
  assert.deepEqual(out.list[100], { _truncated: true, total: 130 });
});

test("toModelJson: hajmdan oshsa eng uzun massiv ikki barobar qisqaradi va jami saqlanadi", () => {
  const value = {
    summary: "ok",
    rows: Array.from({ length: 90 }, (_, i) => ({ id: i, note: "x".repeat(200) })),
    small: [1, 2, 3],
  };
  const json = toModelJson(value, 5000);
  assert.ok(json.length <= 5000);
  const parsed = JSON.parse(json);
  assert.equal(parsed.summary, "ok");
  assert.deepEqual(parsed.small, [1, 2, 3]);
  const marker = parsed.rows[parsed.rows.length - 1];
  assert.deepEqual(marker, { _truncated: true, total: 90 });
  assert.ok(parsed.rows.length < 90);
});

test("toModelJson: massivsiz katta natija preview bilan qaytadi", () => {
  const json = toModelJson({ text: "y".repeat(1900), more: "z".repeat(1900) }, 1000);
  const parsed = JSON.parse(json);
  assert.equal(parsed._truncated, true);
  assert.equal(parsed.preview.length, 800);
});

test("toModelJson: kichik natija o'zgarishsiz", () => {
  assert.equal(toModelJson({ ok: true, data: [1] }), '{"ok":true,"data":[1]}');
  assert.equal(toModelJson(undefined), "null");
});

test("decodeXssText: xss-clean `&lt;` belgisi qaytariladi, boshqasi tegilmaydi", () => {
  assert.equal(decodeXssText("x &lt; 5 && y > 3"), "x < 5 && y > 3");
  assert.equal(decodeXssText(5), 5);
});

test("toStorableJson: amal argumentlari kesilmaydi va kalitlar tashlanmaydi", () => {
  const longText = "a".repeat(5000);
  const ids = Array.from({ length: 250 }, (_, i) => String(i).padStart(24, "0"));
  const out = toStorableJson({ text: longText, studentIds: ids, token: "keep", when: new Date(0), big: 10n });
  assert.equal(out.text.length, 5000);
  assert.equal(out.studentIds.length, 250);
  assert.equal(out.token, "keep");
  assert.equal(out.when, "1970-01-01T00:00:00.000Z");
  assert.equal(out.big, "10");
});

test("toStorableJson: aylanma havola jim yutilmaydi", () => {
  const node = { a: 1 };
  node.self = node;
  assert.throws(() => toStorableJson(node));
});
