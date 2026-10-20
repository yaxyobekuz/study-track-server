const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * "BAHO QO'YMASLIK" JARIMASI — MAXRAJ VA DARS BO'LDIMI.
 *
 * Qamrov aynan "jim buziladigan" qoidalarga qaratilgan — har biri amalda
 * o'qituvchilarga asossiz jarima yozgan:
 *
 *   · O'SHA KUNI KELMAGAN o'quvchi maxrajga KIRMAYDI — maktabda yo'q
 *     odamga baho qo'yib bo'lmaydi (jarimalarning asosiy sababi shu edi);
 *   · MAKTABDAN KETGAN o'quvchi (davri yopilgan) KIRMAYDI — u sinfdan
 *     faqat arxivlash bilan chiqadi va aks holda HAR KUNI sanalardi;
 *   · ARXIVLANGAN kirmaydi, `isActive: false` esa KIRADI (login bayrog'i
 *     "o'qiyaptimi" degan savolga javob bermaydi);
 *   · davomat BELGILANMAGAN bo'lsa — KELGAN deb olinadi, aks holda
 *     davomat qo'yilmagan kunda jarima jimgina o'chib qolardi;
 *   · `late` — kelgan;
 *   · O'QITUVCHI kelmagan yoki dars "o'tildi" deb belgilangan bo'lsa
 *     jarima YO'Q — dars bo'lmagan;
 *   · yakshanba, bayram va o'chirilgan sozlama — kun umuman tekshirilmaydi.
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
const SCHEDULE = id("5c");

// Seshanba (2026-10-20) — Toshkent kunining UTC yarim tuni
const DAY = new Date("2026-10-20T00:00:00.000Z");

const db = {
  students: [],
  enrollments: new Set(),
  attendance: [],        // { studentId, status }
  staffAbsent: [],       // { userId }
  credits: [],           // { teacherId, classId, subjectId, lessonOrder }
  grades: [],            // { classId, subjectId, lessonOrder, studentId }
  holiday: false,
};

fakeModule("../src/config/prisma", {
  user: {
    findMany: async ({ where }) =>
      db.students
        .filter((s) => (where.isArchived === false ? !s.isArchived : true))
        .map((s) => ({
          id: s.id,
          firstName: s.firstName,
          lastName: "T",
          classes: [{ classId: CLASS }],
        })),
  },
  schedule: {
    findMany: async () => [
      {
        id: SCHEDULE,
        classId: CLASS,
        day: "seshanba",
        lessons: [{ subjectId: SUBJECT, teacherId: TEACHER, order: 1 }],
      },
    ],
  },
  class: {
    findMany: async () => [{ id: CLASS, name: "IT 1", isActive: true }],
  },
  attendance: {
    findMany: async () => db.staffAbsent,
  },
  lessonCredit: {
    findMany: async () => db.credits,
  },
  studentAttendance: {
    findMany: async ({ where }) =>
      db.attendance
        .filter((row) => where.status.in.includes(row.status))
        .map((row) => ({ studentId: row.studentId })),
  },
  grade: {
    findMany: async () =>
      db.grades.map((g) => ({ ...g, date: new Date("2026-10-20T06:00:00.000Z") })),
  },
  holiday: { findMany: async () => [] },
  penalty: { findMany: async () => [] },
});

fakeModule("../src/services/holiday.service", {
  isHoliday: async () => ({ isHoliday: db.holiday }),
});

fakeModule("../src/helpers/teacherAccess", {
  getSubstitutionCells: async () => new Map(),
  effectiveTeacherOf: (lesson) => ({ teacherId: lesson.teacherId, substituted: false }),
});

// O'qish davri — `studentAttendance.service.js` dagi yagona manba
fakeModule("../src/services/studentAttendance.service", {
  loadEnrollmentsOn: async (_day, studentIds) =>
    new Map(
      (studentIds || [])
        .filter((studentId) => db.enrollments.has(studentId))
        .map((studentId) => [studentId, { id: "e", startDate: "2026-09-01", endDate: null }]),
    ),
});

