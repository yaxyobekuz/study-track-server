/**
 * WORD (.docx) QURUVCHI — paket tuzilishi va XML xavfsizligi.
 *
 * `.docx` — ZIP ichidagi XML lar to'plami. Bitta qism tushib qolsa yoki
 * XML da ekranlanmagan belgi bo'lsa, Word faylni "shikastlangan" deb
 * ochmaydi — va buni faqat foydalanuvchi, o'z kompyuterida ko'radi.
 * Shuning uchun paket shakli va ekranlash SHU YERDA qo'riqlanadi.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const JSZip = require("jszip");

const { buildDocx } = require("../src/services/word.service");

const openDocx = async (buffer) => {
  const zip = await JSZip.loadAsync(buffer);
  return {
    zip,
    names: Object.keys(zip.files).filter((name) => !zip.files[name].dir),
    read: (name) => zip.file(name).async("string"),
  };
};

test("paket Word kutadigan QISMLARNING hammasini saqlaydi", async () => {
  const buffer = await buildDocx({
    title: "Sinov",
    blocks: [{ type: "paragraph", text: "Salom" }],
  });

  const { names } = await openDocx(buffer);

  for (const part of [
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
    "word/styles.xml",
    "word/_rels/document.xml.rels",
    "docProps/core.xml",
    "docProps/app.xml",
  ]) {
    assert.ok(names.includes(part), `${part} yo'q`);
  }

  // ⚠️ `[Content_Types].xml` paketning BIRINCHI yozuvi bo'lishi kerak.
  assert.equal(names[0], "[Content_Types].xml");
});

test("XML ekranlash: `&`, `<`, tirnoq va BOSHQARUV belgisi", async () => {
  const buffer = await buildDocx({
    // Sarlavha `docProps/core.xml` ga ham tushadi — u ham ekranlanishi shart
    title: 'A & B <test>',
    blocks: [
      { type: "paragraph", text: 'Ona tili & adabiyot <5-A> "yillik"' },
      // PostgreSQL va XML qabul qilmaydigan belgi (qurilma matnlaridan kelishi mumkin)
      { type: "paragraph", text: "yomon\u0000belgi" },
    ],
  });

  const { read } = await openDocx(buffer);
  const xml = await read("word/document.xml");

  assert.ok(xml.includes("Ona tili &amp; adabiyot &lt;5-A&gt;"), "ekranlanmagan");
  assert.ok(!xml.includes("\u0000"), "boshqaruv belgisi olib tashlanishi kerak");
  assert.ok(xml.includes("yomonbelgi"));

  const core = await read("docProps/core.xml");
  assert.ok(core.includes("A &amp; B &lt;test&gt;"));
});

test("yangi qator `<w:br/>` ga aylanadi — fayl bitta uzun qator bo'lib qolmasin", async () => {
  const buffer = await buildDocx({
    blocks: [{ type: "paragraph", text: "birinchi\nikkinchi" }],
  });

  const xml = await (await openDocx(buffer)).read("word/document.xml");
  assert.equal((xml.match(/<w:br\/>/g) || []).length, 1);
});

test("jadval: sarlavha QAYTA chiziladi va ustun kengliklari sahifaga teng", async () => {
  const buffer = await buildDocx({
    blocks: [
      {
        type: "table",
        columns: [
          { label: "Nomi", width: 3 },
          { label: "Soni", width: 1, align: "right" },
        ],
        rows: [["Birinchi", { text: "12", bold: true }]],
      },
    ],
  });

  const xml = await (await openDocx(buffer)).read("word/document.xml");

  assert.ok(xml.includes("<w:tblHeader/>"), "uzun jadvalning 2-sahifasi nomsiz qolardi");

  // Yig'indi AYNAN matn kengligiga teng bo'lishi kerak (A4 − 2×20 mm)
  const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
  assert.equal(widths.length, 2);
  assert.equal(widths.reduce((a, b) => a + b, 0), 11906 - 1134 * 2);
});

test("sahifa uzilishi — ALOHIDA paragraf emas, `pageBreakBefore`", async () => {
  const buffer = await buildDocx({
    blocks: [
      { type: "paragraph", text: "birinchi sahifa" },
      { type: "heading", level: 2, text: "ikkinchi sahifa", pageBreakBefore: true },
    ],
  });

  const xml = await (await openDocx(buffer)).read("word/document.xml");

  assert.ok(xml.includes("<w:pageBreakBefore/>"));
  // Alohida "break" paragrafi o'rtada BO'SH sahifa qoldirardi
  assert.ok(!xml.includes('<w:br w:type="page"/>'));
});
