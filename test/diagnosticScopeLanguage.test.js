const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * DIAGNOSTIKA QAMROVI — KO'P TILLI FANDA MAXRAJ.
 *
 * Bu faylda ushlab turiladigan qoida BITTA va u modulning asosiy
 * qoidasini himoya qiladi:
 *
 *     Chegara SINFNING TILIDAGI mavzular ro'yxatidan olinadi.
 *     Rus guruhda 40 mavzu bo'lsa, chegara 40 — o'zbek rejasidagi
 *     100 EMAS.
 *
 * ⚠️ NEGA MUHIM: "Mavzular tugagan" shoxida chegara maxrajga
 * tenglashtiriladi (`topicsExhausted`). Fan darajasidagi `totalTopics`
 * hamma tilning ENG UZUN ro'yxati bo'lgani uchun, u ishlatilsa rus
 * guruhiga 41–100 mavzulardan savol tushib ketardi — ya'ni "o'tilmagan
 * mavzudan savol berilmaydi" qoidasi JIMGINA buzilardi.
 *
 * Servis HAQIQIY kodi, baza soxta.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const id = (char) => char.repeat(24);
const CLASS_RU = id("r");
const SUBJ = id("s");
const ADMIN = id("a");

/** O'zbek rejasida 100, rus rejasida 40 mavzu. */
const TOPICS = {
  uz: Array.from({ length: 100 }, (_, i) => ({
    id: `uz${i + 1}`.padEnd(24, "0"),
    order: i + 1,
    name: `UZ ${i + 1}`,
    description: null,
    level: null,
    book: null,
  })),
  ru: Array.from({ length: 40 }, (_, i) => ({
    id: `ru${i + 1}`.padEnd(24, "0"),
    order: i + 1,
    name: `RU ${i + 1}`,
    description: null,
    level: null,
    book: null,
  })),
};

const state = {
  /** Sinfning joriy mavzusi va sababi (`getSubjectClassTopics` qaytaradi). */
  current: null,
  reason: "Mavzular tugagan",
  /** Sinfning TILIDAGI ro'yxat uzunligi. */
  classTotal: 40,
  /** Fan darajasidagi maxraj — HAMMA tilning eng uzuni. */
  subjectTotal: 100,
  topicQueries: [],
};

fakeModule("../src/config/prisma", {
  class: {
    findUnique: async ({ where }) =>
      where.id === CLASS_RU ? { id: CLASS_RU, name: "5-V", language: "ru" } : null,
  },
  subject: {
    findMany: async ({ where }) =>
      (where?.id?.in ?? [SUBJ]).map((x) => ({ id: x, name: "Matematika" })),
  },
  topic: {
    findMany: async ({ where }) => {
      state.topicQueries.push(where);
      return TOPICS[where.language] ?? [];
    },
  },
});

fakeModule("../src/services/certificateProgress.service", {
  PROGRESS_REASONS: {
    noTrackSubject: "Yo'nalish maktab faniga bog'lanmagan",
    noTopics: "Fanga mavzular yuklanmagan",
    noClass: "O'quvchi sinfga biriktirilmagan",
    noClassLesson: "O'quvchining sinfida bu fandan dars yo'q",
  },
  loadSubjectProgress: async (subjectIds) =>
    new Map(
      subjectIds.map((subjectId) => [
        subjectId,
        {
          // Fan darajasidagi maxraj — eng uzun ro'yxat (o'zbek)
          totalTopics: state.subjectTotal,
          byClass: new Map([
            [
              CLASS_RU,
              {
                className: "5-V",
                currentTopicNumber: state.current,
                currentTopicName: state.current ? `RU ${state.current}` : null,
                reason: state.reason,
                nextLesson: null,
                // Sinfning O'Z maxraji (rus rejasi)
                totalTopics: state.classTotal,
                language: "ru",
              },
            ],
          ]),
        },
      ]),
    ),
});

fakeModule("../src/services/studentTopicPlan.service", {
  loadClassStudents: async () => [],
  resolveStudentTopics: async () => ({ students: [], byStudent: new Map() }),
});

const scopeService = require("../src/services/diagnosticTopicScope.service");

const blueprint = (extra = {}) => [
  {
    subjectId: SUBJ,
    source: "bank",
    topicMode: "current",
    easy: 2,
    medium: 0,
    hard: 0,
    ...extra,
  },
];

test("MAVZULAR TUGAGAN: chegara SINFNING tilidagi ro'yxat uzunligi", async () => {
  state.current = null;
  state.reason = "Mavzular tugagan";
  state.topicQueries = [];

  const { scopes, errors } = await scopeService.resolveScopes({
    classId: CLASS_RU,
    blueprint: blueprint(),
    actorId: ADMIN,
  });

  assert.equal(errors.length, 0);
  assert.equal(scopes[0].totalTopics, 40, "maxraj — RUS rejasining uzunligi");
  assert.equal(
    scopes[0].currentTopicNumber,
    40,
    "chegara 40 — o'zbek rejasidagi 100 EMAS",
  );
  assert.equal(scopes[0].topicTo, 40);
  assert.equal(
    scopes[0].topics.at(-1).order,
    40,
    "41–100 mavzulardan savol tushmaydi",
  );
});

test("MAVZULAR TIL BO'YICHA O'QILADI (so'rovda til bor)", async () => {
  state.current = 20;
  state.reason = null;
  state.topicQueries = [];

  const { scopes } = await scopeService.resolveScopes({
    classId: CLASS_RU,
    blueprint: blueprint(),
    actorId: ADMIN,
  });

  assert.deepEqual(
    state.topicQueries,
    [{ subjectId: SUBJ, language: "ru" }],
    "mavzular SINFNING tilidan o'qiladi",
  );
  assert.equal(scopes[0].topics[0].name, "RU 1", "matn rus rejasidan");
  assert.equal(scopes[0].topicTo, 20);
  assert.equal(scopes[0].language, "ru");
});

test("ORALIQ sinfning joriy mavzusidan oshsa — KESILADIGAN xato", async () => {
  state.current = 20;
  state.reason = null;

  const { scopes, errors } = await scopeService.resolveScopes({
    classId: CLASS_RU,
    blueprint: blueprint({ topicMode: "range", topicFrom: 1, topicTo: 35 }),
    actorId: ADMIN,
  });

  assert.equal(errors.length, 1);
  // ⚠️ `clampable` — SINF yo'lida xato, O'QUVCHI yo'lida esa chegara har
  // bolaga alohida kesiladi (`resolveStudentScopes`).
  assert.equal(errors[0].clampable, true);
  assert.equal(scopes[0].clampable, true);
  assert.match(errors[0].message, /20-mavzuda/);
});

test("SINF MAXRAJI YO'Q bo'lsa fan darajasidagi raqam ZAXIRA bo'ladi", async () => {
  state.current = null;
  state.reason = "Mavzular tugagan";
  state.classTotal = null; // eski qator — sinfning maxraji yozilmagan

  const { scopes } = await scopeService.resolveScopes({
    classId: CLASS_RU,
    blueprint: blueprint(),
    actorId: ADMIN,
  });

  assert.equal(scopes[0].totalTopics, 100, "zaxira — fan darajasidagi raqam");

  state.classTotal = 40; // holatni tiklash
});