const { computeDayPenalties, DAY_SKIP, LESSON_SKIP } = require("../src/services/gradePenalty.service");

const SETTINGS = { isEnabled: true, missingThresholdPercent: 20, penaltyPoints: 1, exemptTeachers: [] };

/** N ta o'quvchi: hammasi o'qiydi, arxivlanmagan, davomati belgilanmagan. */
function seed(count) {
  db.students = [];
  db.enrollments = new Set();
  db.attendance = [];
  db.staffAbsent = [];
  db.credits = [];
  db.grades = [];
  db.holiday = false;

  for (let i = 0; i < count; i += 1) {
    // ⚠️ Indeks nol bilan to'ldiriladi: `id("a1")` va `id("a10")` padding'dan
    // keyin AYNI satrga aylanib, ikki o'quvchi bitta id ni bo'lishib olardi
    const studentId = id(`a${String(i).padStart(3, "0")}`);
    db.students.push({ id: studentId, firstName: `O${i}`, isArchived: false });
    db.enrollments.add(studentId);
  }
}

/** Hamma o'quvchiga baho qo'yilgan deb belgilaydi. */
const gradeAll = () => {
  db.grades = db.students.map((s) => ({
    classId: CLASS,
    subjectId: SUBJECT,
    lessonOrder: 1,
    studentId: s.id,
  }));
};

const only = async (settings = SETTINGS) => {
  const { skip, lessons } = await computeDayPenalties(DAY, settings);
  return { skip, entry: [...lessons.values()][0] ?? null };
};

/* ─────────────────── MAXRAJ ─────────────────── */

test("hamma baholangan — jarima YO'Q", async () => {
  seed(15);
  gradeAll();

  const { entry } = await only();
  assert.equal(entry.total, 15);
  assert.equal(entry.missing, 0);
  assert.equal(entry.deserved, false);
});

test("⚠️ O'SHA KUNI KELMAGAN o'quvchi maxrajga KIRMAYDI", async () => {
  seed(15);
  // 4 kishi kelmagan — o'qituvchi qolgan 11 tasini baholagan
  db.attendance = [
    { studentId: db.students[0].id, status: "absent" },
    { studentId: db.students[1].id, status: "absent" },
    { studentId: db.students[2].id, status: "excused" },
    { studentId: db.students[3].id, status: "absent" },
  ];
  db.grades = db.students.slice(4).map((s) => ({
    classId: CLASS, subjectId: SUBJECT, lessonOrder: 1, studentId: s.id,
  }));

  const { entry } = await only();
  // Ilgari 4/15 (27%) → jarima. Endi kelmaganlar maxrajda yo'q.
  assert.equal(entry.total, 11);
  assert.equal(entry.missing, 0);
  assert.equal(entry.deserved, false);
});

test("`late` — KELGAN, maxrajda qoladi", async () => {
  seed(10);
  db.attendance = [{ studentId: db.students[0].id, status: "late" }];
  gradeAll();

  const { entry } = await only();
  assert.equal(entry.total, 10);
});

test("davomat BELGILANMAGAN bo'lsa — kelgan deb olinadi", async () => {
  seed(10);
  db.attendance = []; // hech kim belgilanmagan
  db.grades = [];

  const { entry } = await only();
  // Jarima tizimi davomat qo'yilmagani uchun JIM o'chib qolmaydi
  assert.equal(entry.total, 10);
  assert.equal(entry.missing, 10);
  assert.equal(entry.deserved, true);
});

test("⚠️ MAKTABDAN KETGAN o'quvchi (davri yopilgan) maxrajga KIRMAYDI", async () => {
  seed(12);
  // Ikkitasi ketgan, lekin arxivlanmagani uchun sinfda qolib ketgan
  db.enrollments.delete(db.students[0].id);
  db.enrollments.delete(db.students[1].id);
  db.grades = db.students.slice(2).map((s) => ({
    classId: CLASS, subjectId: SUBJECT, lessonOrder: 1, studentId: s.id,
  }));

  const { entry } = await only();
  assert.equal(entry.total, 10);
  assert.equal(entry.missing, 0);
  assert.equal(entry.deserved, false);
});

