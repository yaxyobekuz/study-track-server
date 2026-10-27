/**
 * ERP VA KUNDALIK.COM HISOBOTI — sanoq va foiz arifmetikasi.
 *
 * Hisobotning butun ishonchi ikki tenglikka tayanadi:
 *
 *   bor + yo'q = jami
 *   kamida bittasida yo'q = jami − ikkalasida ham bor
 *
 * Ikkinchisi ko'zga tashlanmaydigan joy: "ERP da yo'q" va "Kundalik da
 * yo'q" sonlarini QO'SHIB yuborish oson, holbuki ikkala tizimga ham
 * kiritilmagan bola u paytda IKKI MARTA sanalardi.
 *
 * Tarmoq (umumiy ko'rinish) tomonida esa foiz filiallar foizining
 * o'rtachasi EMAS — u yig'indidan qayta hisoblanadi, aks holda 12
 * o'quvchili filial 344 o'quvchili filial bilan teng hissa qo'shardi.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  percentOf,
  buildTotals,
  combineTotals,
  buildClassBreakdown,
} = require("../src/services/studentSystemReport.service");

/** `loadExportData` qatori — hisobotga kerakli qismi. */
const row = (id, { erp = false, kundalik = false, name = id } = {}) => ({
  id,
  name,
  classNames: "—",
  erp,
  kundalik,
});

test("foiz: maxraj nol bo'lsa null (nol emas)", () => {
  assert.equal(percentOf(0, 0), null);
  assert.equal(percentOf(0, 10), 0);
  assert.equal(percentOf(1, 3), 33.3);
});

test("bor + yo'q = jami, har tizim uchun alohida", () => {
  const totals = buildTotals([
    row("a", { erp: true, kundalik: true }),
    row("b", { erp: true }),
    row("c", { kundalik: true }),
    row("d"),
  ]);

  assert.equal(totals.students, 4);
  assert.equal(totals.systems.erp.yes, 2);
  assert.equal(totals.systems.erp.no, 2);
  assert.equal(totals.systems.kundalik.yes, 2);
  assert.equal(totals.systems.kundalik.no, 2);
});

test("kiritilmagan = jami − ikkalasida ham bor (ikki marta sanalmaydi)", () => {
  const totals = buildTotals([
    row("a", { erp: true, kundalik: true }),
    row("b", { erp: true }),
    row("c", { kundalik: true }),
    row("d"),
  ]);

  assert.equal(totals.inBoth, 1);
  // b, c, d — uchtasi: "d" ikkala ro'yxatda bo'lsa ham BIR MARTA
  assert.equal(totals.missingAny, 3);
  assert.equal(totals.missingBoth, 1);
  assert.equal(totals.inBoth + totals.missingAny, totals.students);
});

test("bo'sh qamrov: foiz null, sanoq nol", () => {
  const totals = buildTotals([]);

  assert.equal(totals.students, 0);
  assert.equal(totals.systems.erp.percent, null);
  assert.equal(totals.inBothPercent, null);
  assert.equal(totals.missingAny, 0);
});

test("tarmoq foizi — YIG'INDIDAN, filiallar o'rtachasi EMAS", () => {
  // Katta filial: 100 dan 100 tasi ERP da. Kichik filial: 1 dan 0 tasi.
  const big = buildTotals(
    Array.from({ length: 100 }, (unused, i) =>
      row(`b${i}`, { erp: true, kundalik: true }),
    ),
  );
  const small = buildTotals([row("s1")]);

  const network = combineTotals([big, small]);

  assert.equal(network.students, 101);
  assert.equal(network.systems.erp.yes, 100);
  assert.equal(network.systems.erp.no, 1);
  // O'rtacha bo'lsa (100% + 0%) ÷ 2 = 50% bo'lardi
  assert.equal(network.systems.erp.percent, 99);
  assert.equal(network.inBoth, 100);
  assert.equal(network.missingAny, 1);
  assert.equal(network.missingBoth, 1);
});

test("sinfsizlar ENG OXIRIDA — tarmoq ro'yxatida ham AYNI tartib", () => {
  // Nomi bo'yicha "Sinfsiz" alifboda o'rtaga tushardi — maxsus qoida
  // busiz jim yo'qolardi (tarmoq ro'yxatida aynan shunday bo'lgan).
  const rows = [row("a"), row("b"), row("c")];
  const students = [
    { id: "a", classes: [{ id: "c1", name: "A guruh" }] },
    { id: "b", classes: [] },
    { id: "c", classes: [{ id: "c2", name: "Z guruh" }] },
  ];

  const names = buildClassBreakdown(rows, students).map((item) => item.name);

  assert.equal(names.at(-1), "Sinfsiz");
  assert.deepEqual(names, ["A guruh", "Z guruh", "Sinfsiz"]);
});

test("sinflar kesimi: ikki sinfdagi o'quvchi ikkala qatorda sanaladi", () => {
  const rows = [
    row("a", { erp: true }),
    row("b"),
  ];
  const students = [
    { id: "a", classes: [{ id: "c1", name: "5-A" }, { id: "c2", name: "10-A" }] },
    { id: "b", classes: [] },
  ];

  const byClass = buildClassBreakdown(rows, students);

  // Tabiiy tartib: 5-A → 10-A ("10" matn tartibida "5" dan oldin kelardi),
  // sinfsizlar esa ENG OXIRIDA
  assert.deepEqual(
    byClass.map((item) => item.name),
    ["5-A", "10-A", "Sinfsiz"],
  );

  assert.equal(byClass[0].students, 1);
  assert.equal(byClass[0].systems.erp.yes, 1);
  assert.equal(byClass[1].students, 1);
  assert.equal(byClass[2].systems.erp.no, 1);

  // Sinflar yig'indisi (3) JAMIdan (2) katta — takror ataylab
  const sum = byClass.reduce((acc, item) => acc + item.students, 0);
  assert.equal(sum, 3);
  assert.equal(buildTotals(rows).students, 2);
});
