const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * SERTIFIKAT IMPORTI — USTUNLARNI ANIQLASH VA MOSLASHTIRISH.
 *
 * Qabul mezonlari:
 *   - Google Forms sarlavhalari (imlo xatosi va yopilmagan qavs bilan)
 *     to'g'ri tanib olinadi
 *   - MUDDAT ustuni SERTIFIKAT ustuni deb o'qilmaydi (sarlavhada ikkala
 *     so'z ham bor)
 *   - yo'nalish va muddat JADVALDAGI TARTIB bo'yicha juftlanadi
 *   - bitta qatorda bir yo'nalish ikki marta bo'lsa — BELGILANADI
 *   - o'quvchi guruh ichida qat'iy teng nom bilan AVTOMAT ulanadi, imlo
 *     xatosi esa faqat TAKLIF bo'lib chiqadi
 */

process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db?schema=public";

const {
  MATCH,
  RESOLVED_STATUSES,
  detectColumns,
  parseImportFile,
  matchRow,
} = require("../src/services/certificateImport.service");

/* ─────────────────────── USTUNLAR ─────────────────────── */

// Haqiqiy fayldagi sarlavhalar (normallashtirilgan ko'rinishda)
const FORM_HEADERS = [
  "timestamp",
  "ism_familiya",
  "guruh",
  "topshirmoqchi_bolgan_sertifikatingiz_1_fan",
  "sertifikatga_topshiriladigan_muddat_1_fan",
  "topshirmoqchi_bolgan_sertifikatingiz_2_(agar_bor_bolsa)",
  "sertifikatga_topshiriladigan_muddat_2_fan_(agar_bor_bolsa",
  "qoshimcha_fikr",
];

test("Google Forms sarlavhalari — barcha ustun topiladi", () => {
  const columns = detectColumns(FORM_HEADERS);

  assert.equal(columns.timestamp, "timestamp");
  assert.equal(columns.name, "ism_familiya");
  assert.equal(columns.group, "guruh");
  assert.equal(columns.note, "qoshimcha_fikr");
  assert.equal(columns.tracks.length, 2);
  assert.equal(columns.dues.length, 2);
});

test("MUDDAT ustuni yo'nalish deb o'qilmaydi", () => {
  // "Sertifikatga topshiriladigan muddat 1-fan" ichida "sertifikat" ham,
  // "fan" ham bor — tekshiruv tartibi almashsa u yo'nalish bo'lib qolardi
  const columns = detectColumns(FORM_HEADERS);

  assert.ok(columns.tracks.every((key) => !key.includes("muddat")));
  assert.ok(columns.dues.every((key) => key.includes("muddat")));
});

test("oddiy shablon — bitta yo'nalish, bitta muddat", () => {
  const columns = detectColumns(["ism_familiya", "sinf", "yonalish", "muddat", "izoh"]);

  assert.equal(columns.name, "ism_familiya");
  assert.equal(columns.group, "sinf");
  assert.deepEqual(columns.tracks, ["yonalish"]);
  assert.deepEqual(columns.dues, ["muddat"]);
  assert.equal(columns.note, "izoh");
});

/* ─────────────────────── FAYLNI O'QISH ─────────────────────── */

const csv = (text) => ({
  originalname: "test.csv",
  buffer: Buffer.from(text, "utf8"),
});

const FORM_CSV = [
  "Timestamp,Ism familiya,Guruh,Topshirmoqchi bolgan sertifikatingiz 1-fan,Sertifikatga topshiriladigan muddat 1-fan,Topshirmoqchi bolgan sertifikatingiz 2 (agar bor bo'lsa),Sertifikatga topshiriladigan muddat 2-fan (agar bor bolsa,Qoshimcha fikr",
  '9/29/2026 10:24:24,Ummatillayev Halililloh,IT 1,Ona tili,"Dec 1, 2026",Matematika,"Mar 1, 2027",Aniq sanani bilmiman',
  "9/29/2026 10:25:17,Shamsiddinov Abdulboriy,IT 1,,,,,",
  '9/29/2026 10:26:32,Hasanov Hikmatillo,IT 1,Ona tili,"May 20, 2026",Ona tili,"May 20, 2026",',
  "9/29/2026 10:26:11,Ibrohimov Behruzbek,IT 1,Ona tili,,Matematika,,aniq sanasini bilmiman",
].join("\n");

