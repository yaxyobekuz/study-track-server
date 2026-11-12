const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * DIAGNOSTIKA — HAR O'QUVCHIGA O'Z TESTI (2026-11-12).
 *
 * Bu faylda ushlab turiladigan asosiy qoida BITTA va u modulning
 * butun va'dasi:
 *
 *     Testga FAQAT O'SHA BOLA o'tgan mavzulardan savol tushadi.
 *     Guruhda Ali 42-mavzuda, Bobur 20-mavzuda bo'lsa — Boburga
 *     21-mavzudan savol BERILMAYDI.
 *
 * Qolgan tekshiruvlar shu qoidani himoya qiladi:
 *   · oraliq har bolaga KESILADI (xato otilmaydi — aynan so'ralgan narsa);
 *   · oraliqning boshiga yetmagan bola CHETDA qoladi, boshqalari oladi;
 *   · bir xil qamrovli bolalar AYNI savollarni oladi (AI bir marta chaqiriladi);
 *   · tasdiqsiz test chiqmaydi va tasdiqdan keyin savol almashtirilmaydi;
 *   · almashtirilgan savol AYNI qiyinlik va AYNI oraliqdan keladi.
 *
 * Servislar HAQIQIY kodi, baza va model soxta.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const id = (char) => char.repeat(24);
const CLASS_ID = id("c");
const SUBJ = id("m");
const ADMIN = id("a");
const ALI = id("1");
const BOBUR = id("2");
const DILNOZA = id("3");

/** Fanda 120 ta mavzu. */
const TOPICS = Array.from({ length: 120 }, (_, i) => ({
  id: `t${String(i + 1).padStart(4, "0")}`.padEnd(24, "0"),
  subjectId: SUBJ,
  language: "uz",
  order: i + 1,
  name: `Mavzu ${i + 1}`,
  description: null,
  level: null,
  book: null,
}));

/** Bank: 1–120 mavzulardan har darajada 3 ta savol. */
const BANK = [];
for (const topic of TOPICS) {
  for (const difficulty of ["easy", "medium", "hard"]) {
    for (let n = 1; n <= 3; n += 1) {
      BANK.push({
        id: `q${topic.order}${difficulty[0]}${n}`.padEnd(24, "0"),
        subjectId: SUBJ,
        topicId: topic.id,
        topic: { order: topic.order },
        grade: null,
        status: "approved",
        type: "single",
        language: "uz",
        difficulty,
        text: `Bank ${topic.order} ${difficulty} ${n}`,
        usageCount: 0,
        createdAt: new Date(2026, 0, 1),
      });
    }
  }
}

const STUDENTS = [
  { id: ALI, firstName: "Ali", lastName: "Aliyev", username: "ali" },
  { id: BOBUR, firstName: "Bobur", lastName: "Boburov", username: "bobur" },
  { id: DILNOZA, firstName: "Dilnoza", lastName: "Davronova", username: "dilnoza" },
];

/* ── Holat ──────────────────────────────────── */

const state = {
  /** Sinfning joriy mavzusi. */
  classCurrent: 42,
  classReason: null,
  /** O'quvchining o'rni: `coveredThrough` / `startOrder` / `step`. */
  positions: {
    [ALI]: { covered: 42, start: 1, step: 1, inherited: true },
    [BOBUR]: { covered: 60, start: 10, step: 3, inherited: false },
    [DILNOZA]: { covered: 20, start: 1, step: 1, inherited: false },
  },
  testRow: null,
  studentRows: [],
  linkRows: [],
  createdTest: null,
  bankExhausted: false,
};

function resetState() {
  state.classCurrent = 42;
  state.classReason = null;
  state.positions = {
    [ALI]: { covered: 42, start: 1, step: 1, inherited: true },
    [BOBUR]: { covered: 60, start: 10, step: 3, inherited: false },
    [DILNOZA]: { covered: 20, start: 1, step: 1, inherited: false },
  };
  state.testRow = null;
  state.studentRows = [];
  state.linkRows = [];
  state.createdTest = null;
  state.bankExhausted = false;
  aiCalls.length = 0;
  savedQuestions.length = 0;
}

const matchWhere = (question, where) => {
  if (where.subjectId && question.subjectId !== where.subjectId) return false;
  if (where.status && question.status !== where.status) return false;
  if (where.type?.not && question.type === where.type.not) return false;
  if (where.language && question.language !== where.language) return false;
  if (where.grade !== undefined && where.grade !== null && question.grade !== where.grade) {
    return false;
  }
  if (where.difficulty?.in && !where.difficulty.in.includes(question.difficulty)) return false;
  if (where.topicId?.in && !where.topicId.in.includes(question.topicId)) return false;
  if (where.id?.notIn && where.id.notIn.includes(question.id)) return false;
  if (where.id?.in && !where.id.in.includes(question.id)) return false;
  return true;
};

const prismaStub = {
  class: {
    findUnique: async ({ where }) =>
      where.id === CLASS_ID ? { id: CLASS_ID, name: "IT 1", language: "uz" } : null,
    findMany: async () => [{ id: CLASS_ID, name: "IT 1", language: "uz" }],
  },
  subject: {
    findMany: async ({ where }) => {
      const ids = where?.id?.in ?? [SUBJ];
      return ids.filter((x) => x === SUBJ).map((x) => ({ id: x, name: "Matematika" }));
    },
    findUnique: async ({ where }) =>
      where.id === SUBJ ? { id: SUBJ, name: "Matematika" } : null,
  },
  user: {
    findMany: async ({ where }) => {
      const ids = where?.id?.in;
      return ids ? STUDENTS.filter((s) => ids.includes(s.id)) : STUDENTS;
    },
  },
  topic: {
    findMany: async ({ where }) => {
      let rows = TOPICS.filter((t) => t.subjectId === where.subjectId);
      if (where.language) rows = rows.filter((t) => t.language === where.language);
      if (where.order?.gte != null) rows = rows.filter((t) => t.order >= where.order.gte);
      if (where.order?.lte != null) rows = rows.filter((t) => t.order <= where.order.lte);
      return rows;
    },
  },
  diagnosticQuestion: {
    count: async ({ where }) => BANK.filter((q) => matchWhere(q, where)).length,
    findMany: async ({ where, take, select }) => {
      if (state.bankExhausted && where.id?.notIn) return [];
      const rows = BANK.filter((q) => matchWhere(q, where));
      const limited = take ? rows.slice(0, take) : rows;
      if (select?.difficulty) {
        return limited.map((q) => ({ id: q.id, text: q.text, difficulty: q.difficulty }));
      }
      if (select?.options) {
        return limited.map((q) => ({ ...q, options: [] }));
      }
      return limited.map((q) => ({ id: q.id, text: q.text }));
    },
  },
  diagnosticTest: {
    create: async ({ data }) => {
      state.createdTest = data;
      // ⚠️ `classes` — Prisma'da YOZISH shakli (`{ create: [...] }`), O'QISHDA
      // esa massiv. Soxta baza ikkisini ajratmasa, `_shape` yiqilardi.
      const { classes, ...rest } = data;
      state.testRow = {
        id: id("t"),
        ...rest,
        approvedAt: data.approvedAt ?? null,
        classes: [{ class: { id: CLASS_ID, name: "IT 1" } }],
        _count: { questions: 0, attempts: 0 },
      };
      return state.testRow;
    },
    findUnique: async () => state.testRow,
    update: async ({ data }) => {
      Object.assign(state.testRow, data);
      return state.testRow;
    },
    updateMany: async ({ where, data }) => {
      if (where.approvedAt === null && state.testRow.approvedAt) return { count: 0 };
      Object.assign(state.testRow, data);
      return { count: 1 };
    },
  },
  diagnosticTestClass: {
    findFirst: async () => ({ classId: CLASS_ID }),
    count: async () => 1,
  },
  diagnosticTestQuestion: { findMany: async () => [] },
  diagnosticTestStudent: {
    createMany: async ({ data }) => {
      state.studentRows.push(...data);
      return { count: data.length };
    },
    findMany: async () => state.studentRows,
    findUnique: async ({ where }) =>
      state.studentRows.find(
        (row) => row.studentId === where.testId_studentId.studentId,
      ) ?? null,
  },
  diagnosticTestStudentQuestion: {
    createMany: async ({ data }) => {
      state.linkRows.push(...data);
      return { count: data.length };
    },
    findMany: async ({ where, include }) => {
      // ⚠️ Soxta baza `where.studentId` ni HISOBGA OLADI: usiz
      // `studentQuestionSet` butun guruhning savollarini qaytarib,
      // "o'z to'plami" qoidasi tekshirilmay qolardi.
      const rows = [...state.linkRows]
        .filter((row) => !where?.studentId || row.studentId === where.studentId)
        .sort((a, b) => a.studentId.localeCompare(b.studentId) || a.position - b.position);
      if (!include) return rows;
      return rows.map((row) => ({
        ...row,
        question: BANK.find((q) => q.id === row.questionId) ?? {
          id: row.questionId,
          subjectId: SUBJ,
          grade: null,
          difficulty: row.difficulty,
          text: `AI ${row.questionId}`,
          topic: { order: 1 },
          options: [],
        },
      }));
    },
    delete: async ({ where }) => {
      const key = where.testId_studentId_questionId;
      const index = state.linkRows.findIndex(
        (row) => row.studentId === key.studentId && row.questionId === key.questionId,
      );
      if (index === -1) throw new Error("topilmadi");
      return state.linkRows.splice(index, 1)[0];
    },
    create: async ({ data }) => {
      state.linkRows.push(data);
      return data;
    },
  },
  $transaction: async (fn) => fn(prismaStub),
};

fakeModule("../src/config/prisma", prismaStub);

fakeModule("../src/services/settings.service", {
  getDiagnosticSettings: async () => ({
    aiEnabled: true,
    defaultQuestionCount: 20,
    defaultDurationMin: 30,
    defaultAttempts: 1,
    goodScore: 70,
    mediumScore: 40,
    weakTopicScore: 80,
  }),
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
          totalTopics: TOPICS.length,
          byClass: new Map([
            [
              CLASS_ID,
              {
                className: "IT 1",
                currentTopicNumber: state.classCurrent,
                currentTopicName: `Mavzu ${state.classCurrent}`,
                reason: state.classReason,
                nextLesson: null,
              },
            ],
          ]),
        },
      ]),
    ),
});

