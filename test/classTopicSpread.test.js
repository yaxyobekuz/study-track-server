const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * SINF KARTASIDAGI "ENG ORQADA / ENG OLDINDA" KESIMI.
 *
 * `lessonTopic.service.js` haqiqiy kodi, baza soxta. Qabul mezonlari:
 *
 *   1. ⚠️ SHAXSIY REJASI YO'Q O'QUVCHI SINFNING O'RNIDA turadi (meros):
 *      bitta bolaga reja yozilishi butun guruhni "eng orqada" qilib
 *      qo'ymasligi kerak.
 *   2. ⚠️ QADAM (`step`) HISOBGA OLINADI — tez ketayotgan bola aynan
 *      shu sababli oldinda chiqadi.
 *   3. ⚠️ SINFDAN CHIQIB KETGAN yoki ARXIVLANGAN bolaning rejasi
 *      kesimga KIRMAYDI (`education.md` §4).
 *   4. ⚠️ KELAJAKDAGI ANKOR hali kuchga kirmagan — bunday bola MEROS
 *      oladi (`education.md` §13 segmentlar qoidasi).
 *   5. ⚠️ HAMMASI TENG bo'lsa `uniform` bilan belgilanadi — ekran ikkita
 *      bir xil qator chizmasligi uchun.
 *   6. ⚠️ KESIM FAQAT SO'RALGANDA hisoblanadi: sertifikat progressi va
 *      test qamrovi ham shu funksiyani chaqiradi va ularga u kerak emas.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const id = (char) => char.repeat(24);
const CLASS = id("c");
const SUBJECT = id("s");
const ADMIN = id("a");
const ALI = id("1");
const BOBUR = id("2");
const DILNOZA = id("3");
const KETGAN = id("9");

/** Dushanba — 2026-11-16; sinfda shu kuni 2-dars bor. */
const MONDAY = "2026-11-16";
const d = (iso) => new Date(`${iso}T00:00:00.000Z`);

const TOPICS = Array.from({ length: 100 }, (_, i) => ({
  id: `t${String(i + 1).padStart(3, "0")}`.padEnd(24, "0"),
  subjectId: SUBJECT,
  language: "uz",
  order: i + 1,
  name: `Mavzu ${i + 1}`,
}));

const state = {
  plans: [],
  members: [ALI, BOBUR, DILNOZA],
  alive: [ALI, BOBUR, DILNOZA],
  createdBindings: [],
};

/** Sinf ankori: 16-noyabr, 2-darsda 40-mavzu → sinfning o'rni = 40. */
const CLASS_BINDING = {
  id: id("b"),
  classId: CLASS,
  subjectId: SUBJECT,
  date: d(MONDAY),
  lessonOrder: 2,
  topicOrder: 40,
  source: "manual",
  snapshot: { language: "uz" },
  revokedAt: null,
};

fakeModule("../src/config/prisma", {
  subject: { findUnique: async () => ({ id: SUBJECT, name: "Tarix" }) },
  schedule: {
    findMany: async () => [
      {
        classId: CLASS,
        day: "dushanba",
        lessons: [{ order: 2, endTime: "23:59", subjectId: SUBJECT }],
      },
    ],
  },
  class: {
    findMany: async () => [{ id: CLASS, name: "IT 1", language: "uz" }],
  },
  topic: { findMany: async () => TOPICS },
  lessonTopicBinding: {
    findMany: async () => [CLASS_BINDING],
    createMany: async () => ({ count: 0 }),
  },
  studentTopicPlan: { findMany: async () => state.plans },
  userClass: {
    findMany: async () => state.members.map((userId) => ({ classId: CLASS, userId })),
  },
  user: {
    findMany: async ({ where }) => {
      const ids = where?.id?.in ?? [];
      return ids.filter((x) => state.alive.includes(x)).map((x) => ({ id: x }));
    },
  },
  classSubjectProgress: { findMany: async () => [] },
  holiday: { findMany: async () => [] },
  vacationMonth: { findMany: async () => [] },
});

const lessonTopic = require("../src/services/lessonTopic.service");

/** Shaxsiy ankor — sinf ankori bilan AYNI kun va dars (farqi faqat qadam). */
const plan = ({ studentId, topicOrder, step = 1, date = MONDAY }) => ({
  id: id("p"),
  studentId,
  classId: CLASS,
  subjectId: SUBJECT,
  date: d(date),
  lessonOrder: 2,
  topicOrder,
  step,
  startOrder: 1,
  revokedAt: null,
});

const spreadOf = async () => {
  const view = await lessonTopic.getSubjectClassTopics({
    subjectId: SUBJECT,
    actorId: ADMIN,
    ensure: false,
    withStudentSpread: true,
  });
  return view.classes[0];
};

test("shaxsiy reja yo'q — hamma sinfning o'rnida", async () => {
  state.plans = [];
  state.members = [ALI, BOBUR, DILNOZA];
  state.alive = [ALI, BOBUR, DILNOZA];

  const row = await spreadOf();

  assert.equal(row.currentTopicNumber, 40, "sinfning o'rni");
  assert.ok(row.studentSpread, "kesim baribir beriladi");
  assert.equal(row.studentSpread.uniform, true);
  assert.equal(row.studentSpread.behind.order, 40);
  assert.equal(row.studentSpread.ahead.order, 40);
  assert.equal(row.studentSpread.ahead.name, "Mavzu 40");
  assert.equal(row.studentSpread.withPlan, 0);
});

