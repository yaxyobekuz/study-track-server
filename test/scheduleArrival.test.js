const test = require("node:test");
const { mock } = test;
const assert = require("node:assert/strict");

/**
 * DARS JADVALIDAGI O'QITUVCHINING KELISH VAQTI — birinchi darsdan 10 daqiqa
 * OLDIN (biznes qarori, 2026-10-02).
 *
 * Servislar haqiqiy, baza xotirada. Tekshiriladi: haftalik va kunlik oyna,
 * o'rinbosarlik, bayram/ta'til, kechikish chegarasi (imtiyoz bilan) va
 * jarima matni.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

// 2026-10-05 — dushanba
const MONDAY = new Date(Date.UTC(2026, 9, 5));
const TUESDAY = new Date(Date.UTC(2026, 9, 6));
const SUNDAY = new Date(Date.UTC(2026, 9, 4));

const OWNER = "a".repeat(24); // asosiy o'qituvchi
const SUB = "b".repeat(24); // o'rinbosar (dushanba o'z darsi yo'q)
const MANUAL = "m".repeat(24); // qat'iy ish vaqtli xodim
const CLASS_A = "c".repeat(24);
const CLASS_B = "d".repeat(24);
const SUBJECT = "s".repeat(24);

const PERIODS = [
  { order: 1, startTime: "08:30", endTime: "09:15" },
  { order: 2, startTime: "09:25", endTime: "10:10" },
  { order: 3, startTime: "10:20", endTime: "11:05" },
];

const db = {};
const reset = () => {
  db.schedules = [
    // Dushanba: OWNER 1- va 3-darsda (A sinf), 2-darsda B sinf
    {
      classId: CLASS_A,
      day: "dushanba",
      lessons: [
        { teacherId: OWNER, order: 1, startTime: null, endTime: null },
        { teacherId: OWNER, order: 3, startTime: null, endTime: null },
      ],
    },
    {
      classId: CLASS_B,
      day: "dushanba",
      lessons: [{ teacherId: OWNER, order: 2, startTime: null, endTime: null }],
    },
    // Seshanba: OWNER faqat 3-darsda, darsning o'zida vaqt (nol bilan to'ldirilmagan)
    {
      classId: CLASS_A,
      day: "seshanba",
      lessons: [{ teacherId: OWNER, order: 3, startTime: "9:40", endTime: "10:25" }],
    },
  ];
  db.substitutions = [];
  db.holidays = new Set();
  db.vacations = new Set();
  db.attendanceSettings = {
    id: "settings",
    officeLocation: null,
    officeRadius: 100,
    lateArrivalPenaltyPoints: 1,
    lateArrivalGraceMinutes: 10,
    earlyDeparturePenaltyPoints: 1,
    earlyDepartureGraceMinutes: 10,
    penaltyPaused: false,
    pausedRoles: [],
    pausedUsers: [],
  };
  db.attendance = [];
  db.penalties = [];
};
reset();

const users = new Map([
  [OWNER, { id: OWNER, role: "teacher", workTimeSource: "schedule" }],
  [SUB, { id: SUB, role: "teacher", workTimeSource: "schedule" }],
  [
    MANUAL,
    {
      id: MANUAL,
      role: "reception",
      workTimeSource: "manual",
      workStartTime: "08:00",
      workEndTime: "17:00",
      workDays: [1, 2, 3, 4, 5],
      weeklySchedule: {},
    },
  ],
]);

fakeModule("../src/config/prisma", {
  scheduleLesson: {
    findMany: async ({ where }) =>
      db.schedules.flatMap((s) =>
        s.lessons
          .filter((l) => where.teacherId.in.includes(l.teacherId))
          .map((l) => ({ ...l, schedule: { day: s.day } })),
      ),
  },
  schedule: {
    findMany: async ({ where }) => {
      const teacherIds = where.OR[0].lessons.some.teacherId.in;
      const classIds = where.OR[1]?.classId.in ?? [];
      return db.schedules.filter(
        (s) =>
          s.day === where.day &&
          (s.lessons.some((l) => teacherIds.includes(l.teacherId)) || classIds.includes(s.classId)),
      );
    },
  },
  lessonSubstitutionItem: {
    findMany: async ({ where }) => db.substitutions.filter((item) => item.day === where.day),
  },
  user: {
    findUnique: async ({ where }) => users.get(where.id) ?? null,
    update: async () => ({}),
  },
  attendance: {
    findFirst: async () => null,
    create: async ({ data }) => {
      const row = { id: `att${db.attendance.length}`, ...data };
      db.attendance.push(row);
      return row;
    },
    update: async ({ where, data }) => {
      const row = db.attendance.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    },
  },
  penalty: {
    create: async ({ data }) => {
      const row = { id: `pen${db.penalties.length}`, ...data };
      db.penalties.push(row);
      return row;
    },
  },
});
fakeModule("../src/config/platformPrisma", { role: { findFirst: async () => null } });
fakeModule("../src/services/settings.service", {
  getScheduleSettings: async () => ({ periods: PERIODS }),
  getAttendanceSettings: async () => db.attendanceSettings,
});
fakeModule("../src/services/holiday.service", { buildHolidaySet: async () => db.holidays });
fakeModule("../src/services/vacationMonth.service", { getVacationSet: async () => db.vacations });
fakeModule("../src/services/checkoutGate.service", {
  resolveCheckout: async () => ({ approved: false, report: null, requestId: null }),
});

const workTime = require("../src/services/scheduleWorkTime.service");
const attendance = require("../src/services/attendance.service");

/** OWNER ning dushanba 1-darsi (A sinf) SUB ga berilgan. */
const substituteFirstLesson = () => {
  db.substitutions.push({
    classId: CLASS_A,
    day: "dushanba",
    lessonOrder: 1,
    subjectId: SUBJECT,
    snapshot: {},
    substitution: {
      id: "sub1",
      originalTeacherId: OWNER,
      substituteTeacherId: SUB,
      teacherSnapshot: {},
    },
  });
};

