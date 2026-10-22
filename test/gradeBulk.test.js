const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * "HAMMAGA BAHO QO'YISH" (`POST /grades/bulk`) VA BITTALIK BAHO — UMUMIY YOZUV.
 *
 * Qamrov — jim buzilsa sezilmaydigan qoidalar:
 *   · mavjud bahoga TEGILMAYDI (o'qituvchi qo'ygan "3" ni ommaviy "5" bosmaydi);
 *   · darsda yo'q o'quvchiga QO'YILMAYDI (kechki jarima maxraji bilan AYNI manba);
 *   · baho o'qituvchining shu fandagi boshqa darsiga ham tarqaladi —
 *     bittalik yo'l bilan AYNI;
 *   · RUXSAT bilan ochilgan darsda yopiq (dars egasining jurnali band bo'lardi);
 *   · tekshiruv va yozuv bitta QULF ichida (ikki marta bosish takror yozmaydi);
 *   · bittalik yo'l avvalgidek ishlaydi va o'tgan kun TOSHKENT kuni bo'yicha.
 */

process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db?schema=public";

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const id = (prefix) => prefix.padEnd(24, "0");

const CLASS = id("c1");
const SUBJECT = id("5b");
const TEACHER = id("7a");
const OTHER_TEACHER = id("7b");
const HOUR_MS = 3600 * 1000;

const { currentDayDate } = require("../src/helpers/month.helpers");
const { DAYS_UZ } = require("../src/utils/constants");

/**
 * Ochilgan O'TGAN kun (yakshanba emas): bugungi kun yo'li maktabda bo'lish va
 * vaqt oynasiga — real soatga — bog'liq, ular bu testning mavzusi emas.
 */
const PAST_DAY = (() => {
  let day = new Date(currentDayDate().getTime() - 24 * HOUR_MS);
  while (day.getUTCDay() === 0) day = new Date(day.getTime() - 24 * HOUR_MS);
  return day;
})();
const PAST_KEY = PAST_DAY.toISOString().slice(0, 10);

const db = {
  students: [],       // { id }
  expected: new Set(), // shu kuni darsda bor o'quvchilar
  grades: [],         // { studentId, subjectId, classId, lessonOrder, teacherId, date, ... }
  access: "own",      // tanlangan darsga qaysi yo'l bilan kirilgan
  locks: [],
  inTx: false,
  lastExistingWhere: null,
};

const matches = (row, where) => {
  if (where.studentId?.in && !where.studentId.in.includes(row.studentId)) return false;
  if (typeof where.studentId === "string" && where.studentId !== row.studentId) return false;
  if (where.subjectId && where.subjectId !== row.subjectId) return false;
  if (where.classId && where.classId !== row.classId) return false;
  if (where.teacherId && where.teacherId !== row.teacherId) return false;
  if (where.lessonOrder?.in && !where.lessonOrder.in.includes(row.lessonOrder)) return false;
  if (where.date?.gte && row.date < where.date.gte) return false;
  if (where.date?.lt && row.date >= where.date.lt) return false;
  return true;
};

const gradeModel = {
  findMany: async ({ where }) => {
    if (db.inTx) db.lastExistingWhere = where;
    return db.grades.filter((row) => matches(row, where));
  },
  createMany: async ({ data }) => {
    // ⚠️ Yozuv QULF ichida bo'lishi shart — tashqarida bo'lsa test yiqiladi
    assert.equal(db.inTx, true, "createMany tranzaksiyadan tashqarida");
    assert.ok(db.locks.length > 0, "createMany qulfsiz");
    db.grades.push(...data);
    return { count: data.length };
  },
};

const prismaFake = {
  subject: { findUnique: async () => ({ id: SUBJECT }) },
  class: { findUnique: async () => ({ id: CLASS }) },
  schedule: {
    findFirst: async () => ({
      lessons: [
        { id: id("l1"), order: 1, subjectId: SUBJECT, teacherId: TEACHER, startTime: "08:30" },
        { id: id("l2"), order: 2, subjectId: SUBJECT, teacherId: TEACHER, startTime: "09:20" },
      ],
    }),
  },
  user: {
    findMany: async () => db.students.map((s) => ({ id: s.id })),
    findFirst: async ({ where }) => db.students.find((s) => s.id === where.id) ?? null,
  },
  grade: gradeModel,
  $transaction: async (fn) => {
    const tx = {
      grade: gradeModel,
      $executeRaw: async (strings, ...values) => {
        db.locks.push(values[0]);
      },
    };
    db.inTx = true;
    try {
      return await fn(tx);
    } finally {
      db.inTx = false;
    }
  },
};

fakeModule("../src/config/prisma", prismaFake);
fakeModule("../src/services/holiday.service", { isHoliday: async () => ({ isHoliday: false }) });
fakeModule("../src/services/grade.service", { attachGradeRefs: async (rows) => rows });
fakeModule("../src/services/archivedStudentScope.service", {
  loadArchivedStudentScope: async () => ({}),
});
fakeModule("../src/helpers/teacherAccess", {
  resolveLessonAccess: async () => ({
    allowed: true,
    lessons: [
      { order: 1, access: db.access, grantId: db.access === "grant" ? id("97") : null },
      { order: 2, access: db.access, grantId: db.access === "grant" ? id("97") : null },
    ],
    blocked: [],
  }),
  scheduleDayOf: (date) => (date.getUTCDay() === 0 ? null : DAYS_UZ[date.getUTCDay()]),
  hasGradingGrantFor: async () => true,
});
fakeModule("../src/services/gradingUnlock.service", { findActiveUnlock: async () => ({ id: "u" }) });
fakeModule("../src/services/gradingPresence.service", { assertAtSchool: async () => {} });
fakeModule("../src/services/gradeExpectation.service", {
  loadExpectedStudents: async (classIds) =>
    new Map(
      classIds.map((classId) => [
        classId,
        db.students.filter((s) => db.expected.has(s.id)).map((s) => ({ id: s.id })),
      ]),
    ),
});
fakeModule("../src/services/gradeTopic.service", { resolveGradeTopics: async () => new Map() });
fakeModule("../src/services/lessonTopic.service", { getDayLessonTopics: async () => new Map() });
fakeModule("../src/services/excel.service", {});

const { bulkCreateGrades, createGrade } = require("../src/controllers/grade.controller");

const USER = { id: TEACHER, role: "teacher", extraRoles: [] };

/** Handlerni chaqiradi: javob yoki `next(error)` ga tushgan xato. */
const run = (handler, body) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    handler({ body, user: USER, query: {}, params: {} }, res, (error) => resolve({ error }));
  });

