const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * UMUMIY KO'RINISH — YO'LLAR REGISTRI.
 *
 * Qabul mezonlari:
 *   - platforma katalogi va shaxsiy ekranlar BITTA filialda bajariladi
 *   - fayl yuklab olish toza rad etiladi (ikkilik javob birlashtirilmaydi)
 *   - `:id` shabloni FAQAT 24-hex ni oladi, ya'ni `/users/export` kabi
 *     quyi-yo'llarni "id" deb qabul qilmaydi
 *   - `locate` dagi HAR BIR model nomi Prisma sxemasida HAQIQATAN bor
 */

process.env.JWT_SECRET = "test-secret-for-aggregate-registry";
process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db?schema=public";

const registry = require("../src/services/aggregateRoute.registry");
const { Prisma } = require("../src/generated/prisma");

const ID = "a".repeat(24);

test("platforma katalogi va infratuzilma — uy filialida", () => {
  for (const path of ["/auth/me", "/tariffs", "/roles", "/permissions", "/discounts", "/branches"]) {
    assert.equal(registry.resolveRule("GET", path).mode, "anchor", path);
  }
});

test("shaxsiy ekranlar va sozlamalar — uy filialida", () => {
  for (const path of [
    "/payroll/my",
    "/payroll/my/breakdown",
    "/devices/me/status",
    "/attendance/my-stats",
    "/finance-settings",
    "/schedule-settings",
  ]) {
    assert.equal(registry.resolveRule("GET", path).mode, "anchor", path);
  }
});

test("eksport — toza rad etiladi, sabab bilan", () => {
  const rule = registry.resolveRule("GET", "/users/export");
  assert.equal(rule.mode, "unsupported");
  assert.match(rule.reason, /filialni tanlang/i);
});

test("platforma katalogining eksporti esa ISHLAYDI (bitta filial)", () => {
  // Anchor yo'l birlashtirishga muhtoj emas, shuning uchun faylga to'siq yo'q.
  assert.equal(registry.resolveRule("GET", "/changelogs/export").mode, "anchor");
});

test("`:id` faqat 24-hex: quyi-yo'llar id deb qabul qilinmaydi", () => {
  assert.equal(registry.resolveRule("GET", "/users/all-short").locate, undefined);
  // ⚠️ `anchor`: sanoqchilar qo'shilmaydi, controller o'zi filiallar
  // bo'ylab birlashtiradi (bir odam ikki filialda ikki marta sanalmasin).
  assert.equal(registry.resolveRule("GET", "/users/stats").mode, "anchor");
  assert.deepEqual(registry.resolveRule("PUT", `/users/${ID}`).locate, {
    model: "user",
    id: ID,
  });
  assert.deepEqual(registry.resolveRule("POST", `/invoices/${ID}/cancel`).locate, {
    model: "monthlyInvoice",
    id: ID,
  });
});

test("yirik ro'yxatlarda tartib E'LON qilingan", () => {
  const users = registry.resolveRule("GET", "/users");
  assert.equal(users.mode, "list");
  assert.deepEqual(users.sort, [{ field: "createdAt", dir: "desc" }]);

  const invoices = registry.resolveRule("GET", "/invoices");
  assert.equal(invoices.sort[0].field, "month");
});

test("registrdagi HAR BIR model Prisma sxemasida bor", () => {
  const models = new Set(
    Prisma.dmmf.datamodel.models.map(
      (m) => m.name.charAt(0).toLowerCase() + m.name.slice(1),
    ),
  );

  const used = new Set(
    registry.RULES.filter((r) => r.locate).map((r) => r.locate.model),
  );

  assert.ok(used.size > 10, "locate qoidalari bo'sh qolmasin");

  for (const model of used) {
    assert.ok(models.has(model), `Prisma sxemasida "${model}" modeli yo'q`);
  }
});

test("noma'lum yo'l — sukut bo'yicha birlashtirishga uriniladi", () => {
  assert.equal(registry.resolveRule("GET", "/some-new-section").mode, "auto");
});
