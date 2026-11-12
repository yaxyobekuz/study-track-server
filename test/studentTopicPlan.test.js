const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * O'QUVCHINING SHAXSIY MAVZU REJASI — `studentTopicPlan.service.js`
 * haqiqiy kodi, baza soxta.
 *
 * Ushlab turiladigan qoidalar:
 *
 * 1. ⚠️ REJA YO'Q → SINFDAN MEROS (qadam 1). Butun guruhga qator yozish
 *    "shaxsiy reja" tushunchasini ma'nosiz qilardi.
 * 2. ⚠️ QADAM — TEZLIK, CHEGARA EMAS: 3 qo'yilsa bitta dars 3 mavzu beradi
 *    va `coveredThrough` blokning OXIRINI ko'rsatadi (test qamrovi aynan
 *    shundan olinadi).
 * 3. ⚠️ MAVZU SINFNING TILIDAGI RO'YXATDAN: rus guruhiga o'zbek
 *    ro'yxatidagi mavzu biriktirilmaydi.
 * 4. ⚠️ RO'YXAT SERVERDA QAYTA TEKSHIRILADI: begona (yoki arxivlangan)
 *    o'quvchiga reja yozilmaydi.
 * 5. ⚠️ HAR O'QUVCHI O'Z TRANZAKSIYASIDA: bittasi yiqilsa qolganlari
 *    baribir yoziladi.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const id = (char) => char.repeat(24);
const CLASS_UZ = id("c");
const SUBJECT = id("s");
const ADMIN = id("a");
const ALI = id("1");
const BOBUR = id("2");
const DILNOZA = id("3");
const CHET = id("9"); // boshqa sinfning o'quvchisi

