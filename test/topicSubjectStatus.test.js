const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * FANLAR BO'YICHA MAVZU HOLATI — `topic.service.getSubjectTopicStatus`
 * haqiqiy kodi, baza soxta.
 *
 * Eng muhim qoida: ro'yxat FANLAR KATALOGIDAN quriladi, mavzulardan EMAS —
 * aks holda aynan javob kerak bo'lgan fan (mavzusi yo'q) ro'yxatda umuman
 * ko'rinmasdi.
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

// Mavzu faqat ikki fanda: Fizika "yuklanmagan" bo'lib qolishi kerak
const TOPICS = [
  { subjectId: ADABIYOT, createdAt: new Date("2026-11-02T08:00:00Z") },
  { subjectId: ADABIYOT, createdAt: new Date("2026-11-02T08:00:01Z") },
  { subjectId: ESKI, createdAt: new Date("2025-01-10T10:00:00Z") },
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
      assert.deepEqual(by, ["subjectId"], "sanoq fan bo'yicha guruhlanadi");
      const map = new Map();
      for (const topic of TOPICS) {
        const row = map.get(topic.subjectId) ?? { subjectId: topic.subjectId, _count: { _all: 0 }, _max: { createdAt: null } };
        row._count._all += 1;
        if (!row._max.createdAt || topic.createdAt > row._max.createdAt) {
          row._max.createdAt = topic.createdAt;
        }
        map.set(topic.subjectId, row);
      }
      return [...map.values()];
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
  assert.equal(adabiyot.topicCount, 2);
  assert.equal(
    adabiyot.lastUploadedAt.toISOString(),
    "2026-11-02T08:00:01.000Z",
    "eng KECH yozilgan qator — yuklash ro'yxatni almashtiradi",
  );
});

test("nofaol fan ham ko'rinadi va belgilanadi", async () => {
  const { items } = await getSubjectTopicStatus();
  const eski = items.find((item) => item.id === ESKI);

  assert.equal(eski.isActive, false);
  assert.equal(eski.hasTopics, true, "nofaol fanning mavzulari yo'qolmaydi");
});

test("jamlanma: yuklangan + yuklanmagan = jami fan", async () => {
  const { totals } = await getSubjectTopicStatus();

  assert.deepEqual(totals, {
    subjects: 3,
    withTopics: 2,
    withoutTopics: 1,
    topics: 3,
  });
  assert.equal(totals.withTopics + totals.withoutTopics, totals.subjects);
});