test("qatorlar o'qiladi — yo'nalish va muddat TARTIB bo'yicha juftlanadi", () => {
  const { rows, warnings } = parseImportFile(csv(FORM_CSV));

  assert.equal(rows.length, 4);
  assert.equal(warnings.length, 0);

  const [first] = rows;
  assert.equal(first.rowNumber, 2); // sarlavha 1-qator
  assert.equal(first.sourceName, "Ummatillayev Halililloh");
  assert.equal(first.sourceGroup, "IT 1");
  assert.equal(first.note, "Aniq sanani bilmiman");
  assert.equal(first.submittedAt.toISOString(), "2026-09-29T05:24:24.000Z");

  assert.equal(first.entries.length, 2);
  assert.equal(first.entries[0].trackName, "Ona tili");
  assert.equal(first.entries[0].dueDate.toISOString().slice(0, 10), "2026-12-01");
  assert.equal(first.entries[1].trackName, "Matematika");
  assert.equal(first.entries[1].dueDate.toISOString().slice(0, 10), "2027-03-01");
});

test("sertifikat ko'rsatilmagan qator — bo'sh, lekin TASHLANMAYDI", () => {
  const { rows } = parseImportFile(csv(FORM_CSV));
  const empty = rows.find((row) => row.sourceName === "Shamsiddinov Abdulboriy");

  // Qator o'qiladi (hisobotda ko'rinadi), lekin reja yozilmaydi
  assert.equal(empty.entries.length, 0);
});

test("BITTA QATORDA BIR YO'NALISH IKKI MARTA — belgilanadi", () => {
  const { rows } = parseImportFile(csv(FORM_CSV));
  const row = rows.find((r) => r.sourceName === "Hasanov Hikmatillo");

  assert.equal(row.entries.length, 2);
  assert.equal(row.entries[0].duplicateInRow, false);
  // Ikkinchisi — bitta sertifikatga ikkinchi muddat, ma'nosiz
  assert.equal(row.entries[1].duplicateInRow, true);
});

test("muddatsiz reja — xato EMAS", () => {
  const { rows } = parseImportFile(csv(FORM_CSV));
  const row = rows.find((r) => r.sourceName === "Ibrohimov Behruzbek");

  assert.equal(row.entries.length, 2);
  assert.equal(row.entries[0].dueDate, null);
  assert.equal(row.entries[0].dueUnreadable, false);
});

test("o'qib bo'lmagan muddat JIM QOLDIRILMAYDI", () => {
  const { rows } = parseImportFile(
    csv(["Ism familiya,Guruh,Yonalish,Muddat", "Valiyev Ali,IT 1,IELTS,keyinroq"].join("\n")),
  );

  assert.equal(rows[0].entries[0].dueDate, null);
  assert.equal(rows[0].entries[0].dueUnreadable, true);
});

test("ism ustuni yo'q — import BOSHLANMAYDI", () => {
  assert.throws(
    () => parseImportFile(csv(["Guruh,Yonalish,Muddat", "IT 1,IELTS,2026-12-01"].join("\n"))),
    /Ism-familiya ustuni topilmadi/,
  );
});

test("yo'nalish ustuni yo'q — import BOSHLANMAYDI", () => {
  assert.throws(
    () => parseImportFile(csv(["Ism familiya,Guruh", "Valiyev Ali,IT 1"].join("\n"))),
    /yo'nalishi ustuni topilmadi/,
  );
});

test("guruh va muddat ustunlari yo'q — OGOHLANTIRISH, xato emas", () => {
  const { rows, warnings } = parseImportFile(
    csv(["Ism familiya,Yonalish", "Valiyev Ali,IELTS"].join("\n")),
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].entries[0].dueDate, null);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => /Guruh ustuni/.test(w)));
  assert.ok(warnings.some((w) => /Muddat ustuni/.test(w)));
});

