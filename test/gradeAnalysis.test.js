const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeStudent,
  levelOf,
  createScopeAccumulator,
  accumulateGrade,
  accumulateAggregate,
  buildOverview,
  buildRankings,
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

/* ─────────────────────────── REYTING ─────────────────────────── */

const pupil = (id, classId, average, gradeCount = 10, extra = {}) => ({
  studentId: id,
  reportId: `r-${id}`,
  name: id,
  className: classId ? `${classId}-sinf` : null,
  classId,
  level: "good",
  average,
  previousAverage: null,
  gradeCount,
  ...extra,
});

test("reyting: har sinfda eng yaxshi 3 va eng past 3, sinfdagi o'rni bilan", () => {
  const students = [4.9, 4.7, 4.5, 4.2, 4.0, 3.8, 3.5, 3.1].map((avg, i) => pupil(`a${i}`, "7A", avg));
  const { classes } = buildRankings(students);
  assert.equal(classes.length, 1);
  const [cls] = classes;
  assert.deepEqual(cls.best.map((r) => [r.studentId, r.place]), [["a0", 1], ["a1", 2], ["a2", 3]]);
  // Eng past — eng pasti birinchi, o'rni sinfdagi o'rni (8 tadan 8-o'rin)
  assert.deepEqual(cls.worst.map((r) => [r.studentId, r.place]), [["a7", 8], ["a6", 7], ["a5", 6]]);
  assert.equal(cls.best[0].classSize, 8);
});

test("reyting: kichik sinfda eng yaxshi va eng past KESISHMAYDI", () => {
  const five = buildRankings([4.8, 4.6, 4.1, 3.9, 3.2].map((avg, i) => pupil(`b${i}`, "5B", avg))).classes[0];
  assert.equal(five.best.length, 3);
  assert.equal(five.worst.length, 2);
  const ids = [...five.best, ...five.worst].map((r) => r.studentId);
  assert.equal(new Set(ids).size, ids.length);

  const one = buildRankings([pupil("solo", "1A", 4.2)]).classes[0];
  assert.equal(one.best.length, 1);
  assert.equal(one.worst.length, 0);
});

test("reyting: teng natija — bir xil o'rin, baholar soni ko'pi oldinda", () => {
  const cls = buildRankings([
    pupil("x", "9A", 5, 12),
    pupil("y", "9A", 5, 12),
    pupil("z", "9A", 5, 20),
    pupil("w", "9A", 4.1, 12),
    pupil("v", "9A", 3.9, 12),
    pupil("u", "9A", 3.5, 12),
  ]).classes[0];
  assert.deepEqual(cls.best.map((r) => [r.studentId, r.place]), [["z", 1], ["x", 2], ["y", 2]]);
});

test("reyting: eng past ro'yxat sinfdagi o'ringa ZID emas (teng o'rtacha)", () => {
  const students = [
    ...[4.5, 4.3, 4.1, 4.0].map((avg, i) => pupil(`c${i}`, "9A", avg, 20)),
    pupil("more", "9A", 3.75, 21), // ko'p baho — sinfda yuqoriroq (8-emas, 5-o'rin)
    pupil("fewer", "9A", 3.75, 20), // kam baho — sinfda oxirgi
  ];
  const { classes, school } = buildRankings(students);
  const [cls] = classes;
  assert.deepEqual(cls.worst.map((r) => [r.studentId, r.place]), [["fewer", 6], ["more", 5], ["c3", 4]]);
  // Maktabdagi "eng past" tartibi sinfdagi o'rinning aynan teskarisi
  assert.deepEqual(school.worst.map((r) => r.studentId), ["fewer", "more", "c3"]);
  for (let i = 1; i < school.worst.length; i++) {
    assert.ok(school.worst[i - 1].classPlace >= school.worst[i].classPlace);
  }
});

