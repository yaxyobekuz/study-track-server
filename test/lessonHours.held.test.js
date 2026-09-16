const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * DARS O'TILDIMI — soat jadvaldan emas, FAKTDAN.
 *
 * Qoida: o'qituvchi "kelmadi"/"sababli" bo'lgan kun yoki hech kimga baho
 * qo'yilmagan dars o'tilmagan hisoblanadi va uning soati (demak puli)
 * yozilmaydi. `lessonHours.service` HAQIQIY kodi ishlaydi, baza xotirada.
 */

const {
  judgeLesson,
  judgedThroughDay,
  tashkentDayKey,
  lessonGradeKey,
  teacherDayKey,
} = require("../src/helpers/lessonHours");

/* ───────────────────────── Sof qoida ───────────────────────── */

test("bugun va kelajak tekshirilmaydi, o'tgan oy to'liq tekshiriladi", () => {
  assert.equal(judgedThroughDay(202608, 202609, 16), null);
  assert.equal(judgedThroughDay(202609, 202609, 16), 15);
  assert.equal(judgedThroughDay(202609, 202609, 1), 0);
  assert.equal(judgedThroughDay(202610, 202609, 16), 0);
});

test("baho kuni TOSHKENT bo'yicha: UTC 19:30 — ertangi kun", () => {
  assert.equal(tashkentDayKey(new Date("2026-08-03T19:30:00Z")), "2026-08-04");
  assert.equal(tashkentDayKey(new Date("2026-08-03T18:59:59Z")), "2026-08-03");
});

test("davomat bahodan ustun: kelmagan kuni baho bo'lsa ham o'tilmagan", () => {
  const lesson = { teacherId: "t1", classId: "c1", subjectId: "s1", lessonOrder: 1, day: "2026-08-03" };
  const gradedKeys = new Set([lessonGradeKey("c1", "s1", 1, "2026-08-03")]);

  assert.equal(judgeLesson(lesson, { gradedKeys, absences: new Map() }), null);
  assert.deepEqual(
    judgeLesson(lesson, {
      gradedKeys,
      absences: new Map([[teacherDayKey("t1", "2026-08-03"), { status: "absent", autoMarked: true }]]),
    }),
    { reason: "absent", autoMarked: true },
  );
  assert.deepEqual(
    judgeLesson({ ...lesson, lessonOrder: 2 }, { gradedKeys, absences: new Map() }),
    { reason: "noGrade", autoMarked: false },
  );
});

/* ───────────────────────── Servis ───────────────────────── */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const inList = (value, cond) =>
  cond && typeof cond === "object" && "in" in cond ? cond.in.includes(value) : true;
const inRange = (date, cond) =>
  !cond || ((!cond.gte || date >= cond.gte) && (!cond.lte || date <= cond.lte));

const utc = (iso) => new Date(`${iso}T00:00:00Z`);

// Avgust 2026: dushanbalar 3, 10, 17, 24, 31; seshanbalar 4, 11, 18, 25
const db = {
  lessons: [
    { teacherId: "t1", subjectId: "s1", order: 1, schedule: { day: "dushanba", classId: "c1" } },
    { teacherId: "t1", subjectId: "s1", order: 2, schedule: { day: "seshanba", classId: "c1" } },
  ],
  substitutions: [
    {
      id: "sub1",
      status: "active",
      originalTeacherId: "t1",
      substituteTeacherId: "t2",
      fromDate: utc("2026-08-24"),
      toDate: utc("2026-08-24"),
      items: [{ classId: "c1", day: "dushanba", lessonOrder: 1, subjectId: "s1", snapshot: {} }],
    },
  ],
  grades: [
    // 10-avgust (dushanba) va 25-avgust (seshanba) — BAHO YO'Q
    ...["2026-08-03T03:00:00Z", "2026-08-17T03:00:00Z", "2026-08-24T04:00:00Z", "2026-08-31T03:00:00Z"].map(
      (at) => ({ classId: "c1", subjectId: "s1", lessonOrder: 1, date: new Date(at) }),
    ),
    // 4-avgust uchun baho UTC da hali 3-avgust (Toshkentda 00:30, 4-avgust)
    ...["2026-08-03T19:30:00Z", "2026-08-11T06:00:00Z", "2026-08-18T06:00:00Z"].map(
      (at) => ({ classId: "c1", subjectId: "s1", lessonOrder: 2, date: new Date(at) }),
    ),
  ],
  attendance: [
    { userId: "t1", date: utc("2026-08-17"), status: "absent", autoMarked: false },
    { userId: "t1", date: utc("2026-08-18"), status: "excused", autoMarked: false },
    // Kechikkan kun — soat yoziladi
    { userId: "t1", date: utc("2026-08-31"), status: "late", autoMarked: false },
  ],
};

