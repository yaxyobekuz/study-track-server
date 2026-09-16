const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * BAHO QO'YISH UCHUN MAKTABDA BO'LISH va DARSGA KELMAGANLAR.
 *
 * Ikkala servis ham bitta faktdan o'qiydi — o'qituvchining bugungi davomati:
 * kelgan ("keldi"/"kech keldi", admin qo'lda belgilagani ham) va hali
 * ketmagan bo'lsa — maktabda. Servislar haqiqiy, baza xotirada.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const { currentDayDate } = require("../src/helpers/month.helpers");
const { dayKey } = require("../src/helpers/lessonHours");

const DAY = 24 * 3600 * 1000;
const TODAY = currentDayDate();

/** Toshkent kunining HH:mm instanti. */
const at = (dayDate, hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(dayDate.getTime() - 5 * 3600 * 1000 + (h * 60 + m) * 60000);
};

/* ── Oxirgi dushanba (bugun emas) — o'tgan kun ro'yxati uchun ── */
const LAST_MONDAY = (() => {
  for (let n = 1; n <= 7; n += 1) {
    const date = new Date(TODAY.getTime() - n * DAY);
    if (date.getUTCDay() === 1) return date;
  }
  return null;
})();

const db = {
  settings: { gradingRequiresPresence: true },
  attendance: [],
  schedules: [],
  periods: [],
  cells: new Map(),
  holidays: new Set(),
};

const sameDay = (a, b) => a.getTime() === b.getTime();

fakeModule("../src/config/prisma", {
  attendance: {
    findUnique: async ({ where }) =>
      db.attendance.find(
        (a) => a.userId === where.userId_date.userId && sameDay(a.date, where.userId_date.date),
      ) ?? null,
    findMany: async ({ where }) =>
      db.attendance.filter((a) => where.userId.in.includes(a.userId) && sameDay(a.date, where.date)),
  },
  schedule: {
    findMany: async ({ where }) => db.schedules.filter((s) => s.day === where.day),
  },
  class: {
    findMany: async () => [
      { id: "c1", name: "5-A", isActive: true },
      { id: "c2", name: "6-B", isActive: true },
      { id: "c3", name: "Yopiq", isActive: false },
    ],
  },
  user: {
    findMany: async ({ where }) =>
      [
        { id: "t1", firstName: "Dildora", lastName: "Nurmatova", phone: "+998901112233" },
        { id: "t2", firstName: "Sardor", lastName: "Karimov", phone: null },
        { id: "t3", firstName: "Aziz", lastName: "Rahimov", phone: null },
        { id: "t4", firstName: "Malika", lastName: "Yusupova", phone: null },
      ].filter((u) => where.id.in.includes(u.id)),
  },
  subject: {
    findMany: async () => [
      { id: "s1", name: "Matematika" },
      { id: "s2", name: "Fizika" },
    ],
  },
});
fakeModule("../src/services/settings.service", {
  getAttendanceSettings: async () => db.settings,
  getScheduleSettings: async () => ({ periods: db.periods }),
});
fakeModule("../src/services/holiday.service", { buildHolidaySet: async () => db.holidays });
fakeModule("../src/services/vacationMonth.service", { getVacationSet: async () => new Set() });

const DAYS = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"];

fakeModule("../src/helpers/teacherAccess", {
  scheduleDayOf: (date) => (date.getUTCDay() === 0 ? null : DAYS[date.getUTCDay()]),
  getSubstitutionCells: async () => db.cells,
  effectiveTeacherOf: (lesson, cells) => {
    const cell = cells.get(`${lesson.classId}|${lesson.day}|${lesson.order}`);
    return cell && cell.originalTeacherId === lesson.teacherId
      ? { teacherId: cell.substituteTeacherId, substituted: true }
      : { teacherId: lesson.teacherId, substituted: false };
  },
});

const presence = require("../src/services/gradingPresence.service");
const absence = require("../src/services/lessonAbsence.service");

/* ───────────────────────── Maktabda bo'lish ───────────────────────── */

test("maktabda: kelgan va ketmagan; kelmagan / sababli / ketgan — yo'q", () => {
  assert.equal(presence.judgePresence({ status: "present", checkIn: new Date(), checkOut: null }).atSchool, true);
  assert.equal(presence.judgePresence({ status: "late", checkIn: new Date(), checkOut: null }).atSchool, true);
  // Admin qo'lda "keldi" qo'ygan — vaqtsiz ham maktabda
  assert.equal(presence.judgePresence({ status: "present", checkIn: null, checkOut: null }).atSchool, true);

  const none = presence.judgePresence(null);
  assert.equal(none.atSchool, false);
  assert.match(none.message, /^Siz maktabda emassiz/);
  assert.match(none.message, /Men keldim/);

  assert.equal(presence.judgePresence({ status: "absent" }).state, "notArrived");
  assert.equal(presence.judgePresence({ status: "excused" }).state, "excused");

  const left = presence.judgePresence({ status: "present", checkIn: at(TODAY, "08:00"), checkOut: at(TODAY, "13:05") });
  assert.equal(left.state, "left");
  assert.match(left.message, /13:05 da ketganingiz/);
});

test("getGradingPresence: owner ozod, sozlama o'chirilsa talab yo'q, aks holda bugungi davomat", async () => {
  db.attendance = [];
  db.settings.gradingRequiresPresence = true;

  assert.equal((await presence.getGradingPresence({ id: "o1", role: "owner" })).state, "exempt");

  await assert.rejects(presence.assertAtSchool({ id: "t1", role: "teacher" }), /Siz maktabda emassiz/);

  db.attendance.push({ userId: "t1", date: TODAY, status: "present", checkIn: at(TODAY, "08:00"), checkOut: null });
  // Kechagi yozuv bugungi qarorga ta'sir qilmaydi
  db.attendance.push({ userId: "t2", date: new Date(TODAY.getTime() - DAY), status: "present", checkIn: null, checkOut: null });

  assert.equal((await presence.assertAtSchool({ id: "t1", role: "teacher" })).atSchool, true);
  await assert.rejects(presence.assertAtSchool({ id: "t2", role: "teacher" }), /maktabda emassiz/);

  db.settings.gradingRequiresPresence = false;
  assert.equal((await presence.getGradingPresence({ id: "t2", role: "teacher" })).state, "disabled");
  db.settings.gradingRequiresPresence = true;
});

/* ───────────────────────── Darsga kelmaganlar ───────────────────────── */

test("dars holati: kelmagan, sababli, darsdan keyin, dars boshlangach, oldin ketgan", () => {
  const lesson = { startMin: 8 * 60 + 30, endMin: 9 * 60 + 15 };
  const judge = absence.judgeLessonPresence;

  assert.equal(judge(null, lesson), "absent");
  assert.equal(judge({ status: "absent" }, lesson), "absent");
  assert.equal(judge({ status: "excused" }, lesson), "excused");
  assert.equal(judge({ status: "late", checkIn: at(TODAY, "09:20") }, lesson), "cameAfter");
  assert.equal(judge({ status: "late", checkIn: at(TODAY, "08:40") }, lesson), "late");
  assert.equal(judge({ status: "present", checkIn: at(TODAY, "08:30") }, lesson), null);
  assert.equal(judge({ status: "present", checkIn: at(TODAY, "07:50"), checkOut: at(TODAY, "08:10") }, lesson), "left");
  assert.equal(judge({ status: "present", checkIn: null, checkOut: null }, lesson), null);
});

test("o'tgan kun ro'yxati: amaldagi o'qituvchi, dars vaqti sozlamadan, guruhlash", async () => {
  db.periods = [
    { order: 1, startTime: "08:30", endTime: "09:15" },
    { order: 2, startTime: "09:25", endTime: "10:10" },
  ];
  db.schedules = [
    {
      classId: "c1",
      day: "dushanba",
      lessons: [
        { teacherId: "t1", subjectId: "s1", order: 1, startTime: null, endTime: null },
        { teacherId: "t1", subjectId: "s1", order: 2, startTime: null, endTime: null },
      ],
    },
    {
      classId: "c2",
      day: "dushanba",
      lessons: [
        // O'z vaqti bor — sozlamadan ustun
        { teacherId: "t2", subjectId: "s2", order: 1, startTime: "08:00", endTime: "08:45" },
        // Egasi t4, o'rinbosar t3 — t3 tekshiriladi
        { teacherId: "t4", subjectId: "s2", order: 2, startTime: null, endTime: null },
      ],
    },
    { classId: "c3", day: "dushanba", lessons: [{ teacherId: "t1", subjectId: "s1", order: 3 }] },
  ];
  db.cells = new Map([["c2|dushanba|2", { originalTeacherId: "t4", substituteTeacherId: "t3" }]]);
  db.attendance = [
    // t1 — 09:20 da keldi: 1-darsdan keyin, 2-dars boshlanishidan oldin
    { userId: "t1", date: LAST_MONDAY, status: "late", checkIn: at(LAST_MONDAY, "09:20"), checkOut: null },
    // t2 — o'z vaqtida
    { userId: "t2", date: LAST_MONDAY, status: "present", checkIn: at(LAST_MONDAY, "07:55"), checkOut: null },
    // t4 — kelmagan, lekin darsi o'rinbosarda; t3 umuman qayd etilmagan
    { userId: "t4", date: LAST_MONDAY, status: "absent", checkIn: null, checkOut: null },
  ];

  const result = await absence.getLessonAbsentees({ date: dayKey(LAST_MONDAY) });

  assert.equal(result.isToday, false);
  assert.equal(result.closed, null);
  assert.deepEqual(result.teachers.map((t) => [t.teacherId, t.state]), [["t3", "absent"], ["t1", "cameAfter"]]);

  const t3 = result.teachers[0];
  assert.equal(t3.lessons.length, 1);
  assert.equal(t3.lessons[0].substituted, true);
  assert.equal(t3.lessons[0].startTime, "09:25");
  assert.equal(t3.lessons[0].stateLabel, "Kelmagan");

  const t1 = result.teachers[1];
  assert.equal(t1.arrivedAtLabel, "09:20");
  assert.deepEqual(t1.lessons.map((l) => [l.lessonOrder, l.className, l.subjectName, l.startTime]), [
    [1, "5-A", "Matematika", "08:30"],
  ]);

  assert.deepEqual(result.summary, {
    teachers: 2,
    lessons: 2,
    ongoingLessons: 0,
    absentTeachers: 1,
    lateTeachers: 1,
    untimedLessons: 0,
  });
});

test("bugun: faqat boshlangan darslar, hozirgi dars belgilanadi, vaqtsiz dars sanaladi", async (t) => {
  const nowMin = absence.tashkentMinutesOf(new Date());
  if (nowMin < 3 || nowMin > 24 * 60 - 3) return t.skip("yarim tunga juda yaqin");
  if (TODAY.getUTCDay() === 0) return t.skip("yakshanba");

  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  const dayName = DAYS[TODAY.getUTCDay()];

  db.periods = [];
  db.cells = new Map();
  db.holidays = new Set();
  db.schedules = [
    {
      classId: "c1",
      day: dayName,
      lessons: [
        // Hozir davom etmoqda
        { teacherId: "t1", subjectId: "s1", order: 1, startTime: hhmm(nowMin - 2), endTime: hhmm(nowMin + 2) },
        // Hali boshlanmagan
        { teacherId: "t1", subjectId: "s1", order: 2, startTime: hhmm(nowMin + 2), endTime: hhmm(Math.min(nowMin + 3, 1439)) },
        // Vaqti yo'q
        { teacherId: "t2", subjectId: "s1", order: 3, startTime: null, endTime: null },
      ],
    },
  ];
  db.attendance = [];

  const result = await absence.getLessonAbsentees();
  assert.equal(result.isToday, true);
  assert.equal(result.periodsConfigured, false);
  assert.equal(result.teachers.length, 1);
  assert.equal(result.teachers[0].lessons.length, 1);
  assert.equal(result.teachers[0].lessons[0].ongoing, true);
  assert.equal(result.summary.ongoingLessons, 1);
  assert.equal(result.summary.untimedLessons, 1);

  // Bayram kuni — ro'yxat yopiq
  db.holidays = new Set([dayKey(TODAY)]);
  const holiday = await absence.getLessonAbsentees();
  assert.equal(holiday.closed, "holiday");
  db.holidays = new Set();

  await assert.rejects(
    absence.getLessonAbsentees({ date: dayKey(new Date(TODAY.getTime() + DAY)) }),
    /Kelajakdagi/,
  );
});
