const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * MAVZULAR REJASINI FAYLDAN O'QISH.
 *
 * Shu o'qish fanning mavzular ro'yxatini ALMASHTIRADI va dars jadvalidagi
 * sanoq (`LessonTopicBinding.topicOrder`) mavzu RAQAMIGA tayanadi — ya'ni bu
 * yerdagi har bir xato jadvalning butun mavzular ketma-ketligini surib
 * yuborishi mumkin.
 */

const {
  normalizeHeader,
  normalizeSubjectName,
  fieldOfHeader,
  columnLetter,
  parseTopicSheet,
} = require("../src/helpers/topicImport.helpers");

const HEADER = ["T/R", "Daraja", "Kitob", "Mavzu", "Nimalar o'rgatiladi"];

test("yangi shablon — hamma ustun nomi bo'yicha topiladi", () => {
  const result = parseTopicSheet([
    HEADER,
    [1, "Beginner", "New Headway Beginner", "Salomlashish", "am/are/is"],
    [2, "Beginner", "New Headway Beginner", "Sonlar", "1–10 sonlari"],
  ]);

  assert.equal(result.error, null);
  // T/R (A) o'qilmaydi va hisobotga ham kirmaydi
  assert.deepEqual(result.columns, { level: "B", book: "C", name: "D", description: "E" });
  assert.deepEqual(result.topics[0], {
    order: 1,
    name: "Salomlashish",
    level: "Beginner",
    book: "New Headway Beginner",
    description: "am/are/is",
  });
  assert.equal(result.topics.length, 2);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.notes, []);
});

test("eski shablon (Mavzu nomi, Tavsif) avvalgidek o'qiladi", () => {
  const result = parseTopicSheet([
    ["T/R", "Mavzu nomi", "Tavsif"],
    [1, "Kasrlar", "Oddiy kasrlar"],
  ]);

  assert.equal(result.error, null);
  assert.deepEqual(result.topics, [
    { order: 1, name: "Kasrlar", level: null, book: null, description: "Oddiy kasrlar" },
  ]);
  // Daraja va Kitob ustuni yo'qligi — ma'lumot, ogohlantirish EMAS
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.missingColumns, ["level", "book"]);
  assert.match(result.notes[0], /"Daraja", "Kitob" ustunlari faylda yo'q/);
  assert.match(result.notes[0], /ixtiyoriy/);
});

test("ixtiyoriy katak bo'sh — mavzu yuklanadi, null bo'ladi, xato emas", () => {
  const result = parseTopicSheet([
    HEADER,
    [1, "Beginner", "New Headway Beginner", "Salomlashish", "am/are/is"],
    [2, "Elementary", "", "Lug'at: Countries; Nationalities.", ""],
    [3, "", "", "Gapirish: Giving directions.", ""],
  ]);

  assert.equal(result.error, null);
  assert.equal(result.topics.length, 3);
  assert.deepEqual(result.topics[1], {
    order: 2,
    name: "Lug'at: Countries; Nationalities.",
    level: "Elementary",
    book: null,
    description: null,
  });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.emptyCounts, { level: 1, book: 2, description: 2 });
  assert.deepEqual(result.notes, [
    `"Daraja" 3 tadan 1 ta mavzuda bo'sh (ixtiyoriy — xato emas)`,
    `"Kitob" 3 tadan 2 ta mavzuda bo'sh (ixtiyoriy — xato emas)`,
    `"Nimalar o'rgatiladi" 3 tadan 2 ta mavzuda bo'sh (ixtiyoriy — xato emas)`,
  ]);
});

test("birinchi katagi bo'sh qator — ustunlar SURILMAYDI (eski xato)", () => {
  // Ilgari `sheet_to_json` bo'sh katakni tushirib qoldirardi va "2-ustun —
  // nom" qoidasi bilan bu qatorda nom o'rniga kitob yozilardi.
  const result = parseTopicSheet([
    HEADER,
    ["", "", "Gateway A2", "Present Simple", ""],
  ]);

  assert.equal(result.topics[0].name, "Present Simple");
  assert.equal(result.topics[0].book, "Gateway A2");
  assert.equal(result.topics[0].level, null);
});

