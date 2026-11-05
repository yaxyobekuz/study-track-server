const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * DIAGNOSTIKA — O'QITUVCHILAR KESIMI (eski va joriy davr farqi).
 *
 * Bog'lanish: urinish → (SINF suratdan, FAN muhrlangan savoldan) →
 * o'qituvchi (dars jadvalidan). Shu faylda qotirilgan qoidalar:
 *
 *   • har qatorda joriy davr, o'tgan davr va FARQ (punktda) bo'ladi;
 *   • bir sinfga bir fandan ikki o'qituvchi dars bersa, natija
 *     IKKALASIDA ham sanaladi (ikkalasi ham javobgar);
 *   • urinishi yo'q o'qituvchi ham ro'yxatda qoladi (`untested`);
 *   • o'qituvchisi topilmagan urinishlar JIM QOLMAYDI (`unassigned`).
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const CLASS_A = "a".repeat(24);
const CLASS_B = "b".repeat(24);
const SUBJ_MATH = "m".repeat(24);
const SUBJ_ENG = "e".repeat(24);
const T_MATH1 = "1".repeat(24);
const T_MATH2 = "2".repeat(24);
const T_ENG = "3".repeat(24);
const T_IDLE = "4".repeat(24);

const CLASSES = [
  { id: CLASS_A, name: "7-A" },
  { id: CLASS_B, name: "7-B" },
];

const SUBJECTS = [
  { id: SUBJ_MATH, name: "Matematika" },
  { id: SUBJ_ENG, name: "Ingliz tili" },
];

/**
 * Jadval: 7-A matematikani IKKI o'qituvchi o'tadi, 7-A ingliz tilini
 * bittasi, 7-B ni esa faqat T_IDLE (diagnostika ishlanmagan sinf).
 */
const LESSONS = [
  { subjectId: SUBJ_MATH, teacherId: T_MATH1, schedule: { classId: CLASS_A } },
  { subjectId: SUBJ_MATH, teacherId: T_MATH1, schedule: { classId: CLASS_A } },
  { subjectId: SUBJ_MATH, teacherId: T_MATH2, schedule: { classId: CLASS_A } },
  { subjectId: SUBJ_ENG, teacherId: T_ENG, schedule: { classId: CLASS_A } },
  { subjectId: SUBJ_MATH, teacherId: T_IDLE, schedule: { classId: CLASS_B } },
];

const STAFF = [
  { id: T_MATH1, firstName: "Dildora", lastName: "Nurmatova", username: "dildora", isArchived: false },
  { id: T_MATH2, firstName: "Sardor", lastName: "Qosimov", username: "sardor", isArchived: false },
  { id: T_ENG, firstName: "Nigora", lastName: "Umarova", username: "nigora", isArchived: false },
  { id: T_IDLE, firstName: "Botir", lastName: "Eshonov", username: "botir", isArchived: false },
];

const d = (iso) => new Date(`${iso}T09:00:00.000Z`);

/**
 * Urinishlar. Joriy davr — oktabr, o'tgan davr — sentabr.
 * Matematika: sentabrda 50%, oktabrda 80% → +30 punkt.
 * Ingliz tili: sentabrda 90%, oktabrda 60% → −30 punkt.
 * "Sinfsiz" urinish hech bir o'qituvchiga yozilmaydi.
 */
const ATTEMPTS = [
  { id: "at1", studentId: "s1", className: "7-A", submittedAt: d("2026-10-05"), score: 80, answers: { [SUBJ_MATH]: [4, 5] } },
  { id: "at2", studentId: "s2", className: "7-A", submittedAt: d("2026-10-06"), score: 80, answers: { [SUBJ_MATH]: [4, 5] } },
  { id: "at3", studentId: "s1", className: "7-A", submittedAt: d("2026-10-07"), score: 60, answers: { [SUBJ_ENG]: [3, 5] } },
  { id: "at4", studentId: "s9", className: null, submittedAt: d("2026-10-08"), score: 70, answers: { [SUBJ_MATH]: [7, 10] } },
  { id: "at5", studentId: "s1", className: "7-A", submittedAt: d("2026-09-10"), score: 50, answers: { [SUBJ_MATH]: [5, 10] } },
  { id: "at6", studentId: "s2", className: "7-A", submittedAt: d("2026-09-11"), score: 50, answers: { [SUBJ_MATH]: [5, 10] } },
  { id: "at7", studentId: "s1", className: "7-A", submittedAt: d("2026-09-12"), score: 90, answers: { [SUBJ_ENG]: [9, 10] } },
];

const SUBJECT_NAME = { [SUBJ_MATH]: "Matematika", [SUBJ_ENG]: "Ingliz tili" };

