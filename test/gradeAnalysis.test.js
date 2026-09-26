const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeStudent,
  levelOf,
  createScopeAccumulator,
  accumulateGrade,
  accumulateAggregate,
  buildOverview,
  FINDING_CODES,
} = require("../src/helpers/gradeAnalysis");
const { topicNumberForLesson } = require("../src/helpers/lessonTopic");
const { collectFactNumbers, ungroundedNumbers } = require("../src/helpers/aiGrounding");
const { validateStudentNarrative } = require("../src/services/gradeAnalysisAi.service");

const period = { key: "month", label: "1 oy", title: "Oylik", days: 30, from: "2026-09-01", to: "2026-09-30", rangeLabel: "—" };
const names = new Map([
  ["m", "Matematika"],
  ["e", "Ingliz tili"],
]);

const grades = (subjectId, list) =>
  list.map((grade, i) => ({ subjectId, grade, dayKey: `2026-09-${String(i + 1).padStart(2, "0")}` }));

test("daraja: kam baho — insufficient, chegaralar", () => {
  assert.equal(levelOf(4.9, 2).key, "insufficient");
  assert.equal(levelOf(4.5, 3).key, "excellent");
  assert.equal(levelOf(3.9, 3).key, "good");
  assert.equal(levelOf(3.3, 3).key, "average");
  assert.equal(levelOf(2.8, 3).key, "weak");
  assert.equal(levelOf(2.7, 3).key, "critical");
});

test("ma'lumot yetmasa sabab ham, tavsiya ham yo'q", () => {
  const result = analyzeStudent({ period, grades: grades("m", [2, 2]), subjectNames: names });
  assert.equal(result.level.key, "insufficient");
  assert.deepEqual(result.findings, []);
  assert.equal(result.riskScore, 0);
  assert.deepEqual(result.views.studentView.recommendations, []);
});

test("sinf yaxshi, o'quvchi ortda — below_class; umumiy 'past fan' tavsiyasi takrorlanmaydi", () => {
  const result = analyzeStudent({
    period,
    student: { className: "7-A" },
    grades: [...grades("m", [3, 3, 2, 3, 3]), ...grades("e", [5, 5, 5, 4, 5])],
    subjectNames: names,
    classBench: { m: { average: 4.2, count: 80 }, e: { average: 4.3, count: 80 } },
  });
  const codes = result.findings.map((f) => f.code);
  assert.ok(codes.includes(FINDING_CODES.BELOW_CLASS));
  assert.ok(codes.includes(FINDING_CODES.WEAK_SUBJECT));
  const recCodes = result.views.parentView.recommendations.map((r) => r.code);
  assert.ok(recCodes.includes(FINDING_CODES.BELOW_CLASS));
  assert.ok(!recCodes.includes(FINDING_CODES.WEAK_SUBJECT), "aniq sabab bor — umumiy tavsiya chiqmaydi");
  assert.ok(result.riskScore > 0);
});

test("fan butun sinfga qiyin — class_wide_difficulty, below_class EMAS", () => {
  const result = analyzeStudent({
    period,
    grades: grades("m", [3, 3, 3, 3]),
    subjectNames: names,
    classBench: { m: { average: 3.2, count: 90 } },
  });
  const codes = result.findings.map((f) => f.code);
  assert.ok(codes.includes(FINDING_CODES.CLASS_WIDE_DIFFICULTY));
  assert.ok(!codes.includes(FINDING_CODES.BELOW_CLASS));
});

test("ketma-ket past baholar va pasayish aniqlanadi", () => {
  const result = analyzeStudent({ period, grades: grades("m", [5, 5, 5, 2, 3, 2]), subjectNames: names });
  const codes = result.findings.map((f) => f.code);
  assert.ok(codes.includes(FINDING_CODES.LOW_STREAK));
  assert.ok(codes.includes(FINDING_CODES.DECLINING_SUBJECT));
});

