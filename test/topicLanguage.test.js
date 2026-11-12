const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * MAVZULAR REJASI — TIL BO'YICHA MUSTAQIL (2026-11-12).
 *
 * Qoida bitta jumlada:
 *
 *     Bitta fanda uch til uchun UCH MUSTAQIL ro'yxat bo'ladi va har biri
 *     1 dan raqamlanadi. Rus rejasini yuklash o'zbek rejasiga TEGMAYDI.
 *
 * ⚠️ Bu ARIFMETIKA, siyosat emas: tartib raqami domenning o'lchovi va
 * jadvaldagi ankorlar (`LessonTopicBinding.topicOrder`) aynan unga
 * tayanadi. Tilsiz o'chirish bitta yuklash bilan boshqa ikki guruhning
 * butun rejasini yo'q qilardi.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const XLSX = require("xlsx");

const SUBJ = "s".repeat(24);
const ADMIN = "a".repeat(24);

const state = { deleted: [], created: [] };

fakeModule("../src/config/prisma", {
  subject: {
    findUnique: async ({ where }) =>
      where.id === SUBJ ? { id: SUBJ, name: "Matematika" } : null,
    findMany: async () => [{ id: SUBJ, name: "Matematika" }],
  },
  topic: {
    deleteMany: async ({ where }) => {
      state.deleted.push(where);
      return { count: 1 };
    },
    createMany: async ({ data }) => {
      state.created.push(...data);
      return { count: data.length };
    },
    findMany: async () => [],
    groupBy: async () => [],
  },
  class: { groupBy: async () => [] },
  $transaction: async (fn) => fn(require("../src/config/prisma")),
});

const topicService = require("../src/services/topic.service");

/** Shablon bo'yicha .xlsx buferi. */
function makeFile(rows) {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Daraja", "Kitob", "Mavzu", "Nimalar o'rgatiladi"],
    ...rows,
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Matematika");
  return {
    originalname: "mavzular.xlsx",
    buffer: XLSX.write(book, { type: "buffer", bookType: "xlsx" }),
  };
}

test("yuklash: FAQAT tanlangan tilning ro'yxati almashadi", async () => {
  state.deleted = [];
  state.created = [];

  await topicService.uploadTopics(
    SUBJ,
    makeFile([["A1", "Kitob", "Rus mavzu 1", ""], ["A1", "Kitob", "Rus mavzu 2", ""]]),
    ADMIN,
    { language: "ru" },
  );

  assert.deepEqual(
    state.deleted,
    [{ subjectId: SUBJ, language: "ru" }],
    "o'chirish SHARTIDA til bor — o'zbek rejasiga tegilmaydi",
  );
  assert.equal(state.created.length, 2);
  for (const row of state.created) {
    assert.equal(row.language, "ru");
    assert.equal(row.subjectId, SUBJ);
  }
  // Har til MUSTAQIL raqamlanadi — 1 dan
  assert.deepEqual(
    state.created.map((row) => row.order),
    [1, 2],
  );
});

test("yuklash: til berilmasa `uz` (eski mijozlar uchun)", async () => {
  state.deleted = [];
  state.created = [];

  const result = await topicService.uploadTopics(
    SUBJ,
    makeFile([["", "", "Mavzu 1", ""]]),
    ADMIN,
  );

  assert.equal(result.language, "uz");
  assert.deepEqual(state.deleted, [{ subjectId: SUBJ, language: "uz" }]);
  assert.equal(state.created[0].language, "uz");
});

test("yuklash: TANIMAGAN til RAD ETILADI (jim `uz` ga tushmaydi)", async () => {
  state.deleted = [];
  state.created = [];

  await assert.rejects(
    () =>
      topicService.uploadTopics(SUBJ, makeFile([["", "", "Mavzu 1", ""]]), ADMIN, {
        language: "de",
      }),
    /Noma'lum o'quv tili "de"/,
  );
  assert.equal(state.deleted.length, 0, "tekshiruv O'CHIRISHDAN OLDIN");
  assert.equal(state.created.length, 0);
});

test("yuklash: til katta harf / bo'shliq bilan kelsa normallashadi", async () => {
  state.deleted = [];
  state.created = [];

  const result = await topicService.uploadTopics(
    SUBJ,
    makeFile([["", "", "Mavzu 1", ""]]),
    ADMIN,
    { language: " EN " },
  );

  assert.equal(result.language, "en");
  assert.deepEqual(state.deleted, [{ subjectId: SUBJ, language: "en" }]);
});

test("o'chirish: FAQAT tanlangan tilning mavzulari o'chadi", async () => {
  state.deleted = [];

  const result = await topicService.deleteTopicsBySubject(SUBJ, { language: "ru" });

  assert.deepEqual(state.deleted, [{ subjectId: SUBJ, language: "ru" }]);
  assert.equal(result.language, "ru");
  assert.equal(result.languageLabel, "Rus");
});

test("o'chirish: tanimagan til RAD ETILADI", async () => {
  state.deleted = [];

  await assert.rejects(
    () => topicService.deleteTopicsBySubject(SUBJ, { language: "fr" }),
    /Noma'lum o'quv tili/,
  );
  assert.equal(state.deleted.length, 0);
});