/** O'quvchilarning o'rni — `studentTopicPlan.service.js` soxta. */
fakeModule("../src/services/studentTopicPlan.service", {
  loadClassStudents: async () => STUDENTS,
  resolveStudentTopics: async ({ studentIds }) => {
    const students = studentIds?.length
      ? STUDENTS.filter((s) => studentIds.includes(s.id))
      : STUDENTS;
    return {
      class: { id: CLASS_ID, name: "IT 1" },
      subject: { id: SUBJ, name: "Matematika" },
      language: "uz",
      languageLabel: "O'zbek",
      totalTopics: TOPICS.length,
      nextLesson: null,
      classCurrentTopic: state.classCurrent,
      classReason: state.classReason,
      students,
      byStudent: new Map(
        students.map((student) => {
          const pos = state.positions[student.id];
          return [
            student.id,
            {
              studentId: student.id,
              student,
              plan: pos.inherited ? null : { id: "p", step: pos.step },
              inherited: pos.inherited,
              step: pos.step,
              startOrder: pos.start,
              currentTopicNumber: pos.covered,
              currentTopicName: `Mavzu ${pos.covered}`,
              coveredThrough: pos.covered,
              coveredThroughName: `Mavzu ${pos.covered}`,
              totalTopics: TOPICS.length,
              reason: pos.reason ?? null,
            },
          ];
        }),
      ),
    };
  },
});