test("yig'ma: o'rtacha XOM baholardan, sinfsiz o'quvchi sinf kesimiga kirmaydi", () => {
  const current = createScopeAccumulator();
  const previous = createScopeAccumulator();
  // A: 2 ta baho (5,5), B: 4 ta baho (3,3,3,3) → xom o'rtacha 3.67, o'quvchilar o'rtachasi 4.0 bo'lardi
  for (const g of [5, 5]) accumulateGrade(current, { studentId: "A", subjectId: "m", classId: "c1", grade: g });
  for (const g of [3, 3, 3, 3]) accumulateGrade(current, { studentId: "B", subjectId: "m", classId: "", grade: g });
  accumulateAggregate(previous, { subjectId: "m", classId: "c1", sum: 12, count: 3 });

  const overview = buildOverview({
    current,
    previous,
    students: [
      { studentId: "A", level: "insufficient", riskScore: 0, average: 5, previousAverage: null, gradeCount: 2, findings: [], classId: "c1" },
      { studentId: "B", level: "average", riskScore: 30, average: 3, previousAverage: null, gradeCount: 4, findings: [], classId: null },
    ],
    subjectNames: names,
    classNames: new Map([["c1", "7-A"]]),
    topics: new Map(),
    attendance: { marked: 0, attended: 0, absent: 0 },
    diagnostics: { attempts: 0 },
  });

  assert.equal(overview.average, 3.67);
  assert.equal(overview.previousAverage, 4);
  assert.deepEqual(overview.classes.map((c) => c.name), ["7-A"]);
  assert.equal(overview.students.analyzed, 1);
});

test("dars mavzusi: tugagan darslar orqaga qaytariladi, noaniq bo'lsa null", () => {
  const lessons = [
    { order: 1, subjectId: "m", endTime: "08:45" },
    { order: 3, subjectId: "m", endTime: "10:25" },
  ];
  // 11:00 — ikkala dars tugagan, joriy raqam 7 → bugun 5 dan boshlangan
  assert.equal(topicNumberForLesson({ currentTopicNumber: 7, lastTopicOrder: 20, lessons, subjectId: "m", lessonOrder: 1, nowMinutes: 660 }), 5);
  assert.equal(topicNumberForLesson({ currentTopicNumber: 7, lastTopicOrder: 20, lessons, subjectId: "m", lessonOrder: 3, nowMinutes: 660 }), 6);
  // Mavzular tugagan — taxmin yozilmaydi
  assert.equal(topicNumberForLesson({ currentTopicNumber: 20, lastTopicOrder: 20, lessons, subjectId: "m", lessonOrder: 1, nowMinutes: 660 }), null);
  // Jadvalda yo'q dars
  assert.equal(topicNumberForLesson({ currentTopicNumber: 3, lastTopicOrder: 20, lessons, subjectId: "m", lessonOrder: 2, nowMinutes: 660 }), null);
});

test("AI raqam nazorati: faktlarda yo'q son — butun javob rad etiladi", () => {
  const allowed = collectFactNumbers({ average: 4.3, list: [3, 5] });
  assert.deepEqual(ungroundedNumbers("O'rtacha 4.30, baholar 3 va 5", allowed), []);
  assert.deepEqual(ungroundedNumbers("O'rtacha 4.7", allowed), ["4.7"]);

  const payload = { subjects: [{ name: "Matematika" }], findings: [{ tone: "warning" }], overall: { average: 3.5 } };
  const view = (summary) => ({
    headline: "Xulosa",
    summary,
    recommendations: [
      { title: "Matematika", detail: "Har kuni takrorlang", priority: "medium", subject: "Matematika" },
      { title: "Davomat", detail: "Darsni qoldirmang", priority: "high", subject: null },
    ],
  });
  assert.ok(validateStudentNarrative({ student: view("O'rtacha 3.5"), parent: view("O'rtacha 3.5") }, payload));
  assert.equal(validateStudentNarrative({ student: view("O'rtacha 3.9"), parent: view("O'rtacha 3.5") }, payload), null);
  // Faktlarda yo'q fan nomi ham rad etiladi
  const bad = view("O'rtacha 3.5");
  bad.recommendations[0].subject = "Fizika";
  assert.equal(validateStudentNarrative({ student: bad, parent: view("O'rtacha 3.5") }, payload), null);
});