/** Toshkent devor-soati (dushanba) → instant. */
const atTashkent = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(MONDAY.getTime() + (h * 60 + m - 5 * 60) * 60000);
};

const checkInAt = async (hhmm, userId = OWNER) => {
  mock.timers.enable({ apis: ["Date"], now: atTashkent(hhmm) });
  try {
    return await attendance.checkIn(userId);
  } finally {
    mock.timers.reset();
  }
};

test("kelish vaqti: dars vaqtidan 10 daqiqa oldin, yarim tundan oldinga o'tmaydi", () => {
  assert.equal(workTime.arrivalTimeOf("08:30"), "08:20");
  assert.equal(workTime.arrivalTimeOf("9:05"), "08:55");
  assert.equal(workTime.arrivalTimeOf("00:05"), "00:00");
  assert.equal(workTime.arrivalTimeOf(null), null);
  assert.equal(workTime.arrivalTimeOf("25:00"), null);
});

test("haftalik oyna: har kunning birinchi darsidan 10 daqiqa oldin — oxirgi dars tugashigacha", async () => {
  reset();
  const week = await workTime.getScheduleWorkTime(OWNER);

  assert.deepEqual(week.workDays, [1, 2]);
  assert.deepEqual(week.byDay.get(1), {
    startTime: "08:20",
    endTime: "11:05",
    firstLessonTime: "08:30",
    lessonCount: 3,
  });
  // Darsning o'z vaqti sozlamadan ustun, "9:40" ham to'g'ri o'qiladi
  assert.deepEqual(week.byDay.get(2), {
    startTime: "09:30",
    endTime: "10:25",
    firstLessonTime: "09:40",
    lessonCount: 1,
  });

  const summary = workTime.summarizeWeek(week);
  assert.equal(summary.workStartTime, "08:20");
  assert.equal(summary.firstLessonTime, "08:30");
  assert.equal(summary.workEndTime, "11:05");
  assert.equal(summary.arrivalLeadMinutes, 10);
  assert.equal(summary.byDay[1].firstLessonTime, "08:30");
});

test("kunlik oyna: o'rinbosarlik darsni egasidan oladi va o'rinbosarga beradi", async () => {
  reset();
  substituteFirstLesson();

  const windows = await workTime.getScheduleDayWindows([OWNER, SUB], MONDAY);

  // Egasi endi 2-darsdan boshlaydi
  assert.deepEqual(windows.get(OWNER), {
    startTime: "09:15",
    endTime: "11:05",
    firstLessonTime: "09:25",
    lessonCount: 2,
    closed: null,
  });
  // O'rinbosarning o'z darsi yo'q kunda ham ish oynasi bor
  assert.deepEqual(windows.get(SUB), {
    startTime: "08:20",
    endTime: "09:15",
    firstLessonTime: "08:30",
    lessonCount: 1,
    closed: null,
  });
});

test("kunlik oyna: bayram, ta'til oyi va yakshanba — dars yo'q", async () => {
  reset();
  db.holidays = new Set(["2026-10-05"]);
  assert.equal((await workTime.getScheduleDayWindow(OWNER, MONDAY)).closed, "holiday");
  assert.equal((await workTime.getScheduleDayWindow(OWNER, MONDAY)).lessonCount, 0);

  reset();
  db.vacations = new Set([202610]);
  const vacation = await workTime.getScheduleDayWindow(OWNER, MONDAY);
  assert.equal(vacation.closed, "vacation");
  assert.equal(vacation.startTime, null);

  reset();
  assert.equal((await workTime.getScheduleDayWindow(OWNER, SUNDAY)).closed, "sunday");
});