/** AI — soxta model. */
const aiCalls = [];
let aiEnabledFlag = true;
let aiYieldRatio = 1;

fakeModule("../src/services/diagnosticAiQuestion.service", {
  MAX_REQUESTS_PER_BUILD: 30,
  isEnabled: async () => aiEnabledFlag,
  assertEnabled: async () => {
    if (!aiEnabledFlag) throw new Error("AI o'chirilgan");
  },
  generateForRow: async ({ subject, topics, counts, language }) => {
    aiCalls.push({
      subjectId: subject.id,
      language,
      topics: topics.map((t) => t.order),
      counts,
    });
    const items = [];
    for (const [key, want] of Object.entries(counts)) {
      const produce = Math.round(want * aiYieldRatio);
      for (let i = 0; i < produce; i += 1) {
        const topic = topics[i % topics.length];
        items.push({
          subjectId: subject.id,
          topicId: topic.id,
          topicOrder: topic.order,
          language,
          text: `AI ${topic.order} ${key} ${aiCalls.length} ${i}`,
          type: "single",
          difficulty: key,
          explanation: "izoh",
          options: [],
        });
      }
    }
    return { items, warnings: [], requests: 1 };
  },
});

const savedQuestions = [];
fakeModule("../src/services/diagnosticQuestion.service", {
  createGeneratedQuestions: async (items) => {
    const base = savedQuestions.length;
    savedQuestions.push(...items);
    return {
      created: items.map((item, index) => ({
        id: `ai${base + index}`.padEnd(24, "0"),
        code: `D-0009${base + index}`,
        subjectId: item.subjectId,
        topicId: item.topicId,
        difficulty: item.difficulty,
      })),
      duplicates: 0,
      failed: 0,
      errors: [],
    };
  },
  approveQuestions: async (ids) => ({ approved: ids.length, skipped: [] }),
});

