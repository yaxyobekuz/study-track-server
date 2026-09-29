const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * KUNNI YOPISH — "MEN KETDIM" DARVOZASI.
 *
 * Servis haqiqiy, baza xotirada. Tekshiriladi: kimga qo'llanadi, qachon
 * tayyor, nima to'smaydi (ozod o'qituvchi, yopib bo'lmaydigan topshiriq)
 * va rahbar ruxsati darvozani qanday ochadi.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const { currentDayDate } = require("../src/helpers/month.helpers");
const { DAYS_UZ } = require("../src/utils/constants");

const TODAY = currentDayDate();
// Yakshanba — dars yo'q, dars testlari o'tkazib yuboriladi
const DAY_NAME = TODAY.getUTCDay() === 0 ? null : DAYS_UZ[TODAY.getUTCDay()];
const TEACHER = "t".repeat(24);
const CLASS = "c".repeat(24);
const SUBJECT = "s".repeat(24);
const STUDENTS = Array.from({ length: 10 }, (_, i) => `st${String(i).padStart(22, "0")}`);

const db = {
  attendanceSettings: { checkoutRequireGrades: true, checkoutRequireTasks: true },
  penaltySettings: { missingThresholdPercent: 40, exemptTeachers: [] },
  taskSettings: { allowLateSubmission: true },
  lessons: [],
  grades: [],
  tasks: [],
  requests: [],
};

const reset = () => {
  db.attendanceSettings = { checkoutRequireGrades: true, checkoutRequireTasks: true };
  db.penaltySettings = { missingThresholdPercent: 40, exemptTeachers: [] };
  db.taskSettings = { allowLateSubmission: true };
  db.lessons = [];
  db.grades = [];
  db.tasks = [];
  db.requests = [];
};

fakeModule("../src/config/prisma", {
  lessonSubstitutionItem: { findMany: async () => [] },
  schedule: {
    findMany: async () =>
      db.lessons.length ? [{ classId: CLASS, day: DAY_NAME, lessons: db.lessons }] : [],
  },
  class: { findMany: async () => [{ id: CLASS, name: "5-A", isActive: true }] },
  subject: { findMany: async () => [{ id: SUBJECT, name: "Matematika" }] },
  userClass: { findMany: async () => STUDENTS.map((userId) => ({ classId: CLASS, userId })) },
  grade: { findMany: async () => db.grades },
  task: { findMany: async () => db.tasks },
  attendance: {
    findUnique: async () => ({ status: "present", checkIn: new Date(), checkOut: null }),
    findMany: async () => [],
  },
  checkoutRequest: {
    findMany: async () => [...db.requests].reverse(),
  },
  user: { findMany: async () => [] },
});
fakeModule("../src/services/settings.service", {
  getAttendanceSettings: async () => db.attendanceSettings,
  getGradePenaltySettings: async () => db.penaltySettings,
  getScheduleSettings: async () => ({ periods: [] }),
  getTaskSettings: async () => db.taskSettings,
});
fakeModule("../src/services/holiday.service", { buildHolidaySet: async () => new Set() });
fakeModule("../src/services/vacationMonth.service", { getVacationSet: async () => new Set() });
fakeModule("../src/services/task.service", {
  WORKING_STATUSES: ["pending", "extended", "pending_rejected"],
});
fakeModule("../src/services/telegram.service", { sendMessage: async () => ({ success: true }), sleep: async () => {} });

const gate = require("../src/services/checkoutGate.service");

const teacher = { id: TEACHER, role: "teacher", extraRoles: [] };
const lesson = (order, startTime, endTime) => ({
  subjectId: SUBJECT,
  teacherId: TEACHER,
  order,
  startTime,
  endTime,
});
const gradeStudents = (order, count) => {
  for (const studentId of STUDENTS.slice(0, count)) {
    db.grades.push({ classId: CLASS, subjectId: SUBJECT, lessonOrder: order, studentId });
  }
};

test("o'qituvchi bo'lmagan xodimga darvoza qo'llanmaydi", async () => {
  reset();
  db.tasks.push({ id: "x", title: "T", dueDate: new Date(Date.now() - 3600e3), status: "pending" });
  const r = await gate.getCheckoutReadiness({ id: "w".repeat(24), role: "reception", extraRoles: [] });
  assert.equal(r.applies, false);
  assert.equal(r.canCheckOut, true);
  const resolved = await gate.resolveCheckout({ id: "w".repeat(24), role: "reception", extraRoles: [] });
  assert.equal(resolved.report, null);
});

test("qo'shimcha roli teacher bo'lgan xodimga ham qo'llanadi", async () => {
  reset();
  const r = await gate.getCheckoutReadiness({ id: TEACHER, role: "reception", extraRoles: ["teacher"] });
  assert.equal(r.applies, true);
});

