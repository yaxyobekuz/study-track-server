const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * DIAGNOSTIKA — MAVZU QAMROVI BILAN AI TEST YARATISH.
 *
 * Bu faylda ushlab turiladigan asosiy qoida BITTA:
 *
 *     Testga FAQAT sinf ALLAQACHON O'TGAN mavzulardan savol tushadi.
 *     Sinf 100-mavzuda bo'lsa — 100 to'g'ri, 101 XATO.
 *
 * Qolgan tekshiruvlar shu qoidani himoya qiladi: taqsimot validatsiyasi,
 * AI javobini filtrlash (mavzudan chiqqan va javob kaliti noaniq savol
 * TASHLANADI, tuzatilmaydi), bankdan tanlashda mavzu filtri va
 * tasdiqlanmagan savol nashrni to'sishi.
 *
 * Servislar HAQIQIY kodi, baza va model soxta.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const CLASS_ID = "c".repeat(24);
const SUBJ_MATH = "m".repeat(24);
const SUBJ_ENG = "e".repeat(24);
const ADMIN = "a".repeat(24);

/** Mavzular: matematikada 120 ta, ingliz tilida 40 ta. */
const topicsFor = (subjectId, count) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${subjectId.slice(0, 3)}t${String(i + 1).padStart(4, "0")}`.padEnd(24, "0"),
    subjectId,
    order: i + 1,
    name: `Mavzu ${i + 1}`,
    description: null,
    level: null,
    book: null,
  }));

const TOPICS = {
  [SUBJ_MATH]: topicsFor(SUBJ_MATH, 120),
  [SUBJ_ENG]: topicsFor(SUBJ_ENG, 40),
};

/** Bankdagi savollar — har biri mavzuga bog'langan. */
const makeBankQuestion = (subjectId, order, difficulty, n) => ({
  id: `q${subjectId.slice(0, 2)}${order}${difficulty}${n}`.padEnd(24, "0"),
  subjectId,
  topicId: TOPICS[subjectId][order - 1].id,
  difficulty,
  grade: null,
  status: "approved",
  type: "single",
  language: "uz",
  text: `${subjectId.slice(0, 2)} ${order} ${difficulty} ${n}`,
  usageCount: 0,
  createdAt: new Date(2026, 0, 1),
});

const BANK = [];
// Matematika: 1–50 mavzulardan har darajada 2 ta savol
for (let order = 1; order <= 50; order += 1) {
  for (const difficulty of ["easy", "medium", "hard"]) {
    for (let n = 1; n <= 2; n += 1) {
      BANK.push(makeBankQuestion(SUBJ_MATH, order, difficulty, n));
    }
  }
}
// 110-mavzudan ham savol bor — u O'TILMAGAN va testga TUSHMASLIGI kerak
BANK.push(makeBankQuestion(SUBJ_MATH, 110, "easy", 1));

/* ── Soxta baza ─────────────────────────────── */

const state = {
  /** Sinfning joriy mavzusi, fan bo'yicha. */
  current: { [SUBJ_MATH]: 42, [SUBJ_ENG]: 12 },
  /** `getSubjectClassTopics` qaytaradigan sabab (joriy mavzu yo'q bo'lsa). */
  reason: { [SUBJ_MATH]: null, [SUBJ_ENG]: null },
  createdQuestions: [],
  createdTest: null,
  pinnedStatuses: null,
};

const matchTopicWhere = (question, where) => {
  if (where.subjectId && question.subjectId !== where.subjectId) return false;
  if (where.status && question.status !== where.status) return false;
  if (where.type?.not && question.type === where.type.not) return false;
  if (where.language && question.language !== where.language) return false;
  if (where.grade !== undefined && question.grade !== where.grade) return false;
  if (where.difficulty?.in && !where.difficulty.in.includes(question.difficulty)) return false;
  if (where.topicId?.in && !where.topicId.in.includes(question.topicId)) return false;
  return true;
};

const prismaStub = {
  class: {
    findUnique: async ({ where }) =>
      where.id === CLASS_ID ? { id: CLASS_ID, name: "7-A" } : null,
    findMany: async ({ where }) => {
      const ids = where?.id?.in ?? [CLASS_ID];
      return ids.filter((id) => id === CLASS_ID).map((id) => ({ id, name: "7-A" }));
    },
  },
  subject: {
    findMany: async ({ where }) => {
      const names = { [SUBJ_MATH]: "Matematika", [SUBJ_ENG]: "Ingliz tili" };
      const ids = where?.id?.in ?? Object.keys(names);
      return ids.filter((id) => names[id]).map((id) => ({ id, name: names[id] }));
    },
    findUnique: async ({ where }) =>
      TOPICS[where.id] ? { id: where.id, name: "Fan" } : null,
  },
  topic: {
    findMany: async ({ where }) => TOPICS[where.subjectId] ?? [],
  },
  diagnosticQuestion: {
    count: async ({ where }) => BANK.filter((q) => matchTopicWhere(q, where)).length,
    findMany: async ({ where, take }) => {
      const rows = BANK.filter((q) => matchTopicWhere(q, where));
      return (take ? rows.slice(0, take) : rows).map((q) => ({ id: q.id, text: q.text }));
    },
    create: async ({ data }) => {
      state.createdQuestions.push(data);
      return {
        id: `gen${state.createdQuestions.length}`.padEnd(24, "0"),
        code: data.code,
        subjectId: data.subjectId,
        topicId: data.topicId,
        difficulty: data.difficulty,
      };
    },
    findFirst: async () => ({ code: "D-000500" }),
  },
  diagnosticTest: {
    create: async ({ data }) => {
      state.createdTest = data;
      return {
        id: "test".padEnd(24, "0"),
        ...data,
        classes: [{ class: { id: CLASS_ID, name: "7-A" } }],
        _count: { questions: data.questions.create.length, attempts: 0 },
      };
    },
    findUnique: async () => state.testRow ?? null,
    update: async () => ({}),
  },
  diagnosticTestQuestion: {
    findMany: async () =>
      (state.pinnedStatuses ?? []).map((status, index) => ({
        question: { id: `pin${index}`, code: `D-00010${index}`, status },
      })),
    count: async () => (state.pinnedStatuses ?? []).length,
  },
  scheduleLesson: { findMany: async () => [] },
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
          totalTopics: (TOPICS[subjectId] ?? []).length,
          byClass: new Map(
            state.current[subjectId] === undefined
              ? []
              : [
                  [
                    CLASS_ID,
                    {
                      className: "7-A",
                      currentTopicNumber: state.current[subjectId],
                      // ⚠️ HAQIQIY SERVIS BILAN AYNI: joriy mavzu
                      // bo'lmasa nomi ham `null` bo'ladi
                      // (`getSubjectClassTopics`).
                      currentTopicName:
                        state.current[subjectId] == null
                          ? null
                          : `Mavzu ${state.current[subjectId]}`,
                      reason: state.reason[subjectId],
                      nextLesson: null,
                    },
                  ],
                ],
          ),
        },
      ]),
    ),
});

/** AI — soxta model: so'ralgan sonicha savol "yozadi". */
const aiCalls = [];
let aiEnabledFlag = true;
let aiYieldRatio = 1;

fakeModule("../src/services/diagnosticAiQuestion.service", {
  MAX_REQUESTS_PER_BUILD: 30,
  isEnabled: async () => aiEnabledFlag,
  assertEnabled: async () => {
    if (!aiEnabledFlag) throw new Error("AI o'chirilgan");
  },
  generateForRow: async ({ subject, grade, topics, counts }) => {
    aiCalls.push({ subjectId: subject.id, topics: topics.map((t) => t.order), counts });
    const items = [];
    for (const [key, want] of Object.entries(counts)) {
      const produce = Math.round(want * aiYieldRatio);
      for (let i = 0; i < produce; i += 1) {
        const topic = topics[i % topics.length];
        items.push({
          subjectId: subject.id,
          topicId: topic.id,
          topicOrder: topic.order,
          grade: grade ?? null,
          language: "uz",
          text: `AI ${subject.id.slice(0, 2)} ${key} ${i}`,
          type: "single",
          difficulty: key,
          explanation: "izoh",
          options: [
            { text: "a", isCorrect: true, position: 0 },
            { text: "b", isCorrect: false, position: 1 },
            { text: "c", isCorrect: false, position: 2 },
            { text: "d", isCorrect: false, position: 3 },
          ],
        });
      }
    }
    return { items, warnings: [], requests: 1 };
  },
});

const savedQuestions = [];
fakeModule("../src/services/diagnosticQuestion.service", {
  createGeneratedQuestions: async (items) => {
    savedQuestions.push(...items);
    return {
      created: items.map((item, index) => ({
        id: `ai${savedQuestions.length - items.length + index}`.padEnd(24, "0"),
        code: `D-0009${index}`,
      })),
      duplicates: 0,
      failed: 0,
      errors: [],
    };
  },
  approveQuestions: async (ids) => ({ approved: ids.length, skipped: [] }),
});

/* ── Sinaladigan modullar ───────────────────── */

const blueprint = require("../src/helpers/diagnosticBlueprint.helpers");
const topicScope = require("../src/services/diagnosticTopicScope.service");
const testService = require("../src/services/diagnosticTest.service");

const row = (over = {}) => ({
  subjectId: SUBJ_MATH,
  source: "bank",
  topicMode: "current",
  easy: 2,
  medium: 2,
  hard: 2,
  ...over,
});

const resetState = () => {
  state.current = { [SUBJ_MATH]: 42, [SUBJ_ENG]: 12 };
  state.reason = { [SUBJ_MATH]: null, [SUBJ_ENG]: null };
  state.createdQuestions = [];
  state.createdTest = null;
  state.pinnedStatuses = null;
  state.testRow = null;
  aiCalls.length = 0;
  savedQuestions.length = 0;
  aiEnabledFlag = true;
  aiYieldRatio = 1;
};

// ═══════════════════════════════════════════════
// 1. TAQSIMOT VALIDATSIYASI
// ═══════════════════════════════════════════════

test("taqsimot: qamrov majburiy, yaroqsiz qator xato", () => {
  assert.throws(
    () => blueprint.parseBlueprint([{ subjectId: SUBJ_MATH, easy: 3 }]),
    /mavzu qamrovi tanlanmagan/,
  );
  assert.throws(
    () => blueprint.parseBlueprint([{ subjectId: "", easy: 3, topicMode: "current" }]),
    /fan tanlanmagan/,
  );
  assert.throws(
    () => blueprint.parseBlueprint([row({ easy: 0, medium: 0, hard: 0 })]),
    /bitta darajada savol soni/,
  );
});

test("taqsimot: oraliqning boshi oxiridan katta bo'lmaydi", () => {
  assert.throws(
    () =>
      blueprint.parseBlueprint([
        row({ topicMode: "range", topicFrom: 30, topicTo: 10 }),
      ]),
    /boshi oxiridan katta/,
  );
});

test("taqsimot: eski yo'l yaroqsiz qatorni TASHLAYDI, xato otmaydi", () => {
  const parsed = blueprint.parseBlueprint(
    [{ subjectId: "", easy: 0 }, { subjectId: SUBJ_MATH, easy: 5 }],
    { legacy: true },
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].topicMode, null, "eski yo'lda qamrov bo'lmaydi");
});

test("taqsimot: jami 100 savoldan oshmaydi", () => {
  assert.throws(
    () =>
      blueprint.parseBlueprint(
        Array.from({ length: 11 }, () => row({ easy: 10, medium: 0, hard: 0 })),
      ),
    /100 tadan ko'p savol bo'lmaydi/,
  );
});

// ═══════════════════════════════════════════════
// 2. ASOSIY QOIDA — KELGAN MAVZUDAN O'TIB KETMASLIK
// ═══════════════════════════════════════════════

test("qoida: joriy mavzuga TENG oraliq qabul qilinadi (42 → to'g'ri)", async () => {
  resetState();
  const rows = blueprint.parseBlueprint([
    row({ topicMode: "range", topicFrom: 1, topicTo: 42 }),
  ]);
  const { scopes, errors } = await topicScope.resolveScopes({
    classId: CLASS_ID,
    blueprint: rows,
    actorId: ADMIN,
  });

  assert.deepEqual(errors, []);
  assert.equal(scopes[0].topicTo, 42);
  assert.equal(scopes[0].topics.length, 42);
  assert.equal(scopes[0].currentTopicNumber, 42);
});

test("qoida: joriy mavzudan BITTA oshgan oraliq RAD ETILADI (43 → xato)", async () => {
  resetState();
  const rows = blueprint.parseBlueprint([
    row({ topicMode: "range", topicFrom: 1, topicTo: 43 }),
  ]);
  const { errors, scopes } = await topicScope.resolveScopes({
    classId: CLASS_ID,
    blueprint: rows,
    actorId: ADMIN,
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /42-mavzuda/);
  assert.match(errors[0].message, /43-mavzu hali o'tilmagan/);
  assert.equal(scopes[0].topicIds, null, "qamrov hal qilinmaydi");
});

test("qoida: \"hozirgi mavzugacha\" chegarani O'ZI joriy mavzudan oladi", async () => {
  resetState();
  state.current[SUBJ_MATH] = 7;
  const rows = blueprint.parseBlueprint([row({ topicMode: "current" })]);
  const { scopes, errors } = await topicScope.resolveScopes({
    classId: CLASS_ID,
    blueprint: rows,
    actorId: ADMIN,
  });

  assert.deepEqual(errors, []);
  assert.equal(scopes[0].topicFrom, 1);
  assert.equal(scopes[0].topicTo, 7);
  assert.equal(scopes[0].topics.length, 7);
});

test("qoida: joriy mavzu aniqlanmasa SABABI qaytadi, test tuzilmaydi", async () => {
  resetState();
  state.current[SUBJ_MATH] = null;
  state.reason[SUBJ_MATH] = "Sinfga mavzu biriktirilmagan";
  const rows = blueprint.parseBlueprint([row({ topicMode: "current" })]);
  const { errors } = await topicScope.resolveScopes({
    classId: CLASS_ID,
    blueprint: rows,
    actorId: ADMIN,
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Sinfga mavzu biriktirilmagan/);
});

test("qoida: MAVZULAR TUGAGAN bo'lsa chegara OXIRGI mavzu bo'ladi", async () => {
  resetState();
  // Sinf rejani oxirigacha o'tgan: mavzu hisobi "joriy mavzu" bermaydi,
  // lekin bu TO'SIQ emas — hamma mavzu o'tilgan.
  state.current[SUBJ_ENG] = null;
  state.reason[SUBJ_ENG] = "Mavzular tugagan";

  const rows = blueprint.parseBlueprint([
    row({ subjectId: SUBJ_ENG, topicMode: "current" }),
  ]);
  const { scopes, errors } = await topicScope.resolveScopes({
    classId: CLASS_ID,
    blueprint: rows,
    actorId: ADMIN,
  });

  assert.deepEqual(errors, [], "to'siq bo'lmasligi kerak");
  assert.equal(scopes[0].topicsExhausted, true);
  assert.equal(scopes[0].currentTopicNumber, 40, "fandagi oxirgi mavzu");
  assert.equal(scopes[0].topicTo, 40);
  assert.equal(scopes[0].topics.length, 40);
  assert.equal(scopes[0].currentTopicName, "Mavzu 40");
});

test("qoida: mavzular tugaganda ham OXIRGIDAN oshib bo'lmaydi", async () => {
  resetState();
  state.current[SUBJ_ENG] = null;
  state.reason[SUBJ_ENG] = "Mavzular tugagan";

  const rows = blueprint.parseBlueprint([
    row({ subjectId: SUBJ_ENG, topicMode: "range", topicFrom: 1, topicTo: 41 }),
  ]);
  const { errors } = await topicScope.resolveScopes({
    classId: CLASS_ID,
    blueprint: rows,
    actorId: ADMIN,
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /41-mavzu hali o'tilmagan/);
});

test("qoida: \"mavzu biriktirilmagan\" esa TO'SIQ bo'lib qoladi", async () => {
  resetState();
  state.current[SUBJ_MATH] = null;
  state.reason[SUBJ_MATH] = "Mavzu biriktirilmagan";

  const rows = blueprint.parseBlueprint([row({ topicMode: "current" })]);
  const { errors, scopes } = await topicScope.resolveScopes({
    classId: CLASS_ID,
    blueprint: rows,
    actorId: ADMIN,
  });

  assert.equal(errors.length, 1, "sinf qayerda turgani noma'lum — to'siq");
  assert.match(errors[0].message, /Mavzu biriktirilmagan/);
  assert.equal(scopes[0].topicsExhausted, false);
});

test("qoida: sinfda bu fandan dars bo'lmasa sababi aytiladi", async () => {
  resetState();
  delete state.current[SUBJ_ENG];
  const rows = blueprint.parseBlueprint([
    row({ subjectId: SUBJ_ENG, topicMode: "current" }),
  ]);
  const { errors } = await topicScope.resolveScopes({
    classId: CLASS_ID,
    blueprint: rows,
    actorId: ADMIN,
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /bu fandan dars yo'q/);
});

test("qoida: bir nechta fanning muammosi BIRGA qaytadi", async () => {
  resetState();
  const rows = blueprint.parseBlueprint([
    row({ topicMode: "range", topicFrom: 1, topicTo: 90 }),
    row({ subjectId: SUBJ_ENG, topicMode: "range", topicFrom: 1, topicTo: 30 }),
  ]);
  const { errors } = await topicScope.resolveScopes({
    classId: CLASS_ID,
    blueprint: rows,
    actorId: ADMIN,
  });
  assert.equal(errors.length, 2, "ikkinchisida to'xtab qolmaydi");
});

// ═══════════════════════════════════════════════
// 3. BANKDAN TANLASH — MAVZU FILTRI
// ═══════════════════════════════════════════════

test("bank: qamrovdan TASHQARIDAGI savol tanlanmaydi", async () => {
  resetState();
  const rows = blueprint.parseBlueprint([
    row({ topicMode: "current", easy: 20, medium: 0, hard: 0 }),
  ]);
  const { scopes } = await topicScope.resolveScopes({
    classId: CLASS_ID,
    blueprint: rows,
    actorId: ADMIN,
  });

  const result = await testService.selectByBlueprint(rows, { scopes });
  const allowed = new Set(scopes[0].topicIds);
  const picked = BANK.filter((q) => result.questionIds.includes(q.id));

  assert.ok(picked.length > 0);
  for (const question of picked) {
    assert.ok(allowed.has(question.topicId), `${question.text} qamrovdan tashqarida`);
    assert.ok(question.topicId !== TOPICS[SUBJ_MATH][109].id, "110-mavzu tushmasligi kerak");
  }
});

test("bank: yetmaganini to'ldirish ham qamrovdan CHIQMAYDI", async () => {
  resetState();
  // 1–3 mavzuda jami 18 savol bor; 40 ta so'raymiz.
  const rows = blueprint.parseBlueprint([
    row({ topicMode: "range", topicFrom: 1, topicTo: 3, easy: 40, medium: 0, hard: 0 }),
  ]);
  const { scopes } = await topicScope.resolveScopes({
    classId: CLASS_ID,
    blueprint: rows,
    actorId: ADMIN,
  });

  const result = await testService.selectByBlueprint(rows, { scopes });
  const allowed = new Set(scopes[0].topicIds);
  const picked = BANK.filter((q) => result.questionIds.includes(q.id));

  assert.equal(picked.length, 18, "1–3 mavzuda bor-yo'g'i 18 savol");
  for (const question of picked) {
    assert.ok(allowed.has(question.topicId));
  }
  assert.equal(result.warnings.length, 1, "yetmagani ogohlantirishda aytiladi");
  assert.match(result.warnings[0], /1–3-mavzu/);
});

test("bank: qator kesimida nechta savol borligi daraja bo'yicha sanaladi", async () => {
  resetState();
  const rows = blueprint.parseBlueprint([
    row({ topicMode: "range", topicFrom: 1, topicTo: 5, easy: 3, medium: 3, hard: 3 }),
  ]);
  const { scopes } = await topicScope.resolveScopes({
    classId: CLASS_ID,
    blueprint: rows,
    actorId: ADMIN,
  });

  const counted = await testService.countBankForRow(rows[0], scopes[0]);
  assert.equal(counted.levels.easy.available, 10);
  assert.equal(counted.levels.medium.available, 10);
  assert.equal(counted.levels.hard.available, 10);
  assert.equal(counted.availableTotal, 30);
  assert.equal(counted.shortfall, 0);
});

// ═══════════════════════════════════════════════
// 4. TEST YIG'ISH (bank + AI)
// ═══════════════════════════════════════════════

const buildPayload = (rows) => ({
  title: "Daraja testi",
  mode: "timed",
  durationMin: 45,
  classIds: [CLASS_ID],
  blueprint: rows,
});

test("yig'ish: AI qatori bankka YOZILADI va testga biriktiriladi", async () => {
  resetState();
  state.pinnedStatuses = ["review", "review", "review", "review"];

  const result = await testService.buildTest(
    buildPayload([
      row({ source: "ai", topicMode: "current", easy: 2, medium: 2, hard: 0 }),
    ]),
    ADMIN,
    { canUseAi: true },
  );

  assert.equal(aiCalls.length, 1);
  assert.equal(savedQuestions.length, 4, "4 ta savol bankka yozildi");
  assert.equal(result.generated.requested, 4);
  assert.equal(result.generated.written, 4);
  assert.equal(result.status, "draft", "AI testi QORALAMA bo'lib yaratiladi");
  assert.equal(result.pendingApproval, 4, "savollar tasdiqlanishi kerak");
});

test("yig'ish: AI faqat QAMROVDAGI mavzularni oladi", async () => {
  resetState();
  state.current[SUBJ_MATH] = 9;
  state.pinnedStatuses = ["review", "review", "review"];

  await testService.buildTest(
    buildPayload([
      row({ source: "ai", topicMode: "current", easy: 3, medium: 0, hard: 0 }),
    ]),
    ADMIN,
    { canUseAi: true },
  );

  assert.equal(aiCalls.length, 1);
  assert.ok(Math.max(...aiCalls[0].topics) <= 9, "9-mavzudan oshmaydi");
  assert.ok(Math.min(...aiCalls[0].topics) >= 1);
});

test("yig'ish: bank va AI qatorlari ARALASH ishlaydi", async () => {
  resetState();
  state.pinnedStatuses = Array(10).fill("approved").concat(["review", "review"]);

  const result = await testService.buildTest(
    buildPayload([
      row({ topicMode: "current", easy: 5, medium: 5, hard: 0 }),
      row({ source: "ai", topicMode: "current", easy: 2, medium: 0, hard: 0 }),
    ]),
    ADMIN,
    { canUseAi: true },
  );

  assert.equal(savedQuestions.length, 2, "faqat AI qatori yozildi");
  assert.equal(state.createdTest.questions.create.length, 12);
  assert.equal(result.questionCount, 12, "savollar soni TANLANGANIGA tenglashadi");
});

test("yig'ish: qamrov buzilgan bo'lsa HECH NARSA yozilmaydi", async () => {
  resetState();
  await assert.rejects(
    () =>
      testService.buildTest(
        buildPayload([row({ topicMode: "range", topicFrom: 1, topicTo: 80 })]),
        ADMIN,
        { canUseAi: true },
      ),
    /hali o'tilmagan/,
  );
  assert.equal(state.createdTest, null);
  assert.equal(savedQuestions.length, 0, "model umuman chaqirilmaydi");
  assert.equal(aiCalls.length, 0);
});

test("yig'ish: AI ruxsati yo'q bo'lsa model chaqirilmaydi", async () => {
  resetState();
  await assert.rejects(
    () =>
      testService.buildTest(
        buildPayload([row({ source: "ai", topicMode: "current" })]),
        ADMIN,
        { canUseAi: false },
      ),
    /ruxsat yo'q/,
  );
  assert.equal(aiCalls.length, 0);
  assert.equal(state.createdTest, null);
});

test("yig'ish: faqat BANK qatori AI ruxsatisiz ham o'tadi", async () => {
  resetState();
  state.pinnedStatuses = Array(6).fill("approved");

  const result = await testService.buildTest(
    buildPayload([row({ topicMode: "current" })]),
    ADMIN,
    { canUseAi: false },
  );
  assert.equal(result.pendingApproval, 0);
  assert.equal(aiCalls.length, 0);
});

test("yig'ish: ikki sinf tanlansa RAD ETILADI (joriy mavzu har sinfda boshqa)", async () => {
  resetState();
  await assert.rejects(
    () =>
      testService.buildTest(
        { ...buildPayload([row({ topicMode: "current" })]), classIds: [] },
        ADMIN,
        { canUseAi: true },
      ),
    /bitta sinf uchun/,
  );
});

test("yig'ish: hal qilingan oraliq va joriy mavzu MUHRLANADI", async () => {
  resetState();
  state.current[SUBJ_MATH] = 42;
  state.pinnedStatuses = Array(6).fill("approved");

  await testService.buildTest(
    buildPayload([row({ topicMode: "current" })]),
    ADMIN,
    { canUseAi: false },
  );

  const stored = state.createdTest.blueprint[0];
  assert.equal(stored.topicFrom, 1);
  assert.equal(stored.topicTo, 42);
  assert.equal(stored.currentTopicAtCreate, 42);
  assert.equal(stored.source, "bank");
  assert.equal(stored.selected, 6);
});

test("yig'ish: birorta savol topilmasa test yaratilmaydi", async () => {
  resetState();
  aiYieldRatio = 0;
  await assert.rejects(
    () =>
      testService.buildTest(
        buildPayload([row({ source: "ai", topicMode: "current" })]),
        ADMIN,
        { canUseAi: true },
      ),
    /Birorta savol topilmadi/,
  );
  assert.equal(state.createdTest, null);
});

test("yig'ish: nomi xato bo'lsa model CHAQIRILMAYDI (pul sarflanmaydi)", async () => {
  resetState();
  await assert.rejects(
    () =>
      testService.buildTest(
        {
          ...buildPayload([row({ source: "ai", topicMode: "current" })]),
          title: "x",
        },
        ADMIN,
        { canUseAi: true },
      ),
    /Test nomi/,
  );
  assert.equal(aiCalls.length, 0, "validatsiya generatsiyadan OLDIN");
  assert.equal(savedQuestions.length, 0);
});

// ═══════════════════════════════════════════════
// 5. NASHR DARVOZASI
// ═══════════════════════════════════════════════

test("nashr: tasdiqlanmagan savol bo'lsa test ochilmaydi", async () => {
  resetState();
  state.pinnedStatuses = ["approved", "review", "approved"];
  state.testRow = {
    id: "test".padEnd(24, "0"),
    status: "draft",
    questionCount: 3,
    availableFrom: null,
    publishedAt: null,
    // Test TASDIQLANGAN — darvozaning bu qadami o'tgan, lekin savollar
    // hali ko'rikdan o'tmagan (ikki darvoza alohida tekshiriladi).
    approvedAt: new Date("2026-11-12T08:00:00Z"),
  };

  const availability = await testService.checkAvailability(state.testRow);
  assert.equal(availability.pendingApproval, 1);
  assert.equal(availability.enough, false);

  await assert.rejects(
    () => testService.updateTestStatus(state.testRow.id, "active"),
    /savol hali tasdiqlanmagan/,
  );
});

test("nashr: TASDIQLANMAGAN TEST chiqarilmaydi (savollari tayyor bo'lsa ham)", async () => {
  resetState();
  state.pinnedStatuses = ["approved", "approved"];
  state.testRow = {
    id: "test".padEnd(24, "0"),
    status: "draft",
    questionCount: 2,
    availableFrom: null,
    publishedAt: null,
    // ⚠️ Tasdiq YO'Q: "filial egasi ko'rib chiqadi, tasdiqlasa keyin
    // chiqariladi" (2026-11-12). Savollar tayyor bo'lsa ham darvoza yopiq.
    approvedAt: null,
  };

  await assert.rejects(
    () => testService.updateTestStatus(state.testRow.id, "active"),
    /Test hali tasdiqlanmagan/,
  );
});

test("nashr: hammasi tasdiqlangan bo'lsa darvoza ochiq", async () => {
  resetState();
  state.pinnedStatuses = ["approved", "approved"];
  state.testRow = {
    id: "test".padEnd(24, "0"),
    status: "draft",
    questionCount: 2,
    availableFrom: null,
    publishedAt: null,
    approvedAt: new Date("2026-11-12T08:00:00Z"),
  };

  const availability = await testService.checkAvailability(state.testRow);
  assert.equal(availability.pendingApproval, 0);
  assert.equal(availability.enough, true);
});

// ═══════════════════════════════════════════════
// 6. REJA (oldindan ko'rish) — HECH NARSA YOZMAYDI
// ═══════════════════════════════════════════════

test("reja: bank va AI kesimi hisoblanadi, baza o'zgarmaydi", async () => {
  resetState();
  const plan = await testService.planTest({
    classId: CLASS_ID,
    actorId: ADMIN,
    blueprint: [
      row({ topicMode: "current", easy: 4, medium: 4, hard: 0 }),
      row({ source: "ai", topicMode: "range", topicFrom: 5, topicTo: 10, easy: 3, medium: 0, hard: 0 }),
    ],
  });

  assert.equal(plan.canBuild, true);
  assert.equal(plan.rows[0].bank.availableTotal > 0, true);
  assert.equal(plan.rows[0].needsAi, 0);
  assert.equal(plan.rows[1].needsAi, 3);
  assert.equal(plan.rows[1].bank, null);
  assert.equal(plan.totals.needsAi, 3);
  assert.equal(plan.rows[0].currentTopicNumber, 42);
  assert.equal(state.createdTest, null);
  assert.equal(savedQuestions.length, 0);
});

test("reja: qamrov buzilsa canBuild false va sababi ko'rinadi", async () => {
  resetState();
  const plan = await testService.planTest({
    classId: CLASS_ID,
    actorId: ADMIN,
    blueprint: [row({ topicMode: "range", topicFrom: 1, topicTo: 99 })],
  });

  assert.equal(plan.canBuild, false);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.rows[0].reason, /hali o'tilmagan/);
});

test("reja: AI o'chirilgan bo'lsa AI qatori tayyor emas", async () => {
  resetState();
  aiEnabledFlag = false;
  const plan = await testService.planTest({
    classId: CLASS_ID,
    actorId: ADMIN,
    blueprint: [row({ source: "ai", topicMode: "current" })],
  });

  assert.equal(plan.aiEnabled, false);
  assert.equal(plan.canBuild, false);
  assert.match(plan.rows[0].reason, /AI o'chirilgan/);
});
