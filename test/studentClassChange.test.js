const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * O'QUVCHI SINFI O'ZGARISHI JURNALI — sof qoidalar.
 *
 * Baza bilan ishlaydigan oqim (qulf, parallel chiqarish, registr filtrlari)
 * lokal bazada sinalgan; bu yerda bazasiz tekshiriladigan qoidalar: sabab
 * majburiyligi, farq hisobi va jurnal qatorining shakli (tur, muhrlangan
 * sinf nomi, aktyor).
 */

const {
  normalizeReason,
  diffClassIds,
  recordClassChanges,
  REASON_MAX,
} = require("../src/services/studentClassChange.service");

const A = "a".repeat(24);
const B = "b".repeat(24);
const C = "c".repeat(24);
const STUDENT = "d".repeat(24);
const ACTOR = "e".repeat(24);

function fakeTx(classes) {
  const written = [];
  return {
    written,
    class: {
      findMany: async ({ where }) => classes.filter((c) => where.id.in.includes(c.id)),
    },
    studentClassChange: {
      createMany: async ({ data }) => {
        written.push(...data);
        return { count: data.length };
      },
    },
  };
}

test("sabab: bo'sh, qisqa va uzun sabab rad etiladi, chetdagi bo'shliq olinadi", () => {
  assert.throws(() => normalizeReason(undefined), /majburiy/);
  assert.throws(() => normalizeReason("   "), /majburiy/);
  assert.throws(() => normalizeReason(123), /majburiy/);
  assert.throws(() => normalizeReason(" ab "), /kamida 3/);
  assert.throws(() => normalizeReason("x".repeat(REASON_MAX + 1)), /oshmasligi/);
  assert.equal(normalizeReason("  Ota-ona iltimosi \n"), "Ota-ona iltimosi");
});

test("farq: tartib va takror ahamiyatsiz, faqat yo'qotilgan va qo'shilgan sinflar", () => {
  assert.deepEqual(diffClassIds([A], [A]), { removed: [], added: [] });
  assert.deepEqual(diffClassIds([B, A], [A, B, B]), { removed: [], added: [] });
  assert.deepEqual(diffClassIds([A], [B]), { removed: [A], added: [B] });
  assert.deepEqual(diffClassIds([A, B], []), { removed: [A, B], added: [] });
  assert.deepEqual(diffClassIds([], [C]), { removed: [], added: [C] });
  assert.deepEqual(diffClassIds([A, B], [B, C]), { removed: [A], added: [C] });
});

test("jurnal: sinf yo'qotilsa qator yoziladi — tur, muhrlangan nom, aktyor", async () => {
  const tx = fakeTx([
    { id: A, name: "5-A" },
    { id: B, name: "6-B" },
  ]);

  const count = await recordClassChanges(
    tx,
    [
      { studentId: STUDENT, fromClassIds: [A], toClassIds: [B] },
      { studentId: STUDENT, fromClassIds: [B], toClassIds: [] },
      // sof qo'shish — yozilmaydi
      { studentId: STUDENT, fromClassIds: [], toClassIds: [A] },
    ],
    { reason: "Sinf bo'lindi", source: "class_page", actorId: ACTOR },
  );

  assert.equal(count, 2);
  assert.equal(tx.written[0].type, "moved");
  assert.deepEqual(tx.written[0].fromClassNames, ["5-A"]);
  assert.deepEqual(tx.written[0].toClassNames, ["6-B"]);
  assert.equal(tx.written[1].type, "removed");
  assert.deepEqual(tx.written[1].toClassIds, []);
  assert.ok(tx.written.every((row) => row.createdBy === ACTOR && row.reason === "Sinf bo'lindi"));
});

test("jurnal: aktyorsiz yoki noma'lum manba bilan yozuv — dasturchi xatosi", async () => {
  const change = [{ studentId: STUDENT, fromClassIds: [A], toClassIds: [] }];
  const tx = fakeTx([{ id: A, name: "5-A" }]);

  await assert.rejects(
    recordClassChanges(tx, change, { reason: "Sabab", source: "profile", actorId: null }),
    /aktyor/,
  );
  await assert.rejects(
    recordClassChanges(tx, change, { reason: "Sabab", source: "excel", actorId: ACTOR }),
    /manba/,
  );
  assert.equal(tx.written.length, 0);
});