test("sarlavha nomlari tartibi muhim emas", () => {
  const result = parseTopicSheet([
    ["Mavzu", "Kitob", "Daraja"],
    ["Fe'l", "6-sinf ona tili", "Morfologiya"],
  ]);

  assert.deepEqual(result.topics[0], {
    order: 1,
    name: "Fe'l",
    level: "Morfologiya",
    book: "6-sinf ona tili",
    description: null,
  });
  assert.deepEqual(result.missingColumns, ["description"]);
});

test("o'rtadagi nomsiz qator — raqamni egallaydi va sababi aytiladi", () => {
  const result = parseTopicSheet([
    HEADER,
    [1, "A1", "K", "Birinchi", ""],
    [2, "A1", "K", "", "mazmuni bor, nomi yo'q"],
    [3, "A1", "K", "Uchinchi", ""],
  ]);

  // Fayldagi T/R bilan platformadagi raqam ajralib ketmasin: 3-qator 3 bo'lib qoladi
  assert.deepEqual(
    result.topics.map((t) => [t.order, t.name]),
    [
      [1, "Birinchi"],
      [3, "Uchinchi"],
    ],
  );
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^3-qator: mavzu nomi bo'sh — yuklanmadi \(2-raqamli mavzu bo'sh qoladi/);
});

test("oxiridagi oldindan raqamlangan bo'sh qatorlar jim tashlanadi", () => {
  const result = parseTopicSheet([
    HEADER,
    [1, "A1", "K", "Birinchi", ""],
    [2, "", "", "", ""],
    [3, "", "", "", ""],
    ["", "", "", "", ""],
  ]);

  assert.equal(result.topics.length, 1);
  assert.deepEqual(result.warnings, []);
});

test("oxirida nomsiz, lekin mazmuni bor qator — ogohlantiriladi", () => {
  const result = parseTopicSheet([
    HEADER,
    [1, "A1", "K", "Birinchi", ""],
    [2, "A1", "K", "", "Nimadir"],
  ]);

  assert.equal(result.topics.length, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^3-qator:/);
});

test("T/R ustuni hech narsaga ta'sir qilmaydi — usiz yuklash bilan AYNI natija", () => {
  const withSerial = parseTopicSheet([
    HEADER,
    [1, "A1", "K", "Birinchi", "m1"],
    [2, "", "", "", ""], // faqat T/R — bo'sh qator
    [7, "A1", "", "Ikkinchi", ""], // T/R noto'g'ri — baribir 2-mavzu
    [7, "A2", "K2", "", "nomsiz"],
    [9, "A2", "K2", "Uchinchi", ""],
    [10, "", "", "", ""],
  ]);
  const withoutSerial = parseTopicSheet([
    HEADER.slice(1),
    ["A1", "K", "Birinchi", "m1"],
    ["", "", "", ""],
    ["A1", "", "Ikkinchi", ""],
    ["A2", "K2", "", "nomsiz"],
    ["A2", "K2", "Uchinchi", ""],
    ["", "", "", ""],
  ]);

  assert.deepEqual(withSerial.topics, withoutSerial.topics);
  assert.deepEqual(withSerial.notes, withoutSerial.notes);
  assert.deepEqual(withSerial.warnings, withoutSerial.warnings);
  assert.deepEqual(
    withSerial.topics.map((t) => [t.order, t.name]),
    [
      [1, "Birinchi"],
      [2, "Ikkinchi"],
      [4, "Uchinchi"],
    ],
  );
});

test("takror T/R ustuni ogohlantirish bermaydi (u o'qilmaydi)", () => {
  const result = parseTopicSheet([
    ["T/R", "Mavzu", "№"],
    [1, "Fe'l", 1],
  ]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.columns, { name: "B" });
});

test("bo'sh qatorlar raqam olmaydi", () => {
  const result = parseTopicSheet([
    HEADER,
    ["", "", "", "", ""],
    [1, "", "", "Birinchi", ""],
    [],
    [2, "", "", "Ikkinchi", ""],
  ]);

  assert.deepEqual(
    result.topics.map((t) => t.order),
    [1, 2],
  );
});