const prismaStub = {
  diagnosticAttempt: {
    findMany: async ({ where }) => {
      const from = where.submittedAt.gte;
      const to = where.submittedAt.lte;
      return ATTEMPTS.filter((a) => a.submittedAt >= from && a.submittedAt <= to).map((a) => ({
        id: a.id,
        studentId: a.studentId,
        studentSnapshot: { className: a.className },
        subjectId: null,
        testId: null,
        mode: "timed",
        score: a.score,
        accuracy: a.score,
        grade: null,
        correctCount: null,
        wrongCount: null,
        skippedCount: null,
        totalQuestions: 10,
        timeSpentSec: 600,
        breakdown: null,
        errorPatterns: null,
        submittedAt: a.submittedAt,
      }));
    },
  },
  diagnosticAnswer: {
    findMany: async ({ where }) => {
      const ids = where.attemptId.in;
      const rows = [];
      for (const attempt of ATTEMPTS) {
        if (!ids.includes(attempt.id)) continue;
        for (const [subjectId, [correct, answered]] of Object.entries(attempt.answers)) {
          for (let i = 0; i < answered; i += 1) {
            rows.push({
              attemptId: attempt.id,
              isCorrect: i < correct,
              isSkipped: false,
              attemptQuestion: { subjectId, subjectName: SUBJECT_NAME[subjectId] },
            });
          }
        }
      }
      return rows;
    },
  },
  class: { findMany: async () => CLASSES },
  scheduleLesson: { findMany: async () => LESSONS },
  subject: { findMany: async () => SUBJECTS },
  user: {
    findMany: async ({ where }) => {
      const ids = where?.id?.in;
      return ids ? STAFF.filter((s) => ids.includes(s.id)) : STAFF;
    },
  },
  userClass: { findMany: async () => [] },
};

fakeModule("../src/config/prisma", prismaStub);
fakeModule("../src/services/settings.service", {
  getDiagnosticSettings: async () => ({
    aiEnabled: true,
    goodScore: 70,
    mediumScore: 40,
    weakTopicScore: 80,
    defaultQuestionCount: 20,
    defaultDurationMin: 30,
    defaultAttempts: 1,
  }),
});

const analytics = require("../src/services/diagnosticAnalytics.service");

const QUERY = { from: "2026-10-01", to: "2026-10-31" };

const byId = (data, id) => data.find((row) => row.teacherId === id);

test("kesim: har o'qituvchida joriy, o'tgan davr va FARQ bo'ladi", async () => {
  const result = await analytics.getByTeacher(QUERY);

  const math1 = byId(result.data, T_MATH1);
  assert.equal(math1.averageScore, 80, "oktabrda 80%");
  assert.equal(math1.previousScore, 50, "sentabrda 50%");
  assert.equal(math1.growth, 30, "+30 punkt");

  const eng = byId(result.data, T_ENG);
  assert.equal(eng.averageScore, 60);
  assert.equal(eng.previousScore, 90);
  assert.equal(eng.growth, -30, "tushish ham ko'rinadi");
});

test("kesim: bir sinf + bir fanda IKKI o'qituvchi bo'lsa natija IKKALASIDA", async () => {
  const result = await analytics.getByTeacher(QUERY);

  const math1 = byId(result.data, T_MATH1);
  const math2 = byId(result.data, T_MATH2);

  assert.equal(math1.averageScore, math2.averageScore);
  assert.equal(math1.attempts, 2);
  assert.equal(math2.attempts, 2, "ikkinchi o'qituvchida ham o'sha ikki urinish");
  assert.equal(result.overlaps, true, "qatorlar yig'indisi jamidan katta bo'lishi aytiladi");
});

test("kesim: urinishi yo'q o'qituvchi ham ro'yxatda qoladi", async () => {
  const result = await analytics.getByTeacher(QUERY);
  const idle = byId(result.data, T_IDLE);

  assert.ok(idle, "7-B o'qituvchisi ro'yxatdan tushib qolmaydi");
  assert.equal(idle.attempts, 0);
  assert.equal(idle.averageScore, null);
  assert.equal(idle.growth, null);
  assert.equal(idle.tone, "untested");
});

test("kesim: o'qituvchisi topilmagan urinish JIM QOLMAYDI", async () => {
  const result = await analytics.getByTeacher(QUERY);
  assert.equal(result.unassigned.attempts, 1, "sinfsiz urinish alohida sanaladi");
  assert.ok(result.unassigned.hint);
});

test("kesim: har qatorda qaysi sinf va fan ekani turadi", async () => {
  const result = await analytics.getByTeacher(QUERY);
  const math1 = byId(result.data, T_MATH1);

  assert.deepEqual(math1.classes, ["7-A"]);
  assert.deepEqual(math1.subjects, ["Matematika"]);
  assert.equal(math1.label, "Nurmatova Dildora");
  assert.equal(math1.username, "dildora");
});

test("kesim: natijasi borlar oldinda, keyin ball bo'yicha", async () => {
  const result = await analytics.getByTeacher(QUERY);
  const scored = result.data.filter((row) => row.attempts > 0);
  const empty = result.data.filter((row) => row.attempts === 0);

  assert.ok(result.data.indexOf(scored[0]) < result.data.indexOf(empty[0]));
  for (let i = 1; i < scored.length; i += 1) {
    assert.ok(
      (scored[i - 1].averageScore ?? 0) >= (scored[i].averageScore ?? 0),
      "ball kamayish tartibida",
    );
  }
});

test("kesim: \"Jami\" urinishlar bo'yicha, kesimlar yig'indisi bo'yicha EMAS", async () => {
  const result = await analytics.getByTeacher(QUERY);

  // Oktabrda 4 urinish bor (biri sinfsiz), kesimlar yig'indisi esa 5
  // (matematika ikki o'qituvchida sanaladi).
  assert.equal(result.totals.attempts, 4);
  const sumOfRows = result.data.reduce((n, row) => n + row.attempts, 0);
  assert.equal(sumOfRows, 5, "takroriy sanoq ataylab");
});

test("kesim: chegaralar javob bilan keladi (ustun sarlavhasi uchun)", async () => {
  const result = await analytics.getByTeacher(QUERY);
  assert.deepEqual(result.thresholds, { good: 70, medium: 40 });
  assert.ok(result.range.from instanceof Date);
});
