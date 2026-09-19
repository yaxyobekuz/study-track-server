const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * O'QITUVCHI OYNASI — fanlar va toifa.
 *
 * `lessonHoursDashboard.getTeacherDetail` HAQIQIY kodi va HAQIQIY payroll
 * dvigateli ishlaydi; baza xotiradagi soxta, dars soati esa tayyor oy
 * kesimi bilan almashtiriladi (jadvalni yoyish bu testning mavzusi emas).
 */

const { Decimal } = require("../src/helpers/money.helpers");

/* ───────────────────────── Soxta muhit ───────────────────────── */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

let db;
const resetDb = () => {
  db = {
    users: [
      {
        id: "t1",
        firstName: "Nodira",
        lastName: "Karimova",
        username: "nodira",
        role: "teacher",
        isArchived: false,
        positionId: null,
        salaryCategoryId: "c1",
      },
    ],
    categories: [
      {
        id: "c1",
        name: "Oliy toifa",
        perHourRate: new Decimal(60_000),
        department: { name: "Yuqori sinflar" },
      },
    ],
    subjects: [
      { id: "math", name: "Matematika", isActive: true },
      { id: "phys", name: "Fizika", isActive: true },
      { id: "chem", name: "Kimyo", isActive: true },
      { id: "astro", name: "Astronomiya", isActive: true },
      { id: "draw", name: "Chizmachilik", isActive: false },
    ],
    // Jadval shabloni — haftalik darslar
    lessons: [
      { teacherId: "t1", subjectId: "math" },
      { teacherId: "t1", subjectId: "math" },
      { teacherId: "t1", subjectId: "math" },
      { teacherId: "t1", subjectId: "phys" },
      { teacherId: "t1", subjectId: "phys" },
    ],
    // Profil: matematika + jadvalda yo'q astronomiya + arxivlangan chizmachilik
    userSubjects: [
      { userId: "t1", subjectId: "math" },
      { userId: "t1", subjectId: "astro" },
      { userId: "t1", subjectId: "draw" },
    ],
  };
};

const subjectById = (id) => db.subjects.find((s) => s.id === id);

// Oy kesimi — `getTeachersHours` natijasi shaklida
let monthHours;
const regularMonth = () => ({
  hours: 21,
  taughtHours: 10,
  weeklyHours: 5,
  teachingDays: 20,
  taughtDays: 9,
  byDay: [],
  byClass: [],
  series: [],
  bySubject: [
    { id: "math", name: "Matematika", hours: 12, substituted: 0, covered: 0 },
    { id: "phys", name: "Fizika", hours: 8, substituted: 0, covered: 0 },
    // Faqat o'rinbosarlikdan: bir kun kimyo darsiga chiqqan
    { id: "chem", name: "Kimyo", hours: 1, substituted: 0, covered: 1 },
  ],
});

const prisma = {
  user: {
    findUnique: async ({ where }) => db.users.find((u) => u.id === where.id) ?? null,
  },
  position: { findMany: async () => [] },
  salaryCategory: {
    findMany: async ({ where }) => db.categories.filter((c) => where.id.in.includes(c.id)),
  },
  payrollBonus: { findMany: async () => [] },
  payrollDeduction: { findMany: async () => [] },
  gradingUnlock: { findMany: async () => [] },
  payrollEntry: {
    findUnique: async () => null,
    findMany: async () => [],
  },
  lessonSubstitution: { findMany: async () => [] },
  // Tyutor guruhlari va oylikni to'xtatish (2026-09-17) — bu testlarda yo'q
  tutorGroup: { findMany: async () => [] },
  payrollSuspension: { findMany: async () => [] },
  scheduleLesson: {
    groupBy: async ({ where }) => {
      const counts = new Map();
      for (const lesson of db.lessons.filter((l) => l.teacherId === where.teacherId)) {
        counts.set(lesson.subjectId, (counts.get(lesson.subjectId) ?? 0) + 1);
      }
      return [...counts].map(([subjectId, count]) => ({ subjectId, _count: { _all: count } }));
    },
  },
  userSubject: {
    findMany: async ({ where }) =>
      db.userSubjects
        .filter((row) => row.userId === where.userId)
        .map((row) => ({ subject: subjectById(row.subjectId) })),
  },
  subject: {
    findMany: async ({ where }) =>
      db.subjects
        .filter((s) => where.id.in.includes(s.id))
        .map(({ id, name }) => ({ id, name })),
  },
};