test("sarlavha ustida nom qatori bo'lsa — haqiqiy sarlavha topiladi", () => {
  const result = parseTopicSheet([
    ["Ingliz tili mavzulari rejasi"],
    [],
    HEADER,
    [1, "Beginner", "NHB", "Salomlashish", ""],
  ]);

  assert.equal(result.error, null);
  assert.equal(result.columns.name, "D");
  assert.deepEqual(
    result.topics.map((t) => t.name),
    ["Salomlashish"],
  );
});

test("\"Mavzu\" ustuni yo'q — varaq yuklanmaydi va sababi aniq", () => {
  const result = parseTopicSheet([
    ["T/R", "Daraja", "Kitob"],
    [1, "A1", "K"],
  ]);

  assert.match(result.error, /^"Mavzu" ustuni topilmadi/);
  assert.match(result.error, /: Daraja, Kitob, Mavzu, Nimalar o'rgatiladi\./);
  // T/R platforma uchun yo'q — xabarda ham tilga olinmaydi
  assert.doesNotMatch(result.error, /T\/R/);
  assert.match(result.error, /"Mavzu" majburiy, qolganlari ixtiyoriy/);
  assert.deepEqual(result.topics, []);
});

test("\"Mavzu\" ustuni bor-u, hammasi bo'sh — sababi bilan", () => {
  const result = parseTopicSheet([HEADER, [1, "A1", "K", "", ""]]);
  assert.equal(result.error, `"Mavzu" ustuni (D) bo'sh — birorta mavzu nomi yo'q`);
});

test("bo'sh varaq", () => {
  assert.equal(parseTopicSheet([]).error, "Varaq bo'sh");
  assert.equal(parseTopicSheet([["", ""], []]).error, "Varaq bo'sh");
});

test("takror ustun — birinchisi olinadi va bu aytiladi", () => {
  const result = parseTopicSheet([
    ["Mavzu", "Kitob", "Kitob"],
    ["Fe'l", "Birinchi kitob", "Ikkinchi kitob"],
  ]);

  assert.equal(result.topics[0].book, "Birinchi kitob");
  assert.match(result.warnings[0], /"Kitob" ustuni ikki marta uchradi — B ustuni olindi, C e'tiborsiz qoldirildi/);
});

test("qator va ustun raqami varaq diapazonidan hisoblanadi", () => {
  // Varaq B3 dan boshlansa (sheet_to_json shu yerdan qaytaradi)
  const result = parseTopicSheet(
    [
      ["Mavzu", "Kitob"],
      ["", "Faqat kitob"],
      ["Fe'l", ""],
    ],
    { rowOffset: 2, colOffset: 1 },
  );

  assert.deepEqual(result.columns, { name: "B", book: "C" });
  assert.match(result.warnings[0], /^4-qator:/);
});

test("sarlavhani tanish — chalkash nomlar", () => {
  // T/R va uning variantlari taniladi, lekin o'qilmaydi (`serial`)
  assert.equal(fieldOfHeader("T/R"), "serial");
  assert.equal(fieldOfHeader("Mavzu raqami"), "serial");
  assert.equal(fieldOfHeader("№"), "serial");
  assert.equal(fieldOfHeader("Mavzu tavsifi"), "description");
  assert.equal(fieldOfHeader("Kitob nomi"), "book");
  assert.equal(fieldOfHeader("Mavzu darajasi"), "level");
  assert.equal(fieldOfHeader("Nimalar oʻrgatiladi"), "description");
  assert.equal(fieldOfHeader("Mavzu nomi"), "name");
  assert.equal(fieldOfHeader("Mavzu*"), "name");
  assert.equal(fieldOfHeader("Nomi"), "name");
  assert.equal(fieldOfHeader("Soat"), null);
});

test("normalizeHeader / normalizeSubjectName / columnLetter", () => {
  assert.equal(normalizeHeader("  Nimalar  Oʻrgatiladi: "), "nimalar orgatiladi");
  assert.equal(normalizeSubjectName("Oʻzbek  tili "), normalizeSubjectName("o'zbek tili"));
  assert.equal(columnLetter(0), "A");
  assert.equal(columnLetter(25), "Z");
  assert.equal(columnLetter(26), "AA");
});