test("bo'sh fayl rad etiladi", () => {
  assert.throws(() => parseImportFile(csv("Ism familiya,Yonalish")), /ma'lumot topilmadi/);
});

/* ─────────────────────── MOSLASHTIRISH ─────────────────────── */

const student = (id, fullName, classId, className) => ({
  id,
  fullName,
  username: id,
  classIds: classId ? [classId] : [],
  classNames: className ? [className] : [],
});

function buildContext(students, { classes = [], learned = new Map() } = {}) {
  const byClass = new Map();
  for (const item of students) {
    for (const classId of item.classIds) {
      if (!byClass.has(classId)) byClass.set(classId, []);
      byClass.get(classId).push(item);
    }
  }
  return {
    students,
    byClass,
    classByName: new Map(classes.map((cls) => [cls.key, cls])),
    learned,
  };
}

const IT1 = { key: "it 1", id: "c1", name: "IT 1" };
const IT2 = { key: "it 2", id: "c2", name: "IT 2" };

const POOL = [
  student("s1", "Ummatillayev Halililloh", "c1", "IT 1"),
  student("s2", "Abdumalikov Suhrobbek", "c1", "IT 1"),
  student("s3", "Qambarov Abdulaziz", "c2", "IT 2"),
];

test("guruh ichida QAT'IY TENG nom — AVTOMAT", () => {
  const context = buildContext(POOL, { classes: [IT1, IT2] });
  const match = matchRow({ sourceName: "Ummatillayev Halililloh", sourceGroup: "IT 1" }, context);

  assert.equal(match.status, MATCH.AUTO);
  assert.equal(match.student.id, "s1");
  assert.equal(match.className, "IT 1");
  assert.ok(RESOLVED_STATUSES.has(match.status));
});

test("so'z tartibi almashgan nom ham AVTOMAT", () => {
  const context = buildContext(POOL, { classes: [IT1, IT2] });
  const match = matchRow({ sourceName: "Halililloh Ummatillayev", sourceGroup: "IT 1" }, context);

  assert.equal(match.status, MATCH.AUTO);
  assert.equal(match.student.id, "s1");
});

test("IMLO XATOSI — AVTOMAT EMAS, faqat TAKLIF", () => {
  const context = buildContext(POOL, { classes: [IT1, IT2] });
  const match = matchRow({ sourceName: "Abdumalikov Suhrobbrk", sourceGroup: "IT 1" }, context);

  assert.equal(match.status, MATCH.SUGGESTED);
  assert.equal(match.student, null);
  assert.equal(match.candidates[0].id, "s2");
  assert.ok(match.candidates[0].score > 90);
  assert.ok(!RESOLVED_STATUSES.has(match.status));
});

test("guruh XATO yozilgan — maktab bo'yicha topiladi va BELGILANADI", () => {
  const context = buildContext(POOL, { classes: [IT1, IT2] });
  const match = matchRow({ sourceName: "Qambarov Abdulaziz", sourceGroup: "IT 1" }, context);

  assert.equal(match.status, MATCH.AUTO_SCHOOL);
  assert.equal(match.student.id, "s3");
  // Guruh IT 1 deb topilgan, lekin o'quvchi IT 2 da — admin ko'rib turadi
  assert.equal(match.className, "IT 1");
  assert.equal(match.groupMatched, true);
});

test("sinf topilmasa — maktab bo'yicha, `groupMatched: false`", () => {
  const context = buildContext(POOL, { classes: [IT1, IT2] });
  const match = matchRow({ sourceName: "Qambarov Abdulaziz", sourceGroup: "XTM 9" }, context);

  assert.equal(match.status, MATCH.AUTO_SCHOOL);
  assert.equal(match.groupMatched, false);
  assert.equal(match.className, null);
});

test("bir xil nomli IKKI o'quvchi — AMBIGUOUS, jim tanlov YO'Q", () => {
  const twins = [
    student("t1", "Valiyev Ali", "c1", "IT 1"),
    student("t2", "Valiyev Ali", "c1", "IT 1"),
  ];
  const context = buildContext(twins, { classes: [IT1] });
  const match = matchRow({ sourceName: "Valiyev Ali", sourceGroup: "IT 1" }, context);

  assert.equal(match.status, MATCH.AMBIGUOUS);
  assert.equal(match.student, null);
  assert.equal(match.candidates.length, 2);
});

test("XOTIRA — avval tasdiqlangan xom ism qayta so'ralmaydi", () => {
  const context = buildContext(POOL, {
    classes: [IT1, IT2],
    learned: new Map([["abdumalikov suhrobbrk", "s2"]]),
  });
  const match = matchRow({ sourceName: "Abdumalikov Suhrobbrk", sourceGroup: "IT 1" }, context);

  assert.equal(match.status, MATCH.LEARNED);
  assert.equal(match.student.id, "s2");
  assert.ok(RESOLVED_STATUSES.has(match.status));
});

test("BEGONA ism — topilmadi", () => {
  const context = buildContext(POOL, { classes: [IT1, IT2] });
  const match = matchRow({ sourceName: "Zafarov Jasurbek", sourceGroup: "IT 1" }, context);

  assert.equal(match.status, MATCH.NONE);
  assert.equal(match.student, null);
  assert.equal(match.candidates.length, 0);
});

test("ism bo'sh — topilmadi", () => {
  const context = buildContext(POOL, { classes: [IT1, IT2] });
  const match = matchRow({ sourceName: "", sourceGroup: "IT 1" }, context);

  assert.equal(match.status, MATCH.NONE);
});