fakeModule("../src/config/prisma", prisma);
fakeModule("../src/services/lessonHours.service", {
  getTeachersHours: async (ids) => new Map(ids.map((id) => [id, monthHours])),
  getMonthCalendar: async () => ({ isVacationMonth: false, teachingDays: 20 }),
  cutoffForMonth: () => null,
  computeLessonHoursForMonth: async () => new Map(),
  computeLessonHoursForStaff: async () => ({ hours: 0 }),
});
fakeModule("../src/services/staffSalary.service", {
  resolveSalariesForMonth: async () => new Map(),
  TYPE_LABELS: { kpi: "KPI (dars soati)" },
});
fakeModule("../src/services/lessonSubstitution.service", { REASON_LABELS: {} });

const { getTeacherDetail } = require("../src/services/lessonHoursDashboard.service");

/* ───────────────────────── Testlar ───────────────────────── */

test("bir nechta fan: jadvaldagilar soat bo'yicha, keyin o'rinbosarlik, keyin profil", async () => {
  resetDb();
  monthHours = regularMonth();

  const detail = await getTeacherDetail("t1", 202609);

  assert.deepEqual(
    detail.subjects.map((s) => [s.name, s.source, s.hours, s.weeklyHours, s.isAssigned]),
    [
      ["Matematika", "schedule", 12, 3, true],
      ["Fizika", "schedule", 8, 2, false],
      ["Kimyo", "substitution", 1, 0, false],
      ["Astronomiya", "profile", 0, 0, true],
    ],
  );
  assert.equal(detail.subjects.find((s) => s.name === "Kimyo").coveredHours, 1);
});

test("arxivlangan fan profilda qolgan bo'lsa ko'rinmaydi", async () => {
  resetDb();
  monthHours = regularMonth();

  const detail = await getTeacherDetail("t1", 202609);

  assert.equal(detail.subjects.some((s) => s.id === "draw"), false);
});

test("fanlar soati yig'indisi jami soatga teng", async () => {
  resetDb();
  monthHours = regularMonth();

  const detail = await getTeacherDetail("t1", 202609);

  assert.equal(
    detail.subjects.reduce((sum, s) => sum + s.hours, 0),
    detail.hours,
  );
});

test("ta'til oyi: soat nol, lekin jadvaldagi fan 'jadvalda yo'q' bo'lib qolmaydi", async () => {
  resetDb();
  monthHours = { ...regularMonth(), hours: 0, taughtHours: 0, bySubject: [] };

  const detail = await getTeacherDetail("t1", 202607);
  const physics = detail.subjects.find((s) => s.id === "phys");

  // Fizika profilda yo'q va oy kesimida ham yo'q — nomi alohida yuklanadi
  assert.equal(physics.name, "Fizika");
  assert.equal(physics.source, "schedule");
  assert.equal(physics.hours, 0);
  assert.equal(detail.subjects.find((s) => s.id === "math").source, "schedule");
});

test("toifa dvigateldan: nomi va bo'limi", async () => {
  resetDb();
  monthHours = regularMonth();

  const detail = await getTeacherDetail("t1", 202609);

  assert.equal(detail.categoryName, "Oliy toifa");
  assert.equal(detail.departmentName, "Yuqori sinflar");
  assert.equal(detail.positionName, null);
});

test("fani ham, jadvali ham yo'q o'qituvchi — bo'sh ro'yxat", async () => {
  resetDb();
  db.lessons = [];
  db.userSubjects = [];
  monthHours = { ...regularMonth(), hours: 0, bySubject: [] };

  const detail = await getTeacherDetail("t1", 202609);

  assert.deepEqual(detail.subjects, []);
});