test("darsga BITTA baho yetadi, topshiriq yo'q — tayyor, hisobot muhrlanadi", { skip: !DAY_NAME }, async () => {
  reset();
  db.lessons.push(lesson(1, "00:00", "00:01"));
  gradeStudents(1, 1);
  const r = await gate.getCheckoutReadiness(teacher);
  assert.equal(r.ready, true);
  assert.deepEqual(r.blockers, []);
  const resolved = await gate.resolveCheckout(teacher);
  assert.equal(resolved.approved, false);
  assert.equal(resolved.report.grades.done, 1);
  assert.deepEqual(resolved.report.grades.pending, []);
});

test("bahosiz dars va boshlanmagan dars (bahosi bo'lsa ham) — ikkala sabab aytiladi", { skip: !DAY_NAME }, async () => {
  reset();
  db.lessons.push(lesson(1, "00:00", "00:01"), lesson(2, "23:58", "23:59"));
  // Boshlanmagan darsga qo'yilgan baho uni "o'tilgan" qilmaydi
  gradeStudents(2, 10);
  const r = await gate.getCheckoutReadiness(teacher);
  assert.equal(r.ready, false);
  assert.deepEqual(
    r.grades.lessons.map((l) => l.state),
    ["pending", "notStarted"],
  );
  assert.deepEqual(r.blockers, [
    "1 ta darsga baho qo'yilmagan",
    "1 ta dars hali boshlanmagan",
  ]);
  await assert.rejects(gate.resolveCheckout(teacher), (err) => {
    assert.equal(err.statusCode, 409);
    assert.equal(err.details.reason, "checkout_blocked");
    assert.match(err.message, /rahbariyatdan ruxsat so'rang/);
    return true;
  });
});

test("jarimadan ozod o'qituvchining bahosi ketishni to'smaydi", { skip: !DAY_NAME }, async () => {
  reset();
  db.penaltySettings.exemptTeachers = [TEACHER];
  db.lessons.push(lesson(1, "00:00", "00:01"));
  const r = await gate.getCheckoutReadiness(teacher);
  assert.equal(r.grades.exempt, true);
  assert.equal(r.ready, true);
});

test("kech topshirish taqiqlangan, muddati o'tgan topshiriq — ro'yxatda, lekin to'smaydi", async () => {
  reset();
  db.taskSettings.allowLateSubmission = false;
  db.tasks.push({ id: "a", title: "Eski", dueDate: new Date(Date.now() - 3600e3), status: "pending" });
  let r = await gate.getCheckoutReadiness(teacher);
  assert.equal(r.tasks.items[0].locked, true);
  assert.equal(r.ready, true);

  db.taskSettings.allowLateSubmission = true;
  r = await gate.getCheckoutReadiness(teacher);
  assert.equal(r.tasks.items[0].locked, false);
  assert.deepEqual(r.blockers, ["1 ta topshiriq topshirilmagan"]);
});

test("rahbar ruxsati: kutilayotgan — to'sadi, tasdiqlangan — ochadi", async () => {
  reset();
  db.tasks.push({ id: "a", title: "Hisobot", dueDate: new Date(Date.now() + 3600e3), status: "pending" });
  const base = {
    id: "r".repeat(24),
    userId: TEACHER,
    date: TODAY,
    reason: "Kasal bo'lib qoldim",
    pendingItems: {},
    createdAt: new Date(),
  };

  db.requests = [{ ...base, status: "pending" }];
  await assert.rejects(gate.resolveCheckout(teacher), /hali ko'rib chiqilmagan/);

  db.requests = [{ ...base, status: "approved", reviewedBy: "o".repeat(24), reviewedAt: new Date() }];
  const r = await gate.getCheckoutReadiness(teacher);
  assert.equal(r.ready, false);
  assert.equal(r.canCheckOut, true);
  const resolved = await gate.resolveCheckout(teacher);
  assert.equal(resolved.approved, true);
  assert.equal(resolved.requestId, base.id);
  assert.equal(resolved.report.approvedRequestId, base.id);

  // Rad etilgan so'rov darvozani OCHMAYDI
  db.requests = [{ ...base, status: "rejected", reviewNote: "Yo'q" }];
  await assert.rejects(gate.resolveCheckout(teacher), /ruxsat so'rang/);
});

test("ikkala shart o'chirilsa — darvoza yo'q", async () => {
  reset();
  db.attendanceSettings = { checkoutRequireGrades: false, checkoutRequireTasks: false };
  db.tasks.push({ id: "a", title: "T", dueDate: new Date(Date.now() - 3600e3), status: "pending" });
  const r = await gate.getCheckoutReadiness(teacher);
  assert.equal(r.applies, false);
});

test("baho vaqti: dars boshlangach ochiq, dars TUGASHI yopmaydi", () => {
  const { checkGradingTimeWindow } = require("../src/helpers/date.helpers");
  // 00:00 da boshlangan dars — tugash vaqtidan qat'i nazar ochiq
  assert.equal(checkGradingTimeWindow("00:00").canGrade, true);

  const now = new Date(Date.now() + 5 * 3600 * 1000);
  if (now.getUTCHours() * 60 + now.getUTCMinutes() < 23 * 60 + 59) {
    const late = checkGradingTimeWindow("23:59");
    assert.equal(late.canGrade, false);
    assert.match(late.reason, /hali boshlanmagan/);
  }
});