test("orqada va oldinda ketayotgan bolalar ikki chetni beradi", async () => {
  state.plans = [
    plan({ studentId: ALI, topicOrder: 12 }),
    plan({ studentId: BOBUR, topicOrder: 55 }),
  ];
  state.members = [ALI, BOBUR, DILNOZA];
  state.alive = [ALI, BOBUR, DILNOZA];

  const { studentSpread } = await spreadOf();

  assert.equal(studentSpread.uniform, false);
  assert.equal(studentSpread.behind.order, 12);
  assert.equal(studentSpread.ahead.order, 55);
  assert.equal(studentSpread.behind.name, "Mavzu 12");
  assert.equal(studentSpread.withPlan, 2);
  assert.equal(studentSpread.students, 3);
});

test("rejasi yo'q bola SINFNING o'rnida sanaladi (meros)", async () => {
  // Faqat ALI oldinda; qolgan ikkitasi meros oladi (40)
  state.plans = [plan({ studentId: ALI, topicOrder: 70 })];
  state.members = [ALI, BOBUR, DILNOZA];
  state.alive = [ALI, BOBUR, DILNOZA];

  const { studentSpread } = await spreadOf();

  assert.equal(studentSpread.behind.order, 40, "meros oluvchi sinfning o'rnida");
  assert.equal(studentSpread.ahead.order, 70);
});

test("hamma bolada reja bo'lsa sinfning o'rni kesimga QO'SHILMAYDI", async () => {
  state.plans = [
    plan({ studentId: ALI, topicOrder: 50 }),
    plan({ studentId: BOBUR, topicOrder: 60 }),
    plan({ studentId: DILNOZA, topicOrder: 70 }),
  ];
  state.members = [ALI, BOBUR, DILNOZA];
  state.alive = [ALI, BOBUR, DILNOZA];

  const { studentSpread } = await spreadOf();

  assert.equal(studentSpread.behind.order, 50, "40 (sinf) kesimga kirmaydi");
  assert.equal(studentSpread.ahead.order, 70);
  assert.equal(studentSpread.withPlan, 3);
});

test("sinfdan ketgan yoki arxivlangan bolaning rejasi hisobga olinmaydi", async () => {
  state.plans = [
    plan({ studentId: ALI, topicOrder: 45 }),
    plan({ studentId: KETGAN, topicOrder: 99 }), // sinfda yo'q
    plan({ studentId: DILNOZA, topicOrder: 5 }), // arxivlangan
  ];
  state.members = [ALI, BOBUR, DILNOZA];
  state.alive = [ALI, BOBUR]; // DILNOZA arxivlangan

  const { studentSpread } = await spreadOf();

  assert.equal(studentSpread.ahead.order, 45, "99 — bu sinfning bolasi emas");
  assert.equal(studentSpread.behind.order, 40, "5 — arxivlangan; BOBUR meros oladi");
  assert.equal(studentSpread.students, 2);
  assert.equal(studentSpread.withPlan, 1);
});

test("kelajakdagi ankor hali kuchga kirmagan — bola meros oladi", async () => {
  state.plans = [plan({ studentId: ALI, topicOrder: 90, date: "2026-12-07" })];
  state.members = [ALI, BOBUR, DILNOZA];
  state.alive = [ALI, BOBUR, DILNOZA];

  const { studentSpread } = await spreadOf();

  assert.equal(studentSpread.uniform, true, "hammasi sinfning o'rnida");
  assert.equal(studentSpread.ahead.order, 40);
  assert.equal(studentSpread.withPlan, 0);
});

test("QADAM hisobga olinadi — tez ketayotgan bola oldinda chiqadi", async () => {
  // Ankor oldingi dushanbada (9-noyabr, 2-dars): 16-noyabrgacha BITTA dars.
  //   qadam 1 → 10 + 1 = 11
  //   qadam 3 → 10 + 3 = 13
  state.plans = [
    plan({ studentId: ALI, topicOrder: 10, step: 1, date: "2026-11-09" }),
    plan({ studentId: BOBUR, topicOrder: 10, step: 3, date: "2026-11-09" }),
  ];
  state.members = [ALI, BOBUR];
  state.alive = [ALI, BOBUR];

  const { studentSpread } = await spreadOf();

  assert.equal(studentSpread.behind.order, 11, "qadam 1");
  assert.equal(studentSpread.ahead.order, 13, "qadam 3 — bitta darsda uch mavzu");
});

test("kesim SO'RALMASA umuman hisoblanmaydi", async () => {
  state.plans = [plan({ studentId: ALI, topicOrder: 12 })];

  const view = await lessonTopic.getSubjectClassTopics({
    subjectId: SUBJECT,
    actorId: ADMIN,
    ensure: false,
  });

  assert.equal(view.classes[0].studentSpread, undefined);
});