fakeModule("../src/config/prisma", {
  scheduleLesson: {
    findMany: async ({ where }) => db.lessons.filter((l) => inList(l.teacherId, where.teacherId)),
  },
  lessonSubstitution: { findMany: async () => db.substitutions },
  class: { findMany: async () => [{ id: "c1", name: "5-A" }] },
  subject: { findMany: async () => [{ id: "s1", name: "Matematika" }] },
  grade: {
    findMany: async ({ where }) =>
      db.grades.filter((g) => inList(g.classId, where.classId) && inRange(g.date, where.date)),
  },
  attendance: {
    findMany: async ({ where }) =>
      db.attendance.filter(
        (a) => inList(a.userId, where.userId) && inRange(a.date, where.date) && inList(a.status, where.status),
      ),
  },
});
fakeModule("../src/services/holiday.service", { buildHolidaySet: async () => new Set() });
fakeModule("../src/services/vacationMonth.service", { getVacationSet: async () => new Set() });

const { getTeachersHours } = require("../src/services/lessonHours.service");

test("o'tilmagan darslar soatdan ayiriladi va sababi bilan qaytadi", async () => {
  const map = await getTeachersHours(["t1", "t2"], 202608);
  const t1 = map.get("t1");
  const t2 = map.get("t2");

  // Reja: 5 dushanba + 4 seshanba = 9; 24-avgust o'rinbosarga berilgan
  assert.equal(t1.scheduledHours, 9);
  assert.equal(t1.substitutedOutHours, 1);
  // O'tilmagan: 10 (baho yo'q), 17 (kelmagan), 18 (sababli), 25 (baho yo'q)
  assert.equal(t1.missedHours, 4);
  assert.deepEqual(t1.missedByReason, { absent: 1, excused: 1, noGrade: 2 });
  assert.equal(t1.hours, 9 - 1 - 4);
  assert.deepEqual(
    t1.missedLessons.map((m) => [m.dateLabel, m.lessonOrder, m.reason]),
    [
      ["10-avgust, 2026", 1, "noGrade"],
      ["17-avgust, 2026", 1, "absent"],
      ["18-avgust, 2026", 2, "excused"],
      ["25-avgust, 2026", 2, "noGrade"],
    ],
  );
  assert.equal(t1.missedLessons[1].reasonLabel, "Kelmagan");
  assert.equal(t1.judgedThroughDay, null);

  // O'rinbosar bahoni qo'ygan — soat o'rinbosarga
  assert.equal(t2.substitutedInHours, 1);
  assert.equal(t2.missedHours, 0);
  assert.equal(t2.hours, 1);

  // Kesimlar ham faqat o'tilganini sanaydi
  const cls = t1.byClass.find((row) => row.id === "c1");
  assert.equal(cls.hours, 4);
  assert.equal(cls.missed, 4);
});

test("o'rinbosar kelmagan bo'lsa soat hech kimga yozilmaydi", async () => {
  db.attendance.push({ userId: "t2", date: utc("2026-08-24"), status: "absent", autoMarked: true });
  try {
    const map = await getTeachersHours(["t1", "t2"], 202608);
    const t2 = map.get("t2");
    assert.equal(t2.hours, 0);
    assert.equal(t2.missedLessons[0].substituted, true);
    assert.equal(t2.missedLessons[0].autoMarked, true);
    // Dars egasiga ham qaytmaydi — u darsni bergan
    assert.equal(map.get("t1").hours, 4);
  } finally {
    db.attendance.pop();
  }
});

test("vedomost qatori: Oy = O'tildi + O'tilmadi + Qoldi", async () => {
  const { buildRow } = require("../src/services/lessonHoursDashboard.service");
  // Oy o'rtasida kesim: 15-avgustgacha "o'tildi", keyini "qoldi"
  const map = await getTeachersHours(["t1"], 202608, { asOfDayOfMonth: 15 });
  const hoursRow = map.get("t1");
  const row = buildRow({ id: "t1", firstName: "T", lastName: "1" }, null, null, hoursRow, null);

  assert.equal(row.plannedHours, row.taughtHours + row.missedHours + row.remainingHours);
  // Reja — jadval (o'rinbosarlik hisobga olingan), pul esa faqat o'tilgan + qolgan
  assert.equal(row.plannedHours, hoursRow.scheduledHours - hoursRow.substitutedOutHours + hoursRow.substitutedInHours);
  assert.equal(row.hours, row.taughtHours + row.remainingHours);
  assert.ok(row.remainingHours > 0 && row.taughtHours > 0 && row.missedHours > 0);
});