test("effektiv jadval: kelish vaqti, birinchi dars va BUGUNGI ish kuni", async () => {
  reset();
  const monday = await attendance.getEffectiveSchedule(users.get(OWNER), MONDAY);
  assert.equal(monday.workStartTime, "08:20");
  assert.equal(monday.firstLessonTime, "08:30");
  assert.equal(monday.workEndTime, "11:05");
  assert.equal(monday.isWorkDay, true);
  assert.equal(monday.scheduleMissing, false);

  const tuesday = await attendance.getEffectiveSchedule(users.get(OWNER), TUESDAY);
  assert.equal(tuesday.workStartTime, "09:30");

  // O'z darsi yo'q, lekin bugun o'rinbosar — ish kuni, "jadvali yo'q" EMAS
  substituteFirstLesson();
  const sub = await attendance.getEffectiveSchedule(users.get(SUB), MONDAY);
  assert.equal(sub.isWorkDay, true);
  assert.equal(sub.scheduleMissing, false);
  assert.equal(sub.workStartTime, "08:20");
  const subTuesday = await attendance.getEffectiveSchedule(users.get(SUB), TUESDAY);
  assert.equal(subTuesday.isWorkDay, false);
  assert.equal(subTuesday.scheduleMissing, true);

  // Qat'iy ish vaqtli xodimga tegilmaydi
  const manual = await attendance.getEffectiveSchedule(users.get(MANUAL), MONDAY);
  assert.equal(manual.workStartTime, "08:00");
  assert.equal(manual.isWorkDay, true);
});

test("ta'til oyida dars jadvalidagi o'qituvchiga ish kuni emas", async () => {
  reset();
  db.vacations = new Set([202610]);
  const schedule = await attendance.getEffectiveSchedule(users.get(OWNER), MONDAY);
  assert.equal(schedule.isWorkDay, false);
  assert.equal(schedule.closedReason, "vacation");
  assert.equal(schedule.scheduleMissing, false);
});

test("kontekst boshqa kunniki bo'lsa ishlatilmaydi", async () => {
  reset();
  const ctx = await attendance.buildScheduleContext([users.get(OWNER)], TUESDAY);
  const schedule = await attendance.getEffectiveSchedule(users.get(OWNER), MONDAY, ctx);
  assert.equal(schedule.workStartTime, "08:20");
  const sameDay = await attendance.getEffectiveSchedule(users.get(OWNER), TUESDAY, ctx);
  assert.equal(sameDay.workStartTime, "09:30");
});

test("kelish: imtiyoz ichida (08:30 gacha) — kechikish yo'q", async () => {
  reset();
  const record = await checkInAt("08:30");
  assert.equal(record.isLate, false);
  assert.equal(record.status, "present");
  assert.equal(db.penalties.length, 0);
});

test("kelish: 08:31 — 11 daqiqa kechikish (08:20 dan), jarima izohi bilan", async () => {
  reset();
  const record = await checkInAt("08:31");
  assert.equal(record.isLate, true);
  assert.equal(record.status, "late");
  assert.equal(record.lateMinutes, 11);
  assert.equal(record.penaltyApplied, true);

  assert.equal(db.penalties.length, 1);
  assert.equal(db.penalties[0].title, "Kech kelish: 5-oktabr, 2026 (11 daqiqa)");
  assert.equal(
    db.penalties[0].description,
    "Avtomatik davomat jarimasi. Kelish vaqti 08:20 (birinchi dars 08:30 dan 10 daqiqa oldin), " +
      "kelgan vaqt 08:31, imtiyoz 10 daqiqa.",
  );
});

test("kelish: imtiyoz 0 bo'lsa 10 ga aylanmaydi — 08:21 da kechikish", async () => {
  reset();
  db.attendanceSettings.lateArrivalGraceMinutes = 0;
  const record = await checkInAt("08:21");
  assert.equal(record.isLate, true);
  assert.equal(record.lateMinutes, 1);
});

test("kelish: birinchi darsi o'rinbosarga berilgan bo'lsa kelish vaqti keyingi darsidan", async () => {
  reset();
  substituteFirstLesson();
  // Egasining birinchi darsi 09:25 → kelish 09:15, imtiyoz bilan 09:25 gacha
  const onTime = await checkInAt("09:20");
  assert.equal(onTime.isLate, false);

  reset();
  substituteFirstLesson();
  // O'rinbosar 08:30 dagi darsga — kelish 08:20
  const late = await checkInAt("08:35", SUB);
  assert.equal(late.isLate, true);
  assert.equal(late.lateMinutes, 15);
});

test("kelish: bugun darsi yo'q (bayram) — kechikish hisoblanmaydi", async () => {
  reset();
  db.holidays = new Set(["2026-10-05"]);
  const record = await checkInAt("12:00");
  assert.equal(record.isLate, false);
  assert.equal(db.penalties.length, 0);
});
