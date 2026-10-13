const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * SINFLAR SIG'IMI — ta'lim dashboardidagi "Sinflar sig'imi" kartasining
 * manbasi (`academicDashboard.service.js` → `buildCapacity`).
 *
 * Himoya qilinadigan narsa:
 *   · bo'sh joy = sig'im − o'quvchi va u MANFIY bo'lishi mumkin
 *     (sig'imdan oshgan sinf aynan shu minus bilan ko'rinadi);
 *   · sig'imi belgilanmagan sinf ro'yxatda QOLADI, lekin JAMI ga
 *     kirmaydi (0 deb hisoblansa, maktab sig'imi to'lgan ko'rinardi);
 *   · JAMI qatori o'zaro mos: sig'im − o'quvchi = bo'sh joy;
 *   · NOFAOL sinf faqat o'quvchisi bor bo'lsa ko'rinadi (filiallararo
 *     ko'chirishda ochiladigan tarix sinflari ro'yxatni to'ldirmasin);
 *   · tartib — bosqich bo'yicha 1→11, raqamsiz nomlar oxirida;
 *   · javobda PUL maydoni (qarz, grant) YO'Q — bu `finance.view` ortida.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

fakeModule("../src/config/prisma", {});
fakeModule("../src/config/platformPrisma", {});

const { buildCapacity } = require("../src/services/academicDashboard.service");

/* ───────────────────────── Ma'lumot ───────────────────────── */

const CLASSES = [
  { id: "c2", name: "2-b sinf rus", capacity: 22, isActive: true },
  { id: "c1", name: "1-sinf ingliz", capacity: 18, isActive: true },
  { id: "c3", name: "Bitiruvchilar", capacity: 10, isActive: true },
  { id: "c4", name: "3-sinf o'zbek", capacity: null, isActive: true },
  // Nofaol: biri bo'sh (tarix uchun ochilgan), biri o'quvchili
  { id: "c5", name: "5-sinf (eski)", capacity: 20, isActive: false },
  { id: "c6", name: "6-sinf (eski)", capacity: 20, isActive: false },
];

const seats = new Map([
  ["c1", 16],
  ["c2", 23], // sig'imdan oshgan
  ["c3", 10], // aniq to'lgan
  ["c4", 7], // sig'imi belgilanmagan
  ["c6", 4], // nofaol, lekin o'quvchisi bor
]);

const result = buildCapacity({ classRows: CLASSES, seatsByClass: seats });
const rowOf = (id) => result.rows.find((row) => row.classId === id);

/* ───────────────────────── Sinovlar ───────────────────────── */

test("bo'sh joy = sig'im − o'quvchi, sig'imdan oshsa MANFIY", () => {
  assert.equal(rowOf("c1").freeSpots, 2);
  assert.equal(rowOf("c1").fillRate, 88.9);

  assert.equal(rowOf("c2").freeSpots, -1);
  assert.equal(rowOf("c2").fillRate, 104.5);

  assert.equal(rowOf("c3").freeSpots, 0);
  assert.equal(rowOf("c3").fillRate, 100);
});

test("sig'imi belgilanmagan sinf ro'yxatda qoladi, lekin o'lchanmaydi", () => {
  const row = rowOf("c4");
  assert.equal(row.capacity, null);
  assert.equal(row.freeSpots, null);
  assert.equal(row.fillRate, null);
  assert.equal(row.studentCount, 7);
  assert.equal(result.totals.withoutCapacity, 1);
});

test("nofaol sinf faqat o'quvchisi bor bo'lsa ko'rinadi", () => {
  assert.equal(rowOf("c5"), undefined);
  assert.equal(rowOf("c6").studentCount, 4);
});

test("JAMI faqat sig'imi bor sinflardan va o'zaro mos", () => {
  const { capacity, occupied, freeSpots, fillRate, students, classCount } = result.totals;

  // 18 + 22 + 10 + 20 (nofaol, lekin o'quvchili) = 70
  assert.equal(capacity, 70);
  // 16 + 23 + 10 + 4 = 53 (sig'imsiz sinfning 7 tasi kirmaydi)
  assert.equal(occupied, 53);
  assert.equal(freeSpots, capacity - occupied);
  assert.equal(fillRate, 75.7);

  // Jadvaldagi hamma sinf: 53 + 7
  assert.equal(students, 60);
  assert.equal(classCount, 5);
});

test("tartib — bosqich bo'yicha, raqamsiz nom oxirida", () => {
  assert.deepEqual(
    result.rows.map((row) => row.className),
    ["1-sinf ingliz", "2-b sinf rus", "3-sinf o'zbek", "6-sinf (eski)", "Bitiruvchilar"],
  );
});

test("javobda pul maydonlari yo'q (qarz/grant moliyada qoladi)", () => {
  const keys = Object.keys(result.rows[0]).join(",");
  for (const forbidden of ["debt", "grant", "expected", "collected", "amount"]) {
    assert.equal(keys.includes(forbidden), false, `${forbidden} maydoni chiqib ketdi`);
  }
});

test("o'quvchisi yo'q, lekin faol sinf ham ro'yxatda (bo'sh joy ko'rinsin)", () => {
  const rows = buildCapacity({
    classRows: [{ id: "x", name: "7-sinf", capacity: 25, isActive: true }],
    seatsByClass: new Map(),
  });

  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].studentCount, 0);
  assert.equal(rows.rows[0].freeSpots, 25);
  assert.equal(rows.totals.fillRate, 0);
});

test("sig'im umuman belgilanmagan maktabda JAMI nol bilan qolmaydi", () => {
  const out = buildCapacity({
    classRows: [{ id: "x", name: "7-sinf", capacity: null, isActive: true }],
    seatsByClass: new Map([["x", 12]]),
  });

  assert.equal(out.totals.capacity, 0);
  // ⚠️ 0 maxrajda foiz YO'Q ("0% band" yolg'on bo'lardi)
  assert.equal(out.totals.fillRate, null);
  assert.equal(out.totals.students, 12);
});
