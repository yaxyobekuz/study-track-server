const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * SHARTNOMA SHARTI — DAVR REJASI.
 *
 * `planRuleChange` sof funksiya: vedomost oynasida "Saqlash" bosilganda
 * oylik qoidalariga nima qilinishini hal qiladi. Oldindan ko'rish ham,
 * saqlash ham SHU natijadan o'qiydi, shuning uchun eng xavfli joy —
 * davrlar kesishib qolishi yoki o'tgan oy tarixining qayta yozilishi —
 * shu yerda tekshiriladi.
 */

const { planRuleChange } = require("../src/services/staffContract.service");
const { Decimal } = require("../src/helpers/money.helpers");

const rule = (id, startMonth, endMonth, fixed, extra = {}) => ({
  id,
  startMonth,
  endMonth,
  fixedAmount: new Decimal(fixed),
  perHourRate: new Decimal(extra.rate ?? 0),
  allowances: extra.allowances ?? [],
  note: extra.note ?? "",
  categoryId: extra.categoryId ?? null,
});

const draft = (fixed, extra = {}) => ({
  fixedAmount: new Decimal(fixed),
  perHourRate: new Decimal(extra.rate ?? 0),
  categoryId: null,
  allowances: extra.allowances ?? [],
  note: extra.note ?? "",
});

test("qoida yo'q — keyingi qoidagacha yangi davr ochiladi", () => {
  const open = planRuleChange([], 202609, draft(5_000_000), true);
  assert.equal(open.kind, "create");
  assert.deepEqual(open.create, { startMonth: 202609, endMonth: null });

  const gap = planRuleChange(
    [rule("a", 202601, 202603, 5_000_000), rule("b", 202611, null, 7_000_000)],
    202606,
    draft(6_000_000),
    true,
  );
  assert.equal(gap.kind, "create");
  assert.deepEqual(gap.create, { startMonth: 202606, endMonth: 202610 });
});

test("shart o'zgarmagan — hech narsa yozilmaydi", () => {
  const rules = [rule("a", 202601, null, 5_000_000, { allowances: [{ label: "S", type: "fixed", value: 100 }] })];

  const same = planRuleChange(
    rules,
    202609,
    draft(5_000_000, { allowances: [{ label: "S", type: "fixed", value: 100 }] }),
    true,
  );
  assert.equal(same.kind, "none");

  const noteOnly = planRuleChange(
    rules,
    202609,
    draft(5_000_000, { allowances: [{ label: "S", type: "fixed", value: 100 }], note: "izoh" }),
    true,
  );
  assert.equal(noteOnly.kind, "note");
});

test("qoida SHU oydan boshlangan — o'sha qator yangilanadi yoki o'chiriladi", () => {
  const rules = [rule("a", 202609, null, 5_000_000)];
  assert.equal(planRuleChange(rules, 202609, draft(6_000_000), true).kind, "update");
  assert.equal(planRuleChange(rules, 202609, draft(0), false).kind, "delete");
});

test("qoida OLDINROQ boshlangan — o'tgan oylar eski summada qoladi", () => {
  const split = planRuleChange(
    [rule("a", 202601, null, 5_000_000)],
    202609,
    draft(6_000_000),
    true,
  );
  assert.equal(split.kind, "split");
  assert.equal(split.closeAt, 202608);
  assert.deepEqual(split.create, { startMonth: 202609, endMonth: null });

  // Yil chegarasi: yanvardan o'zgarsa eski qoida dekabrda yopiladi
  const newYear = planRuleChange([rule("a", 202509, null, 5_000_000)], 202601, draft(6_000_000), true);
  assert.equal(newYear.closeAt, 202512);

  const close = planRuleChange([rule("a", 202601, null, 5_000_000)], 202609, draft(0), false);
  assert.equal(close.kind, "close");
  assert.equal(close.create, null);
});

test("yopiq davr ichida o'zgarsa yangi davr keyingi qoidaga kesishmaydi", () => {
  const plan = planRuleChange(
    [rule("a", 202601, 202612, 5_000_000), rule("b", 202701, null, 7_000_000)],
    202609,
    draft(6_000_000),
    true,
  );
  assert.equal(plan.kind, "split");
  assert.deepEqual(plan.create, { startMonth: 202609, endMonth: 202612 });
});

test("qo'lda soat narxi o'zgarishi ham yangi shart hisoblanadi", () => {
  const plan = planRuleChange(
    [rule("a", 202601, null, 5_000_000, { rate: 40_000 })],
    202609,
    draft(5_000_000, { rate: 45_000 }),
    true,
  );
  assert.equal(plan.kind, "split");
});

test("eski qoidadagi toifa izi tozalanadi (dvigatel uni o'qimaydi)", () => {
  const plan = planRuleChange(
    [rule("a", 202601, null, 0, { categoryId: "cat1" })],
    202609,
    draft(0),
    false,
  );
  assert.equal(plan.kind, "close");
});
