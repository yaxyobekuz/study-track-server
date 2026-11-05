const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * DIAGNOSTIKA — AI YOZGAN SAVOLNI FILTRLASH.
 *
 * ⚠️ IKKI QOIDA SHU FAYLDA QOTIRILGAN:
 *
 *   1. MAVZUDAN CHIQIB KETGAN SAVOL TASHLANADI. Model boshqa mavzuni
 *      yozsa, savol "to'g'rilanmaydi": aks holda "kelgan mavzudan o'tib
 *      ketmaslik" qoidasi modelning xohishiga qolardi.
 *
 *   2. TO'G'RI JAVOBI NOANIQ SAVOL HAM TASHLANADI. Eski generatorda
 *      (`ai.service.js`) to'g'ri variant bo'lmasa BIRINCHISI to'g'ri deb
 *      belgilanardi — diagnostikada bu xato javob KALITI bo'lib
 *      saqlanardi va o'sha savolga javob bergan HAR BIR o'quvchi jimgina
 *      "xato" deb belgilanardi.
 */

const {
  spreadTopics,
  parseBlueprint,
} = require("../src/helpers/diagnosticBlueprint.helpers");
const ai = require("../src/services/diagnosticAiQuestion.service");

const topics = (n) =>
  Array.from({ length: n }, (_, i) => ({ order: i + 1, name: `Mavzu ${i + 1}` }));

const sum = (rows) => rows.reduce((total, row) => total + row.count, 0);

const okQuestion = {
  topicOrder: 6,
  text: "Ikki va ikki nechaga teng?",
  options: [
    { text: "4", isCorrect: true },
    { text: "3", isCorrect: false },
    { text: "5", isCorrect: false },
    { text: "6", isCorrect: false },
  ],
  explanation: "2 + 2 = 4",
};

const validate = (over) =>
  ai._validate({ ...okQuestion, ...over }, {
    allowedOrders: new Set([5, 6, 7]),
    levelKey: "easy",
  });

// ═══════════════════════════════════════════════
// MAVZULARNI TAQSIMLASH
// ═══════════════════════════════════════════════

test("mavzular: so'ralgan son HAR DOIM to'liq taqsimlanadi", () => {
  for (const [topicCount, want] of [
    [120, 20],
    [3, 10],
    [1, 5],
    [10, 10],
    [7, 7],
    [40, 1],
  ]) {
    assert.equal(
      sum(spreadTopics(topics(topicCount), want)),
      want,
      `${topicCount} mavzu / ${want} savol`,
    );
  }
});

test("mavzular: BITTA savol so'ralsa eng OXIRGI mavzu olinadi", () => {
  const rows = spreadTopics(topics(120), 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].topic.order, 120);
});

test("mavzular: tanlov oraliqning IKKI CHEKKASINI ham qamraydi", () => {
  const rows = spreadTopics(topics(100), 20);
  assert.equal(rows[0].topic.order, 1);
  assert.equal(rows[rows.length - 1].topic.order, 100);
  const orders = rows.map((r) => r.topic.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), "tartib saqlanadi");
  assert.equal(new Set(orders).size, orders.length, "mavzu takrorlanmaydi");
});

test("mavzular: mavzu savoldan kam bo'lsa hammasi ishlatiladi", () => {
  const rows = spreadTopics(topics(3), 10);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.count), [3, 3, 4], "ortiqchasi oxirgilarga");
});

test("mavzular: bo'sh kirish bo'sh natija beradi", () => {
  assert.deepEqual(spreadTopics([], 10), []);
  assert.deepEqual(spreadTopics(topics(5), 0), []);
});

// ═══════════════════════════════════════════════
// SO'ROV PAKETLARI
// ═══════════════════════════════════════════════

test("paketlar: har daraja ALOHIDA so'rovda, savollar soni saqlanadi", () => {
  const batches = ai.planBatches({
    topics: topics(50),
    counts: { easy: 5, medium: 10, hard: 5 },
  });

  const total = batches.reduce((n, b) => n + sum(b.entries), 0);
  assert.equal(total, 20);

  for (const batch of batches) {
    assert.ok(sum(batch.entries) <= ai.QUESTIONS_PER_REQUEST, "savol chegarasi");
    assert.ok(batch.entries.length <= ai.TOPICS_PER_REQUEST, "mavzu chegarasi");
  }

  const levels = new Set(batches.map((b) => b.levelKey));
  assert.deepEqual([...levels].sort(), ["easy", "hard", "medium"]);
});