test("reyting: kam baholi, ma'lumoti yetarli emas va sinfsiz o'quvchi kirmaydi", () => {
  const cls = buildRankings([
    pupil("a", "8A", 4.1, 20),
    pupil("b", "8A", 4.0, 18),
    pupil("c", "8A", 3.6, 22),
    pupil("lucky", "8A", 5, 3), // 3 ta "5" — median 19 ning yarmidan kam
    pupil("new", "8A", 5, 2, { level: "insufficient" }),
    pupil("nocls", null, 5, 30),
  ]);
  assert.equal(cls.classes.length, 1);
  const [row] = cls.classes;
  assert.equal(row.minGrades, 10);
  assert.equal(row.ranked, 3);
  assert.equal(row.excluded, 1);
  const all = [...row.best, ...row.worst, ...cls.school.best, ...cls.school.worst].map((r) => r.studentId);
  for (const id of ["lucky", "new", "nocls"]) assert.ok(!all.includes(id), `${id} reytingga kirmasligi kerak`);
});

test("reyting: maktab — har sinfning uchtaligi yig'ilib qayta o'rin oladi", () => {
  const students = [
    ...[4.9, 4.4, 4.3, 3.8, 3.6, 2.9].map((avg, i) => pupil(`a${i}`, "7A", avg)),
    ...[4.8, 4.7, 4.6, 3.4, 3.0, 2.5].map((avg, i) => pupil(`b${i}`, "7B", avg)),
  ];
  const { school } = buildRankings(students);
  assert.equal(school.classes, 2);
  assert.deepEqual(
    school.best.map((r) => [r.studentId, r.place, r.classPlace]),
    [["a0", 1, 1], ["b0", 2, 1], ["b1", 3, 2], ["b2", 4, 3], ["a1", 5, 2], ["a2", 6, 3]],
  );
  assert.deepEqual(school.worst.slice(0, 3).map((r) => [r.studentId, r.place]), [["b5", 1], ["a5", 2], ["b4", 3]]);
  assert.equal(school.worst.length, 6);
});

test("yig'ma reytingni o'z ichiga oladi", () => {
  const current = createScopeAccumulator();
  const overview = buildOverview({
    current,
    previous: createScopeAccumulator(),
    students: [pupil("a", "c1", 4.5, 10, { findings: [], riskScore: 0 }), pupil("b", "c1", 3.5, 10, { findings: [], riskScore: 0 })],
    subjectNames: names,
    classNames: new Map([["c1", "7-A"]]),
    topics: new Map(),
    attendance: { marked: 0, attended: 0, absent: 0 },
    diagnostics: { attempts: 0 },
  });
  assert.equal(overview.rankings.classes[0].best[0].studentId, "a");
  assert.equal(overview.rankings.classes[0].worst[0].studentId, "b");
});

/* ─────────────────────────── TAVSIYALAR ─────────────────────────── */

test("tavsiya: bitta fan — bitta reja, maqsad va qadamlar bilan", () => {
  const topics = new Map([
    ["t1", { name: "Kasrlar", subjectId: "m" }],
    ["t2", { name: "Tenglamalar", subjectId: "m" }],
  ]);
  const withTopics = (list, ids) => grades("m", list).map((row, i) => ({ ...row, topicId: ids[i] }));
  const result = analyzeStudent({
    period,
    grades: [...withTopics([4, 3, 3, 2, 3, 2], ["t1", "t1", "t2", "t2", "t1", "t2"]), ...grades("e", [5, 5, 5, 5])],
    subjectNames: names,
    topics,
    classBench: { m: { average: 4.1, count: 80 }, e: { average: 4.2, count: 80 } },
  });

  const recs = result.views.studentView.recommendations;
  const math = recs.filter((r) => r.subject === "Matematika");
  assert.equal(math.length, 1, "Matematika uchun bitta tavsiya");
  assert.equal(math[0].code, FINDING_CODES.BELOW_CLASS);
  assert.equal(math[0].priority, "high");
  assert.ok(math[0].target > 2.83 && math[0].target <= 3.83, "maqsad realistik");
  assert.ok(math[0].steps.length >= 2 && math[0].steps.length <= 4);
  assert.ok(math[0].steps.some((step) => step.includes("«Tenglamalar»")), "zaif mavzu qadamda nomi bilan");
  assert.equal(result.facts.subjects.find((s) => s.id === "m").target, math[0].target);
  assert.ok(recs.length <= 5);
  // Ota-ona qadamlari — ota-ona qiladigan ish
  const parentMath = result.views.parentView.recommendations.find((r) => r.subject === "Matematika");
  assert.ok(parentMath.steps.some((step) => step.includes("o'qituvchisi")));
});