/** Fanda 100 ta mavzu — har tilda mustaqil ro'yxat. */
const topicsFor = (language, count) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${language}t${String(i + 1).padStart(3, "0")}`.padEnd(24, "0"),
    subjectId: SUBJECT,
    language,
    order: i + 1,
    name: `${language.toUpperCase()} mavzu ${i + 1}`,
  }));

const TOPICS = { uz: topicsFor("uz", 100), ru: topicsFor("ru", 40) };

const STUDENTS = [
  { id: ALI, firstName: "Ali", lastName: "Aliyev", username: "ali" },
  { id: BOBUR, firstName: "Bobur", lastName: "Boburov", username: "bobur" },
  { id: DILNOZA, firstName: "Dilnoza", lastName: "Davronova", username: "dilnoza" },
];

const state = {
  classLanguage: "uz",
  plans: [],
  created: [],
  revoked: [],
  failOnStudent: null,
  topicLookups: [],
};

function resetState() {
  state.classLanguage = "uz";
  state.plans = [];
  state.created = [];
  state.revoked = [];
  state.failOnStudent = null;
  state.topicLookups = [];
}

/** Sinfning joriy mavzusi — yagona manba (`getSubjectClassTopics`) soxta. */
const CLASS_VIEW = {
  classes: [
    {
      class: { id: CLASS_UZ, name: "IT 1" },
      currentTopicNumber: 40,
      currentTopicName: "UZ mavzu 40",
      totalTopics: 100,
      reason: null,
      nextLesson: { date: "2026-11-16", dateLabel: "16-noyabr, 2026", lessonOrder: 2 },
      anchor: null,
      language: "uz",
    },
  ],
  totalTopics: 100,
  topicsByLanguage: { uz: 100, ru: 40 },
  subject: { id: SUBJECT, name: "Ingliz tili" },
};

fakeModule("../src/config/prisma", {
  class: {
    findUnique: async () => ({ id: CLASS_UZ, name: "IT 1", language: state.classLanguage }),
  },
  subject: {
    findUnique: async () => ({ id: SUBJECT, name: "Ingliz tili" }),
  },
  user: {
    findMany: async ({ where }) => {
      // Ro'yxatni qayta tekshirish: faqat SHU sinfning arxivlanmagan o'quvchisi
      if (where?.classes?.some?.classId) {
        const ids = where.id?.in;
        const pool = STUDENTS;
        return ids ? pool.filter((s) => ids.includes(s.id)) : pool;
      }
      const ids = where?.id?.in ?? [];
      return STUDENTS.filter((s) => ids.includes(s.id));
    },
  },
  topic: {
    findUnique: async ({ where }) => {
      const key = where.subjectId_language_order;
      state.topicLookups.push(key);
      return (
        TOPICS[key.language]?.find((topic) => topic.order === key.order) ?? null
      );
    },
    findMany: async ({ where }) => {
      const language = where.language ?? "uz";
      return TOPICS[language] ?? [];
    },
  },
  studentTopicPlan: {
    findMany: async ({ where }) =>
      state.plans
        .filter(
          (row) =>
            row.revokedAt == null &&
            (!where.studentId?.in || where.studentId.in.includes(row.studentId)),
        )
        .sort((a, b) => a.date - b.date || a.lessonOrder - b.lessonOrder),
    findUnique: async ({ where }) => state.plans.find((row) => row.id === where.id) ?? null,
    updateMany: async ({ where }) => {
      let count = 0;
      for (const row of state.plans) {
        if (where.activeKey && row.activeKey === where.activeKey) {
          row.activeKey = null;
          row.revokedAt = new Date();
          count += 1;
        }
        if (where.id && row.id === where.id && row.revokedAt == null) {
          row.activeKey = null;
          row.revokedAt = new Date();
          state.revoked.push(row.id);
          count += 1;
        }
      }
      return { count };
    },
    create: async ({ data }) => {
      if (state.failOnStudent === data.studentId) {
        throw new Error("baza band");
      }
      const row = { id: `p${state.plans.length + 1}`.padEnd(24, "0"), ...data };
      state.plans.push(row);
      state.created.push(row);
      return row;
    },
  },
  $transaction: async (fn) => fn(require("../src/config/prisma")),
});

fakeModule("../src/services/lessonTopic.service", {
  ANCHOR_HORIZON_DAYS: 60,
  getSubjectClassTopics: async () => CLASS_VIEW,
  loadClassTemplate: async () => ({
    subjectIds: [SUBJECT],
    // Dushanba 2-dars, chorshanba 4-dars, juma 1-dars
    slotsBySubject: new Map([
      [
        SUBJECT,
        new Map([
          [1, [{ order: 2, endTime: "09:00" }]],
          [3, [{ order: 4, endTime: "12:00" }]],
          [5, [{ order: 1, endTime: "08:30" }]],
        ]),
      ],
    ]),
    ordersBySubject: new Map([
      [SUBJECT, new Map([[1, [2]], [3, [4]], [5, [1]]])],
    ]),
    lessonsByDay: new Map(),
  }),
  loadTopics: async (subjectIds, language) =>
    new Map([
      [
        SUBJECT,
        {
          byOrder: new Map((TOPICS[language] ?? []).map((t) => [t.order, t])),
          last: (TOPICS[language] ?? []).length,
        },
      ],
    ]),
  buildCalendar: async () => ({ isTeachingDay: () => true, offReason: () => null }),
  findNextLessonSlot: () => ({ day: "2026-11-16", lessonOrder: 2 }),
  tashkentMinutes: () => 8 * 60,
});

fakeModule("../src/utils/idGenerator", { generateId: () => id("b") });

const service = require("../src/services/studentTopicPlan.service");

/* ═══════════════════════════════════════════════
   1. SINFDAN MEROS
   ═══════════════════════════════════════════════ */

test("reja YO'Q o'quvchi SINFDAN meros oladi (qadam 1)", async () => {
  resetState();
  const data = await service.listClassStudentTopics({
    classId: CLASS_UZ,
    subjectId: SUBJECT,
    actorId: ADMIN,
  });

  assert.equal(data.students.length, 3);
  for (const row of data.students) {
    assert.equal(row.inherited, true);
    assert.equal(row.step, 1);
    assert.equal(row.startOrder, 1);
    assert.equal(row.currentTopicNumber, 40, "sinfning raqami");
    assert.equal(row.coveredThrough, 40);
  }
  assert.equal(data.totals.withPlan, 0);
  assert.equal(data.totals.inherited, 3);
  assert.equal(data.classCurrentTopic, 40);
});

/* ═══════════════════════════════════════════════
   2. QADAM — TEZLIK
   ═══════════════════════════════════════════════ */

test("qadam 3 — ankor kunida blok 3 mavzuni qamraydi", async () => {
  resetState();
  // Ankor AYNAN keyingi darsga (16-noyabr, 2-dars): sanoq o'sha darsdan
  state.plans.push({
    id: id("p"),
    studentId: BOBUR,
    subjectId: SUBJECT,
    classId: CLASS_UZ,
    date: new Date("2026-11-16T00:00:00.000Z"),
    lessonOrder: 2,
    topicOrder: 61,
    step: 3,
    startOrder: 55,
    source: "manual",
    note: null,
    snapshot: {},
    activeKey: `${BOBUR}|${SUBJECT}|2026-11-16|2`,
    revokedAt: null,
    createdAt: new Date(),
    createdBy: ADMIN,
  });

  const data = await service.listClassStudentTopics({
    classId: CLASS_UZ,
    subjectId: SUBJECT,
    actorId: ADMIN,
  });

  const bobur = data.students.find((row) => row.student.id === BOBUR);
  assert.equal(bobur.inherited, false);
  assert.equal(bobur.step, 3);
  assert.equal(bobur.startOrder, 55);
  assert.equal(bobur.currentTopicNumber, 61, "blokning boshi");
  assert.equal(bobur.coveredThrough, 63, "blokning oxiri — test qamrovi shundan");

  // Qolganlari baribir sinfdan meros oladi
  const ali = data.students.find((row) => row.student.id === ALI);
  assert.equal(ali.inherited, true);
  assert.equal(ali.coveredThrough, 40);

  assert.equal(data.totals.withPlan, 1);
  assert.equal(data.totals.inherited, 2);
});

/* ═══════════════════════════════════════════════
   3. YOZISH — TIL, RO'YXAT, QADAM CHEGARASI
   ═══════════════════════════════════════════════ */

test("yozish: mavzu SINFNING TILIDAGI ro'yxatdan izlanadi", async () => {
  resetState();
  state.classLanguage = "ru";

  await service.setStudentTopicPlans({
    classId: CLASS_UZ,
    subjectId: SUBJECT,
    studentIds: [ALI],
    topicOrder: 12,
    step: 2,
    startOrder: 1,
    actorId: ADMIN,
  });

  assert.deepEqual(state.topicLookups, [
    { subjectId: SUBJECT, language: "ru", order: 12 },
  ]);
  assert.equal(state.created[0].snapshot.language, "ru");
  assert.equal(state.created[0].snapshot.topicName, "RU mavzu 12");
});

test("yozish: boshqa tilda YO'Q mavzu rad etiladi (sababida til aytiladi)", async () => {
  resetState();
  state.classLanguage = "ru"; // rus rejasida 40 ta mavzu bor

  await assert.rejects(
    () =>
      service.setStudentTopicPlans({
        classId: CLASS_UZ,
        subjectId: SUBJECT,
        studentIds: [ALI],
        topicOrder: 80, // o'zbek rejasida bor, rusda YO'Q
        actorId: ADMIN,
      }),
    /Rus tilidagi rejasida topilmadi/,
  );
  assert.equal(state.created.length, 0);
});

test("yozish: qadam chegarasi SERVISDA tekshiriladi", async () => {
  resetState();
  for (const bad of [0, -1, 999, 1.5]) {
    await assert.rejects(
      () =>
        service.setStudentTopicPlans({
          classId: CLASS_UZ,
          subjectId: SUBJECT,
          studentIds: [ALI],
          topicOrder: 10,
          step: bad,
          actorId: ADMIN,
        }),
      /mavzu soni 1 dan/,
      `qadam = ${bad}`,
    );
  }
  assert.equal(state.created.length, 0);
});

test("yozish: rejaning boshlanishi joriy mavzudan OSHMAYDI", async () => {
  resetState();
  await assert.rejects(
    () =>
      service.setStudentTopicPlans({
        classId: CLASS_UZ,
        subjectId: SUBJECT,
        studentIds: [ALI],
        topicOrder: 10,
        startOrder: 20,
        actorId: ADMIN,
      }),
    /boshlanishi \(20\) joriy mavzudan \(10\) katta/,
  );
});

test("yozish: BEGONA o'quvchi chetda qoladi, mavjudlari yoziladi", async () => {
  resetState();
  const result = await service.setStudentTopicPlans({
    classId: CLASS_UZ,
    subjectId: SUBJECT,
    studentIds: [ALI, CHET, DILNOZA],
    topicOrder: 30,
    step: 2,
    actorId: ADMIN,
  });

  assert.equal(result.totals.written, 2);
  assert.equal(result.totals.skipped, 1);
  assert.equal(result.skipped[0].studentId, CHET);
  assert.match(result.skipped[0].reason, /bu sinfda emas/);
  assert.deepEqual(
    state.created.map((row) => row.studentId).sort(),
    [ALI, DILNOZA].sort(),
  );
});

test("yozish: bitta o'quvchi yiqilsa qolganlari BARIBIR yoziladi", async () => {
  resetState();
  state.failOnStudent = BOBUR;

  const result = await service.setStudentTopicPlans({
    classId: CLASS_UZ,
    subjectId: SUBJECT,
    studentIds: [ALI, BOBUR, DILNOZA],
    topicOrder: 25,
    actorId: ADMIN,
  });

  assert.equal(result.totals.written, 2);
  assert.equal(result.totals.failed, 1);
  assert.equal(result.failed[0].studentId, BOBUR);
});

test("yozish: hammasi bitta BATCH kaliti bilan guruhlanadi", async () => {
  resetState();
  const result = await service.setStudentTopicPlans({
    classId: CLASS_UZ,
    subjectId: SUBJECT,
    studentIds: [ALI, DILNOZA],
    topicOrder: 15,
    actorId: ADMIN,
  });

  const batches = new Set(state.created.map((row) => row.batchId));
  assert.equal(batches.size, 1, "bitta amal — bitta batchId");
  assert.equal([...batches][0], result.batchId);
});

test("yozish: ANKOR kuni va darsini TIZIM tanlaydi (sinfning keyingi darsi)", async () => {
  resetState();
  const result = await service.setStudentTopicPlans({
    classId: CLASS_UZ,
    subjectId: SUBJECT,
    studentIds: [ALI],
    topicOrder: 15,
    actorId: ADMIN,
  });

  assert.equal(result.anchor.date, "2026-11-16");
  assert.equal(result.anchor.lessonOrder, 2);
  assert.equal(state.created[0].lessonOrder, 2);
  assert.equal(
    state.created[0].activeKey,
    `${ALI}|${SUBJECT}|2026-11-16|2`,
    "faol kalit — o'quvchi + fan + kun + dars",
  );
});

/* ═══════════════════════════════════════════════
   4. BEKOR QILISH — O'CHIRILMAYDI
   ═══════════════════════════════════════════════ */

test("bekor qilish: qator O'CHMAYDI, faol kaliti bo'shaydi", async () => {
  resetState();
  state.plans.push({
    id: id("p"),
    studentId: ALI,
    subjectId: SUBJECT,
    classId: CLASS_UZ,
    date: new Date("2026-11-16T00:00:00.000Z"),
    lessonOrder: 2,
    topicOrder: 61,
    step: 3,
    startOrder: 1,
    activeKey: `${ALI}|${SUBJECT}|2026-11-16|2`,
    revokedAt: null,
    snapshot: {},
  });

  await service.revokeStudentTopicPlan({ id: id("p"), actorId: ADMIN });

  assert.equal(state.plans.length, 1, "qator o'chirilmaydi");
  assert.equal(state.plans[0].activeKey, null);
  assert.notEqual(state.plans[0].revokedAt, null);
  assert.deepEqual(state.revoked, [id("p")]);
});

test("bekor qilish: allaqachon bekor qilingani qayta bekor qilinmaydi", async () => {
  resetState();
  state.plans.push({
    id: id("p"),
    studentId: ALI,
    subjectId: SUBJECT,
    classId: CLASS_UZ,
    activeKey: null,
    revokedAt: new Date(),
    snapshot: {},
  });

  await assert.rejects(
    () => service.revokeStudentTopicPlan({ id: id("p"), actorId: ADMIN }),
    /allaqachon bekor qilingan/,
  );
});