test("ARXIVLANGAN kirmaydi, `isActive: false` esa KIRADI", async () => {
  seed(10);
  db.students[0].isArchived = true;
  // `isActive` umuman so'ralmaydi — login bayrog'i o'qishni to'xtatmaydi
  gradeAll();

  const { entry } = await only();
  assert.equal(entry.total, 9);
});

/* ─────────────────── DARS BO'LDIMI ─────────────────── */

test("⚠️ O'QITUVCHI KELMAGAN — jarima YO'Q", async () => {
  seed(10);
  db.grades = [];
  db.staffAbsent = [{ userId: TEACHER }];

  const { entry } = await only();
  assert.equal(entry.skip, LESSON_SKIP.TEACHER_AWAY);
  assert.equal(entry.deserved, false);
});

test('dars "o\'tildi" deb belgilangan — jarima YO\'Q', async () => {
  seed(10);
  db.grades = [];
  db.credits = [
    { teacherId: TEACHER, classId: CLASS, subjectId: SUBJECT, lessonOrder: 1 },
  ];

  const { entry } = await only();
  assert.equal(entry.skip, LESSON_SKIP.CREDITED);
  assert.equal(entry.deserved, false);
});

test("jarimadan ozod o'qituvchi", async () => {
  seed(10);
  db.grades = [];

  const { entry } = await only({ ...SETTINGS, exemptTeachers: [TEACHER] });
  assert.equal(entry.skip, LESSON_SKIP.EXEMPT);
});

test("baho kutilgan o'quvchi qolmasa — jarima YO'Q", async () => {
  seed(5);
  // Hammasi kelmagan: dars bo'lgan, lekin baholaydigan odam yo'q
  db.attendance = db.students.map((s) => ({ studentId: s.id, status: "absent" }));

  const { entry } = await only();
  assert.equal(entry.total, 0);
  assert.equal(entry.skip, LESSON_SKIP.NO_STUDENTS);
  assert.equal(entry.deserved, false);
});

/* ─────────────────── CHEGARA VA KUN ─────────────────── */

test("chegaradan past — jarima YO'Q", async () => {
  seed(20);
  // 2/20 = 10%, chegara 20%
  db.grades = db.students.slice(2).map((s) => ({
    classId: CLASS, subjectId: SUBJECT, lessonOrder: 1, studentId: s.id,
  }));

  const { entry } = await only();
  assert.equal(entry.percent, 10);
  assert.equal(entry.skip, LESSON_SKIP.BELOW);
  assert.equal(entry.deserved, false);
});

test("chegaradan yuqori — jarima BOR, matni ham to'g'ri", async () => {
  seed(20);
  db.grades = db.students.slice(5).map((s) => ({
    classId: CLASS, subjectId: SUBJECT, lessonOrder: 1, studentId: s.id,
  }));

  const { entry } = await only();
  assert.equal(entry.missing, 5);
  assert.equal(entry.percent, 25);
  assert.equal(entry.deserved, true);
  assert.equal(entry.title, "Baho qo'ymaslik: IT 1 1-dars (2026-10-20)");
});

test("yakshanba — kun tekshirilmaydi", async () => {
  seed(10);
  const { skip } = await computeDayPenalties(new Date("2026-10-18T00:00:00.000Z"), SETTINGS);
  assert.equal(skip, DAY_SKIP.SUNDAY);
});

test("bayram kuni — kun tekshirilmaydi", async () => {
  seed(10);
  db.holiday = true;

  const { skip } = await only();
  assert.equal(skip, DAY_SKIP.HOLIDAY);
});

test("sozlama o'chirilgan — kun tekshirilmaydi", async () => {
  seed(10);
  const { skip } = await computeDayPenalties(DAY, { ...SETTINGS, isEnabled: false });
  assert.equal(skip, DAY_SKIP.DISABLED);
});