test("tavsiya: yaxshi fandagi kichik pasayish eng muhimini siqib chiqarmaydi", () => {
  const result = analyzeStudent({
    period,
    grades: [...grades("m", [3, 3, 2, 3, 2, 2]), ...grades("e", [5, 5, 5, 4, 5])],
    subjectNames: names,
  });
  const recs = result.views.studentView.recommendations;
  assert.equal(recs[0].subject, "Matematika");
  const english = recs.find((r) => r.subject === "Ingliz tili");
  if (english) assert.equal(english.priority, "low");
});

test("tavsiya: muammo yo'q — aniq o'sish yo'nalishi (eng past fan maqsadi)", () => {
  const result = analyzeStudent({
    period,
    grades: [...grades("m", [4, 4, 5, 4, 4]), ...grades("e", [5, 5, 5, 5])],
    subjectNames: names,
  });
  const recs = result.views.studentView.recommendations;
  assert.equal(recs[0].subject, "Matematika");
  assert.equal(recs[0].target, 4.5);
  assert.ok(recs[0].steps.length > 0);
  assert.ok(recs.every((r) => r.priority === "low"));
});

test("AI: qadamlar ham raqam nazoratidan o'tadi, maqsad faktlardan qo'yiladi", () => {
  const payload = {
    subjects: [{ name: "Matematika", target: 3.5 }],
    findings: [{ tone: "warning" }],
    overall: { average: 3.1 },
    rulesRecommendations: [{ steps: ["Har kuni 20–30 daqiqa mashq qiling"] }],
  };
  const view = (steps) => ({
    headline: "Xulosa",
    summary: "O'rtacha 3.1",
    recommendations: [
      { title: "Matematika", detail: "Maqsad 3.50", priority: "medium", subject: "Matematika", steps },
      { title: "Davomat", detail: "Darsni qoldirmang", priority: "high", subject: null },
    ],
  });

  const ok = validateStudentNarrative({ student: view(["Har kuni 20 daqiqa mashq"]), parent: view([]) }, payload);
  assert.ok(ok);
  assert.equal(ok.student.recommendations[0].target, 3.5);
  assert.deepEqual(ok.student.recommendations[0].steps, ["Har kuni 20 daqiqa mashq"]);
  assert.deepEqual(ok.student.recommendations[1].steps, []);

  // Faktlarda yo'q son qadamda — butun javob rad etiladi
  assert.equal(validateStudentNarrative({ student: view(["Har kuni 45 daqiqa"]), parent: view([]) }, payload), null);
  // Qadamlar massiv emas yoki juda ko'p — rad
  assert.equal(validateStudentNarrative({ student: view("qadam"), parent: view([]) }, payload), null);
  assert.equal(validateStudentNarrative({ student: view(["a", "b", "c", "d", "e"]), parent: view([]) }, payload), null);
});

test("tavsiya: har bir fan rejasida kamida 2 ta aniq qadam (faqat 'past fan' bo'lsa ham)", () => {
  const result = analyzeStudent({
    period,
    grades: grades("m", [3, 4, 3, 4, 3, 3, 4]),
    subjectNames: names,
    classBench: { m: { average: 3.84, count: 80 } },
  });
  for (const voice of ["studentView", "parentView"]) {
    const [rec] = result.views[voice].recommendations;
    assert.equal(rec.code, FINDING_CODES.WEAK_SUBJECT);
    assert.ok(rec.steps.length >= 2, `${voice}: qadamlar yetarli emas`);
  }
});
