const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * FANLAR BO'YICHA MAVZU HOLATI — `topic.service.getSubjectTopicStatus`
 * haqiqiy kodi, baza soxta.
 *
 * Ikki qoida ushlab turiladi:
 *
 * 1. Ro'yxat FANLAR KATALOGIDAN quriladi, mavzulardan EMAS — aks holda
 *    aynan javob kerak bo'lgan fan (mavzusi yo'q) ro'yxatda umuman
 *    ko'rinmasdi.
 * 2. Sanoq TIL KESIMIDA (2026-11-12): bitta fanda uch til uchun uch
 *    mustaqil reja bo'ladi va "ingliz guruh bor, lekin ingliz rejasi
 *    yuklanmagan" holati ekranda ko'rinishi kerak.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const id = (char) => char.repeat(24);
const ADABIYOT = id("a");
const FIZIKA = id("b");
const ESKI = id("c");

const SUBJECTS = [
  { id: ADABIYOT, name: "Adabiyot", isActive: true },
  { id: ESKI, name: "Eski fan", isActive: false },
  { id: FIZIKA, name: "Fizika", isActive: true },
];

// Mavzu faqat ikki fanda: Fizika "yuklanmagan" bo'lib qolishi kerak.
// Adabiyotda o'zbek rejasi (2 ta) va rus rejasi (1 ta) bor, ingliz yo'q.
const TOPICS = [
  { subjectId: ADABIYOT, language: "uz", createdAt: new Date("2026-11-02T08:00:00Z") },
  { subjectId: ADABIYOT, language: "uz", createdAt: new Date("2026-11-02T08:00:01Z") },
  { subjectId: ADABIYOT, language: "ru", createdAt: new Date("2026-11-05T09:00:00Z") },
  { subjectId: ESKI, language: "uz", createdAt: new Date("2025-01-10T10:00:00Z") },
];

// Maktabda o'zbek va ingliz guruhlar bor, rus guruh yo'q
const CLASSES = [
  { language: "uz", count: 7 },
  { language: "en", count: 2 },
];

fakeModule("../src/config/prisma", {
  subject: {
    findMany: async ({ orderBy }) => {
      assert.deepEqual(orderBy, { name: "asc" }, "fanlar alifbo tartibida o'qiladi");
      return [...SUBJECTS];
    },
  },
  topic: {
    groupBy: async ({ by }) => {
      assert.deepEqual(
        by,
        ["subjectId", "language"],
        "sanoq fan VA TIL bo'yicha guruhlanadi",
      );
      const map = new Map();
      for (const topic of TOPICS) {
        const key = `${topic.subjectId}|${topic.language}`;
        const row =
          map.get(key) ?? {
            subjectId: topic.subjectId,
            language: topic.language,
            _count: { _all: 0 },
            _max: { createdAt: null },
          };
        row._count._all += 1;
        if (!row._max.createdAt || topic.createdAt > row._max.createdAt) {
          row._max.createdAt = topic.createdAt;
        }
        map.set(key, row);
      }
      return [...map.values()];
    },
  },
  class: {
    groupBy: async ({ by, where }) => {
      assert.deepEqual(by, ["language"], "guruhlar til bo'yicha sanaladi");
      assert.deepEqual(where, { isActive: true }, "faqat FAOL guruhlar");
      return CLASSES.map((row) => ({ language: row.language, _count: { _all: row.count } }));
    },
  },
});

const { getSubjectTopicStatus } = require("../src/services/topic.service");

test("mavzusi YO'Q fan ham ro'yxatda qoladi", async () => {
  const { items } = await getSubjectTopicStatus();

  assert.deepEqual(
    items.map((item) => item.name),
    ["Adabiyot", "Eski fan", "Fizika"],
    "ro'yxat katalogdan — hamma fan, alifbo tartibida",
  );

  const fizika = items.find((item) => item.id === FIZIKA);
  assert.equal(fizika.hasTopics, false);
  assert.equal(fizika.topicCount, 0);
  assert.equal(fizika.lastUploadedAt, null);
});

test("yuklangan fanda soni va oxirgi yuklash vaqti bo'ladi", async () => {
  const { items } = await getSubjectTopicStatus();
  const adabiyot = items.find((item) => item.id === ADABIYOT);

  assert.equal(adabiyot.hasTopics, true);
  assert.equal(adabiyot.topicCount, 3, "filtrsiz — hamma tilning yig'indisi");
  assert.equal(
    adabiyot.lastUploadedAt.toISOString(),
    "2026-11-05T09:00:00.000Z",
    "eng KECH yozilgan qator — yuklash ro'yxatni almashtiradi",
  );
});

test("til kesimi har fanda alohida qaytadi", async () => {
  const { items } = await getSubjectTopicStatus();
  const adabiyot = items.find((item) => item.id === ADABIYOT);

  assert.deepEqual(
    adabiyot.languages.map((row) => [row.language, row.topicCount, row.hasTopics]),
    [
      ["uz", 2, true],
      ["ru", 1, true],
      ["en", 0, false],
    ],
    "uch til HAR DOIM qaytadi — yuklanmagani ham ko'rinishi kerak",
  );
});

test("til filtri sanoqni O'SHA tilga toraytiradi", async () => {
  const { items, language } = await getSubjectTopicStatus({ language: "ru" });
  const adabiyot = items.find((item) => item.id === ADABIYOT);
  const eski = items.find((item) => item.id === ESKI);

  assert.equal(language, "ru");
  assert.equal(adabiyot.topicCount, 1);
  assert.equal(
    adabiyot.lastUploadedAt.toISOString(),
    "2026-11-05T09:00:00.000Z",
    "filtrda ham sana O'SHA tilning yuklanishi",
  );
  assert.equal(eski.hasTopics, false, "rus rejasi yo'q fan — 'yuklanmagan'");
});

test("GURUH BOR, REJA YO'Q holati jamlanmada ko'rinadi", async () => {
  const { totals } = await getSubjectTopicStatus();
  const byLanguage = new Map(totals.byLanguage.map((row) => [row.language, row]));

  // Ingliz guruh bor (2 ta), lekin birorta fanga ingliz rejasi yuklanmagan —
  // ekran aynan shu farqni ko'rsatishi kerak.
  assert.equal(byLanguage.get("en").classes, 2);
  assert.equal(byLanguage.get("en").subjects, 0);
  assert.equal(byLanguage.get("en").topics, 0);

  // Rus rejasi bor, lekin rus guruh yo'q — teskari holat ham ko'rinadi
  assert.equal(byLanguage.get("ru").classes, 0);
  assert.equal(byLanguage.get("ru").subjects, 1);

  assert.equal(byLanguage.get("uz").classes, 7);
  assert.equal(byLanguage.get("uz").subjects, 2);
});

test("nofaol fan ham ko'rinadi va belgilanadi", async () => {
  const { items } = await getSubjectTopicStatus();
  const eski = items.find((item) => item.id === ESKI);

  assert.equal(eski.isActive, false);
  assert.equal(eski.hasTopics, true, "nofaol fanning mavzulari yo'qolmaydi");
});

test("jamlanma: yuklangan + yuklanmagan = jami fan", async () => {
  const { totals } = await getSubjectTopicStatus();

  assert.equal(totals.subjects, 3);
  assert.equal(totals.withTopics, 2);
  assert.equal(totals.withoutTopics, 1);
  assert.equal(totals.topics, 4, "uch tilning hamma mavzusi");
  assert.equal(totals.withTopics + totals.withoutTopics, totals.subjects);
});