/** N ta o'quvchi, hammasi darsda, baho yo'q. */
function seed(count) {
  db.students = [];
  db.expected = new Set();
  db.grades = [];
  db.access = "own";
  db.locks = [];
  db.lastExistingWhere = null;
  for (let i = 0; i < count; i += 1) {
    const studentId = id(`a${String(i).padStart(3, "0")}`);
    db.students.push({ id: studentId });
    db.expected.add(studentId);
  }
}

const existingGrade = (student, lessonOrder, grade = 3, teacherId = TEACHER) => ({
  studentId: student.id,
  subjectId: SUBJECT,
  classId: CLASS,
  lessonOrder,
  teacherId,
  grade,
  // O'tgan kunning 12:00 (Toshkent) instanti — servis yozadigan payt bilan AYNI
  date: new Date(PAST_DAY.getTime() + 7 * HOUR_MS),
});

const BULK = (extra = {}) => ({
  classId: CLASS,
  subjectId: SUBJECT,
  lessonOrder: 1,
  grade: 5,
  date: PAST_KEY,
  ...extra,
});

const newGradesOf = (studentId) =>
  db.grades.filter((g) => g.studentId === studentId && g.grade === 5);

/* ─────────────────── HAMMAGA ─────────────────── */

test("hammaga: bahosi bor va darsda yo'q o'quvchiga tegilmaydi, qolganiga ikkala darsga", async () => {
  seed(5);
  const [s0, s1, s2, s3, s4] = db.students;
  db.grades.push(existingGrade(s0, 1, 3)); // o'qituvchi qo'lda "3" qo'ygan
  db.grades.push(existingGrade(s1, 1, 4, OTHER_TEACHER)); // boshqa o'qituvchi qo'ygan
  db.expected.delete(s2.id); // o'sha kuni kelmagan

  const { status, body, error } = await run(bulkCreateGrades, BULK());
  assert.equal(error, undefined);
  assert.equal(status, 201);

  assert.deepEqual(body.data, {
    grade: 5,
    studentsGraded: 2,
    gradesCreated: 4,
    alreadyGraded: 2,
    away: 1,
  });
  assert.equal(
    body.message,
    "2 ta o'quvchiga 5 baho qo'yildi (4 ta dars soatiga). " +
      "2 tasida baho bor edi — tegilmadi, 1 tasi darsda yo'q — qo'yilmadi",
  );

  // Mavjud baholar o'zgarmagan, ularga yangi baho qo'shilmagan
  assert.equal(newGradesOf(s0.id).length, 0);
  assert.equal(newGradesOf(s1.id).length, 0);
  assert.equal(newGradesOf(s2.id).length, 0);
  // Darsdagi bahosizlarga — o'qituvchining shu fandagi IKKALA darsiga
  assert.deepEqual(newGradesOf(s3.id).map((g) => g.lessonOrder).sort(), [1, 2]);
  assert.deepEqual(newGradesOf(s4.id).map((g) => g.lessonOrder).sort(), [1, 2]);
  assert.ok(newGradesOf(s3.id).every((g) => g.teacherId === TEACHER && g.gradingGrantId === null));
});

test("hammaga: tanlangan darsda bahosi yo'q, boshqasida bor — faqat yetishmaganiga", async () => {
  seed(1);
  const [s0] = db.students;
  db.grades.push(existingGrade(s0, 2, 4));

  const { body } = await run(bulkCreateGrades, BULK());
  assert.equal(body.data.studentsGraded, 1);
  assert.equal(body.data.gradesCreated, 1);
  assert.deepEqual(newGradesOf(s0.id).map((g) => g.lessonOrder), [1]);
  assert.equal(body.message, "1 ta o'quvchiga 5 baho qo'yildi");
});