const scopeService = require("../src/services/diagnosticTopicScope.service");
const studentTestService = require("../src/services/diagnosticStudentTest.service");

const blueprintCurrent = (source = "bank") => [
  { subjectId: SUBJ, source, topicMode: "current", easy: 2, medium: 2, hard: 0 },
];

/* ═══════════════════════════════════════════════
   1. QOIDANING O'ZI — har bola O'Z oralig'ida
   ═══════════════════════════════════════════════ */

test("QOIDA: har o'quvchining yuqori chegarasi O'ZINING o'rni", async () => {
  resetState();
  const resolved = await scopeService.resolveStudentScopes({
    classId: CLASS_ID,
    blueprint: blueprintCurrent(),
    actorId: ADMIN,
  });

  const byId = new Map(resolved.students.map((row) => [row.student.id, row]));

  assert.equal(byId.get(ALI).scopes[0].topicTo, 42, "Ali — 42-mavzuda");
  assert.equal(byId.get(BOBUR).scopes[0].topicTo, 60, "Bobur — 60-mavzuda (qadam 3)");
  assert.equal(byId.get(DILNOZA).scopes[0].topicTo, 20, "Dilnoza — 20-mavzuda");

  // Rejaning boshlanishi ham o'quvchining o'zidan
  assert.equal(byId.get(BOBUR).scopes[0].topicFrom, 10);
  assert.equal(byId.get(ALI).scopes[0].topicFrom, 1);

  // Mavzular ro'yxati ham kesilgan
  assert.deepEqual(
    byId.get(DILNOZA).scopes[0].topics.map((t) => t.order),
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
});

test("QOIDA: o'quvchi SINFDAN OLDINDA bo'lsa ham chegara O'ZIDAN", async () => {
  resetState();
  // Sinf 42-mavzuda, Bobur qadam 3 bilan 60-mavzuda — sinfdan OLDINDA
  const resolved = await scopeService.resolveStudentScopes({
    classId: CLASS_ID,
    blueprint: blueprintCurrent(),
    actorId: ADMIN,
  });

  const bobur = resolved.students.find((row) => row.student.id === BOBUR);
  assert.equal(bobur.status, "ready");
  assert.equal(bobur.scopes[0].topicTo, 60);
  assert.equal(
    bobur.scopes[0].topics.at(-1).order,
    60,
    "sinfning 42 chegarasi o'quvchini cheklamaydi",
  );
});

test("ORALIQ har bolaga KESILADI va bu OCHIQ aytiladi", async () => {
  resetState();
  const resolved = await scopeService.resolveStudentScopes({
    classId: CLASS_ID,
    blueprint: [
      { subjectId: SUBJ, source: "bank", topicMode: "range", topicFrom: 5, topicTo: 50, easy: 2, medium: 0, hard: 0 },
    ],
    actorId: ADMIN,
  });

  const byId = new Map(resolved.students.map((row) => [row.student.id, row]));

  // Ali 42-mavzuda → 5–42 (kesilgan)
  assert.equal(byId.get(ALI).scopes[0].topicTo, 42);
  assert.equal(byId.get(ALI).scopes[0].clamped, true);

  // Bobur 60-mavzuda, rejasi 10 dan → 10–50 (ikki tomondan kesilgan)
  assert.equal(byId.get(BOBUR).scopes[0].topicFrom, 10);
  assert.equal(byId.get(BOBUR).scopes[0].topicTo, 50);
  assert.equal(byId.get(BOBUR).scopes[0].clamped, true);

  // Dilnoza 20-mavzuda → 5–20
  assert.equal(byId.get(DILNOZA).scopes[0].topicTo, 20);

  assert.equal(resolved.errors.length, 0, "kesish XATO emas — aynan so'ralgan narsa");
});

test("ORALIQNING boshiga yetmagan bola CHETDA qoladi, boshqalari oladi", async () => {
  resetState();
  const resolved = await scopeService.resolveStudentScopes({
    classId: CLASS_ID,
    blueprint: [
      { subjectId: SUBJ, source: "bank", topicMode: "range", topicFrom: 30, topicTo: 40, easy: 2, medium: 0, hard: 0 },
    ],
    actorId: ADMIN,
  });

  const byId = new Map(resolved.students.map((row) => [row.student.id, row]));

  assert.equal(byId.get(ALI).status, "ready");
  assert.equal(byId.get(BOBUR).status, "ready");

  // Dilnoza 20-mavzuda — 30 dan boshlanadigan oraliqqa yetmagan
  assert.equal(byId.get(DILNOZA).status, "failed");
  assert.match(byId.get(DILNOZA).reason, /hali so'ralgan oraliqning boshiga yetmagan/);
  assert.match(byId.get(DILNOZA).reason, /hozir 20-mavzuda/);
});

test("SINF DARAJASIDAGI to'siq (reja yuklanmagan) hammaga tegadi", async () => {
  resetState();
  state.classReason = "Mavzu biriktirilmagan";
  state.classCurrent = null;

  const resolved = await scopeService.resolveStudentScopes({
    classId: CLASS_ID,
    blueprint: blueprintCurrent(),
    actorId: ADMIN,
  });

  assert.equal(resolved.errors.length, 1, "bu to'siq — kesib bo'lmaydi");
  for (const row of resolved.students) {
    assert.equal(row.status, "failed");
    assert.match(row.reason, /Mavzu biriktirilmagan/);
  }
});

/* ═══════════════════════════════════════════════
   2. QAMROV GURUHLARI — AI bir marta chaqiriladi
   ═══════════════════════════════════════════════ */

test("bir xil qamrovli bolalar BITTA guruh bo'ladi", async () => {
  resetState();
  // Ali va Dilnoza bir xil o'rinda bo'lsin
  state.positions[DILNOZA] = { covered: 42, start: 1, step: 1, inherited: true };

  const plan = await studentTestService.planStudentTest({
    classId: CLASS_ID,
    blueprint: blueprintCurrent("ai"),
    actorId: ADMIN,
  });

  assert.equal(plan.totals.students, 3);
  assert.equal(plan.totals.ready, 3);
  assert.equal(plan.totals.scopeGroups, 2, "Ali+Dilnoza bitta, Bobur ikkinchi");
  assert.equal(plan.totals.questionsPerStudent, 4);
  assert.equal(plan.totals.aiQuestions, 8, "4 savol × 2 guruh (3 bola EMAS)");
  assert.equal(aiCalls.length, 0, "oldindan ko'rish model chaqirmaydi");
});

test("yig'ish: AI qamrov guruhiga BIR MARTA chaqiriladi", async () => {
  resetState();
  state.positions[DILNOZA] = { covered: 42, start: 1, step: 1, inherited: true };

  await studentTestService.buildStudentTest(
    {
      title: "Diagnostika — noyabr",
      classId: CLASS_ID,
      blueprint: blueprintCurrent("ai"),
    },
    ADMIN,
    { canUseAi: true },
  );

  assert.equal(aiCalls.length, 2, "2 qamrov guruhi — 2 chaqiruv (3 bola EMAS)");
  assert.equal(aiCalls[0].language, "uz", "til promptga ketadi");

  // Ali va Dilnoza AYNI savollarni oldi
  const byStudent = new Map();
  for (const link of state.linkRows) {
    if (!byStudent.has(link.studentId)) byStudent.set(link.studentId, []);
    byStudent.get(link.studentId).push(link.questionId);
  }
  assert.deepEqual(byStudent.get(ALI), byStudent.get(DILNOZA));
  assert.notDeepEqual(byStudent.get(ALI), byStudent.get(BOBUR));
});

/* ═══════════════════════════════════════════════
   3. YIG'ISH — qator, muhr, chetda qolganlar
   ═══════════════════════════════════════════════ */

test("yig'ish: bankdan tanlangan savol HAR BOLANING oralig'ida bo'ladi", async () => {
  resetState();
  await studentTestService.buildStudentTest(
    { title: "Bank testi", classId: CLASS_ID, blueprint: blueprintCurrent("bank") },
    ADMIN,
    { canUseAi: false },
  );

  const limits = { [ALI]: 42, [BOBUR]: 60, [DILNOZA]: 20 };
  const starts = { [ALI]: 1, [BOBUR]: 10, [DILNOZA]: 1 };

  for (const link of state.linkRows) {
    const question = BANK.find((q) => q.id === link.questionId);
    assert.ok(question, `savol topildi: ${link.questionId}`);
    assert.ok(
      question.topic.order <= limits[link.studentId],
      `${link.studentId}: ${question.topic.order}-mavzu chegarasidan (${limits[link.studentId]}) oshmaydi`,
    );
    assert.ok(
      question.topic.order >= starts[link.studentId],
      `${link.studentId}: ${question.topic.order}-mavzu rejaning boshidan (${starts[link.studentId]}) oldin emas`,
    );
  }
});

test("yig'ish: qamrovi topilmagan bolaga ham QATOR yoziladi (sababi bilan)", async () => {
  resetState();
  const result = await studentTestService.buildStudentTest(
    {
      title: "Oraliq testi",
      classId: CLASS_ID,
      blueprint: [
        { subjectId: SUBJ, source: "bank", topicMode: "range", topicFrom: 30, topicTo: 40, easy: 2, medium: 0, hard: 0 },
      ],
    },
    ADMIN,
    { canUseAi: false },
  );

  assert.equal(result.totals.ready, 2);
  assert.equal(result.totals.failed, 1);

  const dilnoza = state.studentRows.find((row) => row.studentId === DILNOZA);
  assert.equal(dilnoza.status, "failed");
  assert.equal(dilnoza.questionCount, 0);
  assert.match(dilnoza.reason, /boshiga yetmagan/);
  assert.equal(dilnoza.snapshot.fullName, "Davronova Dilnoza", "ism MUHRLANADI");
});

test("yig'ish: HAL QILINGAN oraliq har o'quvchi qatoriga MUHRLANADI", async () => {
  resetState();
  await studentTestService.buildStudentTest(
    { title: "Muhr", classId: CLASS_ID, blueprint: blueprintCurrent("bank") },
    ADMIN,
    { canUseAi: false },
  );

  const bobur = state.studentRows.find((row) => row.studentId === BOBUR);
  assert.equal(bobur.scope.length, 1);
  assert.equal(bobur.scope[0].topicFrom, 10);
  assert.equal(bobur.scope[0].topicTo, 60);
  assert.equal(bobur.scope[0].step, 3);
  assert.equal(bobur.scope[0].currentTopicAtCreate, 60);
  assert.equal(bobur.scope[0].inherited, false);
});

test("yig'ish: test QORALAMA bo'lib tushadi va `perStudent` bayrog'i yoziladi", async () => {
  resetState();
  await studentTestService.buildStudentTest(
    { title: "Qoralama", classId: CLASS_ID, blueprint: blueprintCurrent("bank") },
    ADMIN,
    { canUseAi: false },
  );

  assert.equal(state.createdTest.status, "draft");
  assert.equal(state.createdTest.perStudent, true);
  assert.equal(state.createdTest.language, "uz");
  assert.equal(state.createdTest.approvedAt, undefined, "tasdiq avtomat qo'yilmaydi");
  assert.equal(state.testRow.approvedAt, null);
});

test("yig'ish: ikki guruh tanlansa RAD ETILADI", async () => {
  resetState();
  await assert.rejects(
    () =>
      studentTestService.buildStudentTest(
        {
          title: "Ikki guruh",
          classIds: [CLASS_ID, id("d")],
          blueprint: blueprintCurrent("bank"),
        },
        ADMIN,
        { canUseAi: false },
      ),
    /aynan bitta guruh/,
  );
});

test("yig'ish: AI ruxsati yo'q bo'lsa model CHAQIRILMAYDI", async () => {
  resetState();
  await assert.rejects(
    () =>
      studentTestService.buildStudentTest(
        { title: "AI", classId: CLASS_ID, blueprint: blueprintCurrent("ai") },
        ADMIN,
        { canUseAi: false },
      ),
    /ruxsat yo'q/,
  );
  assert.equal(aiCalls.length, 0);
});

/* ═══════════════════════════════════════════════
   4. TASDIQLASH
   ═══════════════════════════════════════════════ */

test("tasdiqlash: savollar ham tasdiqlanadi va iz qoladi", async () => {
  resetState();
  await studentTestService.buildStudentTest(
    { title: "Tasdiq", classId: CLASS_ID, blueprint: blueprintCurrent("bank") },
    ADMIN,
    { canUseAi: false },
  );

  const result = await studentTestService.approveTest({
    testId: state.testRow.id,
    actorId: ADMIN,
    note: "Ko'rib chiqdim",
  });

  assert.equal(result.approved, true);
  assert.notEqual(state.testRow.approvedAt, null);
  assert.equal(state.testRow.approvedBy, ADMIN);
  assert.equal(state.testRow.reviewNote, "Ko'rib chiqdim");
});

test("tasdiqlash: ikkinchi marta tasdiqlanmaydi (iz birinchi qarorda qoladi)", async () => {
  resetState();
  await studentTestService.buildStudentTest(
    { title: "Tasdiq", classId: CLASS_ID, blueprint: blueprintCurrent("bank") },
    ADMIN,
    { canUseAi: false },
  );
  await studentTestService.approveTest({ testId: state.testRow.id, actorId: ADMIN });

  await assert.rejects(
    () => studentTestService.approveTest({ testId: state.testRow.id, actorId: ADMIN }),
    /allaqachon tasdiqlangan/,
  );
});

test("rad etish: SABAB majburiy", async () => {
  resetState();
  await studentTestService.buildStudentTest(
    { title: "Rad", classId: CLASS_ID, blueprint: blueprintCurrent("bank") },
    ADMIN,
    { canUseAi: false },
  );

  await assert.rejects(
    () => studentTestService.rejectTest({ testId: state.testRow.id, actorId: ADMIN, note: "" }),
    /sababi yozilishi shart/,
  );

  const result = await studentTestService.rejectTest({
    testId: state.testRow.id,
    actorId: ADMIN,
    note: "3-savol noto'g'ri",
  });
  assert.equal(result.approved, false);
  assert.equal(state.testRow.status, "draft");
  assert.equal(state.testRow.reviewNote, "3-savol noto'g'ri");
});

/* ═══════════════════════════════════════════════
   5. SAVOLNI ALMASHTIRISH
   ═══════════════════════════════════════════════ */

test("almashtirish: BITTA savol — o'rniga AYNI qiyinlik va oraliqdan keladi", async () => {
  resetState();
  await studentTestService.buildStudentTest(
    { title: "Almashtirish", classId: CLASS_ID, blueprint: blueprintCurrent("bank") },
    ADMIN,
    { canUseAi: false },
  );

  const target = state.linkRows.find((row) => row.studentId === DILNOZA);
  const oldQuestion = BANK.find((q) => q.id === target.questionId);

  const result = await studentTestService.regenerateQuestions({
    testId: state.testRow.id,
    items: [{ studentId: DILNOZA, questionId: target.questionId }],
    actorId: ADMIN,
    canUseAi: false,
  });

  assert.equal(result.totals.replaced, 1);
  const replacementId = result.replaced[0].newQuestionId;
  const replacement = BANK.find((q) => q.id === replacementId);

  assert.notEqual(replacementId, target.questionId, "boshqa savol keldi");
  assert.equal(replacement.difficulty, oldQuestion.difficulty, "AYNI qiyinlik");
  assert.ok(replacement.topic.order <= 20, "Dilnozaning oralig'idan chiqmaydi");

  // O'rni saqlanadi
  const newLink = state.linkRows.find((row) => row.questionId === replacementId);
  assert.equal(newLink.position, target.position);
  assert.equal(newLink.studentId, DILNOZA);
});

test("almashtirish: BIR NECHTA tanlangan savol", async () => {
  resetState();
  await studentTestService.buildStudentTest(
    { title: "Ko'p", classId: CLASS_ID, blueprint: blueprintCurrent("bank") },
    ADMIN,
    { canUseAi: false },
  );

  const targets = state.linkRows.filter((row) => row.studentId === ALI).slice(0, 2);
  const result = await studentTestService.regenerateQuestions({
    testId: state.testRow.id,
    items: targets.map((row) => ({ studentId: ALI, questionId: row.questionId })),
    actorId: ADMIN,
    canUseAi: false,
  });

  assert.equal(result.totals.replaced, 2);
  for (const row of targets) {
    assert.equal(
      state.linkRows.some((link) => link.questionId === row.questionId && link.studentId === ALI),
      false,
      "eski savol to'plamdan chiqdi",
    );
  }
});

test("almashtirish: HAMMASI — ro'yxat serverda qayta olinadi", async () => {
  resetState();
  await studentTestService.buildStudentTest(
    { title: "Hammasi", classId: CLASS_ID, blueprint: blueprintCurrent("bank") },
    ADMIN,
    { canUseAi: false },
  );

  const before = state.linkRows.map((row) => `${row.studentId}|${row.questionId}`);
  const result = await studentTestService.regenerateQuestions({
    testId: state.testRow.id,
    all: true,
    actorId: ADMIN,
    canUseAi: false,
  });

  assert.equal(result.totals.requested, before.length);
  assert.equal(result.totals.replaced, before.length);
  const after = state.linkRows.map((row) => `${row.studentId}|${row.questionId}`);
  assert.equal(
    after.some((key) => before.includes(key)),
    false,
    "birorta eski savol qolmadi",
  );
});

test("almashtirish: bankda savol tugasa O'Z JOYIDA qoladi (xato emas)", async () => {
  resetState();
  await studentTestService.buildStudentTest(
    { title: "Tugadi", classId: CLASS_ID, blueprint: blueprintCurrent("bank") },
    ADMIN,
    { canUseAi: false },
  );

  state.bankExhausted = true;
  const target = state.linkRows[0];

  const result = await studentTestService.regenerateQuestions({
    testId: state.testRow.id,
    items: [{ studentId: target.studentId, questionId: target.questionId }],
    actorId: ADMIN,
    canUseAi: false,
  });

  assert.equal(result.totals.replaced, 0);
  assert.equal(result.totals.skipped, 1);
  assert.match(result.skipped[0].reason, /boshqa savol qolmadi/);
  assert.ok(
    state.linkRows.some((row) => row.questionId === target.questionId),
    "savol to'plamda qoldi",
  );
});

test("almashtirish: TASDIQLANGAN testga tegilmaydi", async () => {
  resetState();
  await studentTestService.buildStudentTest(
    { title: "Tasdiqlangan", classId: CLASS_ID, blueprint: blueprintCurrent("bank") },
    ADMIN,
    { canUseAi: false },
  );
  await studentTestService.approveTest({ testId: state.testRow.id, actorId: ADMIN });

  await assert.rejects(
    () =>
      studentTestService.regenerateQuestions({
        testId: state.testRow.id,
        all: true,
        actorId: ADMIN,
        canUseAi: false,
      }),
    /avval tasdiqni bekor qiling/,
  );
});

test("almashtirish: URINISHI BOR testga tegilmaydi", async () => {
  resetState();
  await studentTestService.buildStudentTest(
    { title: "Urinish", classId: CLASS_ID, blueprint: blueprintCurrent("bank") },
    ADMIN,
    { canUseAi: false },
  );
  state.testRow._count.attempts = 3;

  await assert.rejects(
    () =>
      studentTestService.regenerateQuestions({
        testId: state.testRow.id,
        all: true,
        actorId: ADMIN,
        canUseAi: false,
      }),
    /3 ta urinish bor/,
  );
});

/* ═══════════════════════════════════════════════
   6. O'QUVCHI TOMONI
   ═══════════════════════════════════════════════ */

test("o'quvchi: o'z to'plamini oladi, boshqasining to'plamini OLMAYDI", async () => {
  resetState();
  await studentTestService.buildStudentTest(
    { title: "To'plam", classId: CLASS_ID, blueprint: blueprintCurrent("bank") },
    ADMIN,
    { canUseAi: false },
  );

  const set = await studentTestService.studentQuestionSet(state.testRow.id, DILNOZA);
  assert.equal(set.status, "ready");
  assert.equal(set.questionIds.length, 4);

  // Hammasi Dilnozaning oralig'ida
  for (const questionId of set.questionIds) {
    const question = BANK.find((q) => q.id === questionId);
    assert.ok(question.topic.order <= 20);
  }
});

test("o'quvchi: qamrovi topilmagan bolaga SABAB qaytadi, savol emas", async () => {
  resetState();
  await studentTestService.buildStudentTest(
    {
      title: "Chetda",
      classId: CLASS_ID,
      blueprint: [
        { subjectId: SUBJ, source: "bank", topicMode: "range", topicFrom: 30, topicTo: 40, easy: 2, medium: 0, hard: 0 },
      ],
    },
    ADMIN,
    { canUseAi: false },
  );

  const set = await studentTestService.studentQuestionSet(state.testRow.id, DILNOZA);
  assert.equal(set.status, "failed");
  assert.equal(set.questionIds.length, 0);
  assert.match(set.reason, /boshiga yetmagan/);
});
