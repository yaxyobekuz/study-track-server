const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * MAVZULAR REJASINI FAYLGA YOZISH.
 *
 * ⚠️ Bu yerdagi testlarning MOHIYATI — ROUND-TRIP: yuklab olingan fayl
 * hech narsa o'zgartirmasdan qayta yuklanganda AYNAN o'sha mavzular AYNI
 * raqamlar bilan qaytishi kerak. Platformada mavzuni tahrirlash yo'li yo'q
 * (ro'yxat faqat fayl bilan almashtiriladi), ya'ni yuklab olish —
 * tahrirlashning birinchi qadami. Raqam esa jadvaldagi ankorning kaliti
 * (`LessonTopicBinding.topicOrder`): bitta surilish butun sinfning
 * mavzular ketma-ketligini buzadi.
 */

const {
  EMPTY_SLOT_NOTE,
  EXPORT_COLUMNS,
  sheetNameOf,
  uniqueSheetName,
  buildTopicRows,
  toSheetMatrix,
} = require("../src/helpers/topicExport.helpers");
const { parseTopicSheet } = require("../src/helpers/topicImport.helpers");

/** Eksport natijasini import orqali qaytarib o'qiydi. */
const roundTrip = (topics) => parseTopicSheet(toSheetMatrix(buildTopicRows(topics)));

const TOPICS = [
  { order: 1, level: "Leksikologiya", book: "5-sinf ona tili", name: "So'z va uning ma'nosi", description: "So'zning leksik ma'nosi" },
  { order: 2, level: "Leksikologiya", book: "Tilshunoslik qo'llanma", name: "Omonimlar va paronimlar", description: null },
  { order: 3, level: null, book: null, name: "Frazeologiya", description: "Barqaror birikmalar" },
];

test("ustunlar import shabloni bilan AYNI va sarlavha BIRINCHI qatorda", () => {
  const matrix = toSheetMatrix(buildTopicRows(TOPICS));

  assert.deepEqual(matrix[0], ["№", "Daraja", "Kitob", "Mavzu", "Nimalar o'rgatiladi"]);

  // Sarlavha aynan 1-qatorda topildi (keyingi qator — birinchi mavzu)
  const result = parseTopicSheet(matrix);
  assert.equal(result.error, null);
  assert.deepEqual(result.columns, { level: "B", book: "C", name: "D", description: "E" });
});

test("round-trip — mavzular, raqamlar va ixtiyoriy maydonlar AYNAN qaytadi", () => {
  const result = roundTrip(TOPICS);

  assert.equal(result.error, null);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.topics,
    TOPICS.map((topic) => ({
      order: topic.order,
      name: topic.name,
      level: topic.level || null,
      book: topic.book || null,
      description: topic.description || null,
    })),
  );
});

test("BO'SH RAQAM saqlanadi — keyingi mavzular SURILMAYDI", () => {
  // 3-raqam bazada yo'q (yuklashda nomi bo'sh qolgan qator raqamni egallagan)
  const gapped = [
    { order: 1, name: "Birinchi", level: null, book: null, description: null },
    { order: 2, name: "Ikkinchi", level: null, book: null, description: null },
    { order: 4, name: "To'rtinchi", level: null, book: null, description: null },
  ];

  const rows = buildTopicRows(gapped);
  assert.equal(rows.length, 4);
  assert.equal(rows[2].isEmptySlot, true);
  assert.equal(rows[2].description, EMPTY_SLOT_NOTE);

  const result = roundTrip(gapped);
  assert.deepEqual(
    result.topics.map((topic) => [topic.order, topic.name]),
    [
      [1, "Birinchi"],
      [2, "Ikkinchi"],
      [4, "To'rtinchi"],
    ],
  );
  // Bo'sh raqam jim qolmaydi — qayta yuklashda ham aytiladi
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /mavzu nomi bo'sh/);
});

test("ixtiyoriy ustunlar butun fanda bo'sh bo'lsa ham shablonda qoladi", () => {
  const plain = [{ order: 1, name: "Yagona mavzu", level: null, book: null, description: null }];
  const result = roundTrip(plain);

  assert.equal(result.error, null);
  assert.deepEqual(result.missingColumns, []); // ustunlar bor, faqat bo'sh
  assert.deepEqual(result.topics, [
    { order: 1, name: "Yagona mavzu", level: null, book: null, description: null },
  ]);
});

test("mavzu yo'q bo'lsa qator ham yo'q", () => {
  assert.deepEqual(buildTopicRows([]), []);
  assert.equal(toSheetMatrix([]).length, 1); // faqat sarlavha
});

test("№ ustuni import uchun MA'LUMOT emas — u bo'lmasa ham natija AYNI", () => {
  const withSerial = toSheetMatrix(buildTopicRows(TOPICS));
  const withoutSerial = withSerial.map((row) => row.slice(1));

  assert.deepEqual(parseTopicSheet(withoutSerial).topics, parseTopicSheet(withSerial).topics);
});

test("varaq nomi — fan nomi, taqiqlangan belgilar va 31 belgi chegarasi bilan", () => {
  assert.equal(sheetNameOf("Ona Tili"), "Ona Tili");
  assert.equal(sheetNameOf("Matematika / Algebra"), "Matematika Algebra");
  assert.equal(sheetNameOf(""), "Fan");
  assert.equal(sheetNameOf("a".repeat(40)).length, 31);
});

test("takrorlangan varaq nomi fayl yaratilishini yiqitmaydi", () => {
  const used = new Set();
  assert.equal(uniqueSheetName(used, "Ona tili"), "Ona tili");
  assert.equal(uniqueSheetName(used, "Ona tili"), "Ona tili (2)");
  assert.equal(uniqueSheetName(used, "Ona tili"), "Ona tili (3)");
});

test("ustunlar ro'yxati o'zgarmas (nusxa olib tahrirlanmasin)", () => {
  assert.equal(Object.isFrozen(EXPORT_COLUMNS), true);
});