test("hammaga: o'tgan kun bahosi o'sha kunning 12:00 (Toshkent) instantiga yoziladi", async () => {
  seed(1);
  await run(bulkCreateGrades, BULK());
  assert.ok(
    db.grades.every((g) => g.date.getTime() === PAST_DAY.getTime() + 7 * HOUR_MS),
  );
});

test("⚠️ hammaga: tekshiruv va yozuv BITTA qulf ichida (sinf + fan + kun)", async () => {
  seed(2);
  await run(bulkCreateGrades, BULK());
  assert.deepEqual(db.locks, [`grades:${CLASS}:${SUBJECT}:${PAST_KEY}`]);
  // Mavjud baholar ham qulf ichida o'qilgan
  assert.ok(db.lastExistingWhere, "mavjud baholar tranzaksiya ichida o'qilmagan");
});

test("⚠️ hammaga: ikkinchi bosish takror yozmaydi — 409", async () => {
  seed(3);
  await run(bulkCreateGrades, BULK());
  const before = db.grades.length;

  const { error } = await run(bulkCreateGrades, BULK());
  assert.equal(error?.statusCode, 409);
  assert.match(error.message, /Baho qo'yiladigan o'quvchi qolmadi: 3 tasida baho bor edi/);
  assert.equal(db.grades.length, before);
});

test("hammaga: hamma darsda yo'q — 409 va sababi bilan", async () => {
  seed(2);
  db.expected = new Set();

  const { error } = await run(bulkCreateGrades, BULK());
  assert.equal(error?.statusCode, 409);
  assert.match(error.message, /2 tasi darsda yo'q/);
  assert.equal(db.grades.length, 0);
});

test("⚠️ hammaga: RUXSAT bilan ochilgan darsda yopiq — 403", async () => {
  seed(3);
  db.access = "grant";

  const { error } = await run(bulkCreateGrades, BULK());
  assert.equal(error?.statusCode, 403);
  assert.equal(db.grades.length, 0);
});

test("hammaga: o'rinbosarlik darsida ishlaydi", async () => {
  seed(2);
  db.access = "substitution";

  const { status } = await run(bulkCreateGrades, BULK());
  assert.equal(status, 201);
  assert.equal(db.grades.length, 4);
});

test("hammaga: baho butun son 1..5 bo'lishi shart", async () => {
  for (const grade of [0, 6, 4.5, "abc", null]) {
    seed(1);
    const { error } = await run(bulkCreateGrades, BULK({ grade }));
    assert.equal(error?.statusCode, 400, `grade=${grade}`);
    assert.equal(db.grades.length, 0);
  }
});

test("hammaga: sinf, fan va dars majburiy", async () => {
  seed(1);
  const { error } = await run(bulkCreateGrades, BULK({ lessonOrder: undefined }));
  assert.equal(error?.statusCode, 400);
});

/* ─────────────────── BITTALIK — avvalgidek ─────────────────── */

const SINGLE = (student, extra = {}) => ({
  studentId: student.id,
  classId: CLASS,
  subjectId: SUBJECT,
  lessonOrder: 1,
  grade: 4,
  comment: "",
  date: PAST_KEY,
  ...extra,
});

test("bittalik: o'qituvchining ikkala darsiga tarqaladi", async () => {
  seed(1);
  const [s0] = db.students;

  const { status, body } = await run(createGrade, SINGLE(s0));
  assert.equal(status, 201);
  assert.equal(
    body.message,
    "Baho muvaffaqiyatli qo'yildi va 2 ta dars soatiga avtomatik qo'llandi",
  );
  assert.deepEqual(db.grades.map((g) => g.lessonOrder).sort(), [1, 2]);
  assert.deepEqual(db.locks, [`grades:${CLASS}:${SUBJECT}:${PAST_KEY}`]);
});

test("bittalik: hamma darsida baho bor — 400 'allaqachon qo'yilgan'", async () => {
  seed(1);
  const [s0] = db.students;
  db.grades.push(existingGrade(s0, 1), existingGrade(s0, 2));

  const { error } = await run(createGrade, SINGLE(s0));
  assert.equal(error?.statusCode, 400);
  assert.match(error.message, /allaqachon qo'yilgan/);
});

test("bittalik: darsda yo'q o'quvchiga ham qo'yiladi (ongli qaror, cheklov faqat ommaviyda)", async () => {
  seed(1);
  const [s0] = db.students;
  db.expected = new Set();

  const { status } = await run(createGrade, SINGLE(s0));
  assert.equal(status, 201);
});

test("bittalik: mavjud baho qidiruvi TOSHKENT kuni chegarasida", async () => {
  seed(1);
  const [s0] = db.students;
  await run(createGrade, SINGLE(s0));

  const from = new Date(PAST_DAY.getTime() - 5 * HOUR_MS);
  assert.equal(db.lastExistingWhere.date.gte.getTime(), from.getTime());
  assert.equal(db.lastExistingWhere.date.lt.getTime(), from.getTime() + 24 * HOUR_MS);
});