test("paketlar: nol so'ralgan daraja umuman so'rovga chiqmaydi", () => {
  const batches = ai.planBatches({
    topics: topics(10),
    counts: { easy: 0, medium: 4, hard: 0 },
  });
  assert.deepEqual([...new Set(batches.map((b) => b.levelKey))], ["medium"]);
  assert.equal(batches.reduce((n, b) => n + sum(b.entries), 0), 4);
});

test("paketlar: katta so'rov ham chekli sonda so'rovga bo'linadi", () => {
  const batches = ai.planBatches({
    topics: topics(120),
    counts: { easy: 34, medium: 33, hard: 33 },
  });
  assert.equal(batches.reduce((n, b) => n + sum(b.entries), 0), 100);
  assert.ok(batches.length <= ai.MAX_REQUESTS_PER_BUILD, `${batches.length} so'rov`);
});

// ═══════════════════════════════════════════════
// JAVOBNI TEKSHIRISH
// ═══════════════════════════════════════════════

test("javob: yaroqli savol qabul qilinadi va daraja muhrlanadi", () => {
  const result = validate({});
  assert.equal(result.ok, true);
  assert.equal(result.question.difficulty, "easy");
  assert.equal(result.question.type, "single");
  assert.equal(result.question.topicOrder, 6);
  assert.equal(result.question.options.length, 4);
});

test("javob: SO'RALMAGAN mavzudagi savol tashlanadi", () => {
  const result = validate({ topicOrder: 9 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "mavzu");
});

test("javob: mavzusiz javob ham tashlanadi", () => {
  assert.equal(validate({ topicOrder: null }).ok, false);
  assert.equal(validate({ topicOrder: "oltinchi" }).ok, false);
});

test("javob: to'g'ri variant YO'Q savol TUZATILMAYDI, tashlanadi", () => {
  const result = validate({
    options: okQuestion.options.map((o) => ({ ...o, isCorrect: false })),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "javob kaliti");
});

test("javob: ikki to'g'ri variant ham tashlanadi (`single` savol)", () => {
  const result = validate({
    options: okQuestion.options.map((o, i) => ({ ...o, isCorrect: i < 2 })),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "javob kaliti");
});

test("javob: variant soni to'g'ri kelmasa tashlanadi", () => {
  assert.equal(validate({ options: okQuestion.options.slice(0, 3) }).reason, "variant");
  assert.equal(
    validate({ options: [...okQuestion.options, { text: "7", isCorrect: false }] }).reason,
    "variant",
  );
});

test("javob: takroriy variant tashlanadi", () => {
  const result = validate({
    options: [
      { text: "4", isCorrect: true },
      { text: " 4 ", isCorrect: false },
      { text: "5", isCorrect: false },
      { text: "6", isCorrect: false },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "takror variant");
});

test("javob: juda qisqa matn tashlanadi", () => {
  assert.equal(validate({ text: "2+2?" }).reason, "matn");
  assert.equal(validate({ text: "   " }).reason, "matn");
});

test("javob: shaklsiz javob tashlanadi", () => {
  assert.equal(ai._validate(null, { allowedOrders: new Set([1]), levelKey: "easy" }).ok, false);
  assert.equal(ai._validate("savol", { allowedOrders: new Set([1]), levelKey: "easy" }).ok, false);
});

test("javob: VARIANTLAR ARALASHTIRILADI (to'g'ri javob birinchi qotib qolmaydi)", () => {
  const positions = new Set();
  for (let i = 0; i < 60; i += 1) {
    const result = validate({});
    positions.add(result.question.options.findIndex((o) => o.isCorrect));
  }
  assert.ok(positions.size > 1, "to'g'ri javob har doim bir joyda turmaydi");
  assert.deepEqual([...positions].sort(), [0, 1, 2, 3]);
});

test("javob: pozitsiyalar 0 dan ketma-ket beriladi", () => {
  const result = validate({});
  assert.deepEqual(result.question.options.map((o) => o.position), [0, 1, 2, 3]);
});

// ═══════════════════════════════════════════════
// TAQSIMOT BILAN BOG'LIQLIK
// ═══════════════════════════════════════════════

test("manba: AI qatori ham, bank qatori ham AYNI validatsiyadan o'tadi", () => {
  const rows = parseBlueprint([
    { subjectId: "x", source: "ai", topicMode: "current", easy: 3 },
    { subjectId: "y", source: "bank", topicMode: "range", topicFrom: 2, topicTo: 8, hard: 4 },
  ]);
  assert.equal(rows[0].source, "ai");
  assert.equal(rows[1].source, "bank");
  assert.throws(
    () => parseBlueprint([{ subjectId: "x", source: "sheet", topicMode: "current", easy: 1 }]),
    /noma'lum savol manbasi/,
  );
});
