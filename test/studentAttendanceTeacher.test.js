const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * O'QITUVCHI O'Z DARSIGA O'QUVCHILAR DAVOMATINI BELGILAYDI.
 *
 * Servislar HAQIQIY (darvoza ham, yozuv yadrosi ham), baza xotirada.
 * Tekshiriladi: sinflar qaysi manbadan chiqadi (o'z darsi, o'rinbosarlik,
 * SINF RAHBARLIGI), fanga baho ruxsati bu yo'lda UMUMAN so'ralmasligi,
 * yopiq kunlar, faqat bugun sharti, maktabda bo'lish sharti va yozuvning
 * yadroga qanday tushishi (sinf SERVERDAN, ro'yxatda yo'q o'quvchi rad
 * etiladi).
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const { currentDayDate } = require("../src/helpers/month.helpers");
const { dayKey } = require("../src/helpers/lessonHours");
const { DAYS_UZ } = require("../src/utils/constants");

const DAY_MS = 24 * 3600 * 1000;
const TODAY = currentDayDate();
const TODAY_NAME = DAYS_UZ[TODAY.getUTCDay()];
const IS_SUNDAY = TODAY.getUTCDay() === 0;

/** Oxirgi yakshanba — yopiq kun shoxini sanadan qat'i nazar tekshirish uchun. */
const SOME_SUNDAY = (() => {
  for (let n = 0; n <= 7; n += 1) {
    const date = new Date(TODAY.getTime() - n * DAY_MS);
    if (date.getUTCDay() === 0) return date;
  }
  return TODAY;
})();

const TEACHER = "a".repeat(24); // dars egasi
const SUB = "b".repeat(24); // o'rinbosar
const RECEPTION = "r".repeat(24); // qabulxona xodimi (kim belgilagani)
const CLASS_A = "1".repeat(24); // TEACHER ning o'z sinfi
const CLASS_B = "2".repeat(24); // TEACHER ning 2-darsi berib yuborilgan sinf
const CLASS_C = "3".repeat(24); // nofaol sinf
const CLASS_D = "4".repeat(24); // faqat fanga RUXSAT berilgan sinf
const SUBJECT = "9".repeat(24);

// Sinf rahbari roli — DINAMIK kalit (platforma belgisi bo'yicha topiladi)
const LEADER_ROLE = "sinf_rahbari";

const ALI = "aa1".padEnd(24, "0");
const VALI = "bb2".padEnd(24, "0");
const GONE = "cc3".padEnd(24, "0"); // davri yopilgan — ro'yxatda yo'q
const OTHER = "dd4".padEnd(24, "0"); // boshqa sinf o'quvchisi

const PERIODS = [
  { order: 1, startTime: "08:30", endTime: "09:15" },
  { order: 2, startTime: "09:25", endTime: "10:10" },
];

const db = {};

const reset = () => {
  db.schedules = [
    {
      id: "sch-a",
      classId: CLASS_A,
      day: TODAY_NAME,
      lessons: [
        { id: "l1", subjectId: SUBJECT, teacherId: TEACHER, order: 1, startTime: null, endTime: null, position: 0 },
      ],
    },
    {
      id: "sch-b",
      classId: CLASS_B,
      day: TODAY_NAME,
      lessons: [
        { id: "l2", subjectId: SUBJECT, teacherId: TEACHER, order: 2, startTime: "09:25", endTime: "10:10", position: 0 },
      ],
    },
    {
      id: "sch-c",
      classId: CLASS_C,
      day: TODAY_NAME,
      lessons: [
        { id: "l3", subjectId: SUBJECT, teacherId: TEACHER, order: 1, startTime: null, endTime: null, position: 0 },
      ],
    },
    {
      id: "sch-d",
      classId: CLASS_D,
      day: TODAY_NAME,
      lessons: [
        { id: "l4", subjectId: SUBJECT, teacherId: SUB, order: 1, startTime: null, endTime: null, position: 0 },
      ],
    },
  ];
  db.substitutions = [];
  db.holidays = new Set();
  db.vacations = new Set();
  db.settings = { gradingRequiresPresence: true };
  // O'qituvchi bugun maktabda
  db.staffAttendance = [
    { userId: TEACHER, date: TODAY, status: "present", checkIn: new Date(), checkOut: null },
  ];
  db.students = [
    { id: ALI, firstName: "Ali", lastName: "Aliyev", phone: "+998901112233", parentPhone: null, classIds: [CLASS_A] },
    { id: VALI, firstName: "Vali", lastName: "Valiyev", phone: null, parentPhone: null, classIds: [CLASS_A, CLASS_B] },
    { id: GONE, firstName: "Olim", lastName: "Olimov", phone: null, parentPhone: null, classIds: [CLASS_A] },
    { id: OTHER, firstName: "Sardor", lastName: "Sardorov", phone: null, parentPhone: null, classIds: [CLASS_D] },
  ];
  db.enrollments = [
    { id: "e1", studentId: ALI, startDate: new Date(TODAY.getTime() - 30 * DAY_MS), endDate: null, endReason: null },
    { id: "e2", studentId: VALI, startDate: new Date(TODAY.getTime() - 30 * DAY_MS), endDate: null, endReason: null },
    // Kecha yopilgan davr — bugun o'qimaydi
    { id: "e3", studentId: GONE, startDate: new Date(TODAY.getTime() - 30 * DAY_MS), endDate: new Date(TODAY.getTime() - DAY_MS), endReason: "left" },
    { id: "e4", studentId: OTHER, startDate: new Date(TODAY.getTime() - 30 * DAY_MS), endDate: null, endReason: null },
  ];
  db.records = [];
  db.upserts = [];
  // SINF RAHBARLIGI: biriktirishlar va rol belgisi qo'yilgan rol kalitlari
  db.classLeaders = [];
  db.leaderRoles = [LEADER_ROLE];
};
reset();

const CLASSES = new Map([
  [CLASS_A, { id: CLASS_A, name: "5-A", isActive: true }],
  [CLASS_B, { id: CLASS_B, name: "6-B", isActive: true }],
  [CLASS_C, { id: CLASS_C, name: "Yopiq sinf", isActive: false }],
  [CLASS_D, { id: CLASS_D, name: "7-D", isActive: true }],
]);

const PEOPLE = new Map([
  [TEACHER, { id: TEACHER, firstName: "Dildora", lastName: "Nurmatova" }],
  [SUB, { id: SUB, firstName: "Sardor", lastName: "Karimov" }],
  [RECEPTION, { id: RECEPTION, firstName: "Nigora", lastName: "Qosimova" }],
]);

const sameDay = (a, b) => new Date(a).getTime() === new Date(b).getTime();

/** Davr kunni qamraganmi (`endDate` INKLYUZIV). */
const covers = (row, day) =>
  row.startDate.getTime() <= day.getTime() &&
  (row.endDate === null || row.endDate.getTime() >= day.getTime());

fakeModule("../src/config/prisma", {
  scheduleLesson: {
    findMany: async ({ where }) =>
      db.schedules
        .filter((s) => s.day === where.schedule.day)
        .flatMap((s) =>
          s.lessons
            .filter((l) => l.teacherId === where.teacherId)
            .map(() => ({ schedule: { classId: s.classId } })),
        ),
  },
  schedule: {
    findMany: async ({ where }) =>
      db.schedules.filter(
        (s) => s.day === where.day && where.classId.in.includes(s.classId),
      ),
  },
  lessonSubstitutionItem: {
    findMany: async ({ where }) =>
      db.substitutions.filter(
        (item) => item.day === where.day && (!where.classId || item.classId === where.classId),
      ),
  },
  // ⚠️ Fanga baho ruxsati bu yo'lda UMUMAN so'ralmasligi kerak
  gradingGrant: {
    findMany: async () => {
      throw new Error("GradingGrant davomat yo'lida so'ralmasligi kerak");
    },
  },
  class: {
    findMany: async ({ where }) =>
      [...CLASSES.values()].filter(
        (c) =>
          where.id.in.includes(c.id) &&
          (where.isActive === undefined || c.isActive === where.isActive),
      ),
    findUnique: async ({ where }) => CLASSES.get(where.id) ?? null,
  },
  subject: {
    findMany: async ({ where }) =>
      where.id.in.includes(SUBJECT) ? [{ id: SUBJECT, name: "Matematika" }] : [],
  },
  user: {
    findMany: async ({ where, select }) => {
      // attachMarkedBy — xodim ismlari
      if (where.id?.in && !where.role) {
        return where.id.in.map((id) => PEOPLE.get(id)).filter(Boolean);
      }

      const wantedClasses = where.classes?.some?.classId;
      const classFilter =
        wantedClasses === undefined
          ? null
          : typeof wantedClasses === "string"
            ? [wantedClasses]
            : wantedClasses.in;

      const rows = db.students.filter(
        (s) => !classFilter || s.classIds.some((id) => classFilter.includes(id)),
      );

      // ⚠️ Ikki xil `select`: yig'indi yo'li faqat `classId`, ro'yxat yo'li
      // esa `class: { id, name }` so'raydi
      if (select.classes?.select?.classId) {
        return rows.map((s) => ({
          id: s.id,
          classes: s.classIds.map((id) => ({ classId: id })),
        }));
      }

      return rows
        .map((s) => ({
          id: s.id,
          firstName: s.firstName,
          lastName: s.lastName,
          phone: s.phone,
          parentPhone: s.parentPhone,
          classes: s.classIds.map((id) => ({
            class: { id, name: CLASSES.get(id).name },
          })),
        }))
        .sort((a, b) => a.lastName.localeCompare(b.lastName));
    },
  },
  studentEnrollment: {
    findMany: async ({ where }) =>
      db.enrollments.filter(
        (row) =>
          covers(row, TODAY) &&
          (!where.studentId || where.studentId.in.includes(row.studentId)),
      ),
  },
  studentAttendance: {
    findMany: async ({ where }) =>
      db.records.filter(
        (r) => sameDay(r.date, where.date) && where.studentId.in.includes(r.studentId),
      ),
    upsert: async ({ where, update, create }) => {
      db.upserts.push({ where, update, create });
      const existing = db.records.find(
        (r) =>
          r.studentId === where.studentId_date.studentId &&
          sameDay(r.date, where.studentId_date.date),
      );
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const row = { id: `rec${db.records.length + 1}`, ...create };
      db.records.push(row);
      return row;
    },
  },
  attendance: {
    findUnique: async ({ where }) =>
      db.staffAttendance.find(
        (a) =>
          a.userId === where.userId_date.userId && sameDay(a.date, where.userId_date.date),
      ) ?? null,
  },
  classLeader: {
    findMany: async ({ where }) =>
      db.classLeaders
        .filter((row) => row.leaderId === where.leaderId)
        .filter((row) => {
          const wanted = where.class?.isActive;
          if (wanted === undefined) return true;
          return (CLASSES.get(row.classId)?.isActive ?? false) === wanted;
        })
        .map((row) => ({ classId: row.classId })),
  },
});

// Rol belgilari platformada yotadi (`Role.isClassLeader` / `Role.isTutor`)
fakeModule("../src/config/platformPrisma", {
  role: {
    findMany: async ({ where } = {}) =>
      where?.isClassLeader ? db.leaderRoles.map((value) => ({ value })) : [],
  },
});

fakeModule("../src/services/settings.service", {
  getAttendanceSettings: async () => db.settings,
  getScheduleSettings: async () => ({ periods: PERIODS }),
});
fakeModule("../src/services/holiday.service", { buildHolidaySet: async () => db.holidays });
fakeModule("../src/services/vacationMonth.service", { getVacationSet: async () => db.vacations });
// `attendance.service` ning og'ir zanjiri (kassa, oylik, push) bu testga
// kerak emas — `studentAttendance.service` undan faqat kun normalizatorini oladi
fakeModule("../src/services/attendance.service", {
  getTodayNormalized: () => currentDayDate(),
  normalizeDateTashkent: (value) => {
    const d = new Date(value);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  },
});
fakeModule("../src/services/schedule.service", { getLessonDayMap: async () => new Map() });
fakeModule("../src/services/archivedStudentScope.service", {
  loadArchivedStudentScope: async () => ({}),
});

const service = require("../src/services/studentAttendanceTeacher.service");

const actor = { id: TEACHER, role: "teacher" };

/** TEACHER ning 2-darsi (6-B) SUB ga beriladi. */
const handOverSecondLesson = () => {
  db.substitutions.push({
    classId: CLASS_B,
    day: TODAY_NAME,
    lessonOrder: 2,
    subjectId: SUBJECT,
    snapshot: {},
    substitution: {
      id: "sub1",
      originalTeacherId: TEACHER,
      substituteTeacherId: SUB,
      teacherSnapshot: { substitute: { name: "Sardor Karimov" } },
    },
  });
};

/* ───────────────────────── Yopiq kunlar ───────────────────────── */

test("yopiq kunlar: yakshanba, bayram, ta'til oyi", async () => {
  reset();

  assert.equal((await service.buildDayState(SOME_SUNDAY)).closed, "sunday");

  if (!IS_SUNDAY) {
    assert.equal((await service.buildDayState(TODAY)).closed, null);

    db.holidays = new Set([dayKey(TODAY)]);
    assert.equal((await service.buildDayState(TODAY)).closed, "holiday");
    db.holidays = new Set();

    db.vacations = new Set([TODAY.getUTCFullYear() * 100 + TODAY.getUTCMonth() + 1]);
    assert.equal((await service.buildDayState(TODAY)).closed, "vacation");
    db.vacations = new Set();
  }
});

test("faqat BUGUN: o'tgan va kelasi kun rad etiladi", () => {
  assert.equal(service.resolveTeacherDay(undefined).getTime(), TODAY.getTime());
  assert.equal(service.resolveTeacherDay(dayKey(TODAY)).getTime(), TODAY.getTime());

  assert.throws(
    () => service.resolveTeacherDay(dayKey(new Date(TODAY.getTime() - DAY_MS))),
    /faqat BUGUNGI davomatni/,
  );
  assert.throws(
    () => service.resolveTeacherDay(dayKey(new Date(TODAY.getTime() + DAY_MS))),
    /faqat BUGUNGI davomatni/,
  );
});

/* ──────────────────── Sinflar: huquq jadvaldan ──────────────────── */

test("sinflar: o'z darsi chiqadi, nofaol sinf va fanga ruxsat sinfi chiqmaydi", async (t) => {
  if (IS_SUNDAY) return t.skip("yakshanba — dars yo'q");
  reset();

  const day = await service.getTeacherDay(actor, {});

  assert.equal(day.closed, null);
  assert.equal(day.canMark, true);
  assert.equal(day.date, dayKey(TODAY));
  // 5-A va 6-B; "Yopiq sinf" (nofaol) va 7-D (boshqa o'qituvchining darsi) yo'q
  assert.deepEqual(day.classes.map((c) => c.name), ["5-A", "6-B"]);
  assert.deepEqual(day.classes[0].lessons, [
    { order: 1, subjectId: SUBJECT, startTime: "08:30", substituted: false, subjectName: "Matematika" },
  ]);
  // Dars vaqti darsning O'ZIDAN (sozlamadan emas)
  assert.equal(day.classes[1].lessons[0].startTime, "09:25");

  // Yig'indi: 5-A da bugun o'qiyotgan ikki o'quvchi (davri yopilgani sanalmaydi)
  assert.equal(day.classes[0].summary.total, 2);
  assert.equal(day.classes[0].summary.unmarked, 2);
  assert.equal(day.classes[1].summary.total, 1);
});

test("o'rinbosarlik: berib yuborilgan dars egasidan olinadi, o'rinbosarga ochiladi", async (t) => {
  if (IS_SUNDAY) return t.skip("yakshanba — dars yo'q");
  reset();
  handOverSecondLesson();

  const owner = await service.getTeacherDay(actor, {});
  assert.deepEqual(owner.classes.map((c) => c.name), ["5-A"]);

  // SUB ning o'z darsi 7-D da, o'rinbosarlik esa 6-B da
  const sub = await service.getTeacherDay({ id: SUB, role: "teacher" }, {});
  assert.deepEqual(sub.classes.map((c) => c.name), ["6-B", "7-D"]);
  assert.equal(sub.classes[0].lessons[0].substituted, true);
  assert.equal(sub.classes[1].lessons[0].substituted, false);
});

test("eskirgan o'rinbosarlik katagi huquq bermaydi", async (t) => {
  if (IS_SUNDAY) return t.skip("yakshanba — dars yo'q");
  reset();
  // Katak boshqa o'qituvchining o'rniga tuzilgan, jadval esa o'zgargan
  db.substitutions.push({
    classId: CLASS_B,
    day: TODAY_NAME,
    lessonOrder: 2,
    subjectId: SUBJECT,
    snapshot: {},
    substitution: {
      id: "sub2",
      originalTeacherId: SUB,
      substituteTeacherId: RECEPTION,
      teacherSnapshot: {},
    },
  });

  const stale = await service.getTeacherDay({ id: RECEPTION, role: "teacher" }, {});
  assert.deepEqual(stale.classes, []);

  // Dars egasida esa huquq qoladi
  const owner = await service.getTeacherDay(actor, {});
  assert.deepEqual(owner.classes.map((c) => c.name), ["5-A", "6-B"]);
});

/* ──────────────────────── Sinf ro'yxati ──────────────────────── */

test("ro'yxat: faqat bugun o'qiyotganlar, kim belgilagani ko'rinadi", async (t) => {
  if (IS_SUNDAY) return t.skip("yakshanba — dars yo'q");
  reset();
  db.records.push({
    id: "rec0",
    studentId: ALI,
    classId: CLASS_A,
    date: TODAY,
    status: "late",
    markedAt: new Date(),
    excuseReason: null,
    absenceReason: null,
    autoMarked: false,
    lastModifiedBy: RECEPTION,
  });

  const roster = await service.getTeacherClassRoster(actor, { classId: CLASS_A });

  assert.equal(roster.classInfo.name, "5-A");
  assert.deepEqual(roster.students.map((r) => r.student.id), [ALI, VALI]);
  assert.equal(roster.summary.total, 2);
  assert.equal(roster.summary.late, 1);
  assert.equal(roster.summary.unmarked, 1);

  const [ali, vali] = roster.students;
  assert.deepEqual(ali.markedBy, {
    id: RECEPTION,
    name: "Nigora Qosimova",
    isMe: false,
  });
  assert.equal(vali.markedBy, null);
  // ⚠️ Telefon raqami o'qituvchi javobida YO'Q
  assert.equal("phone" in ali.student, false);
  assert.equal("parentPhone" in ali.student, false);
  assert.equal(ali.student.firstName, "Ali");
  assert.deepEqual(roster.lessons, [
    { order: 1, subjectId: SUBJECT, startTime: "08:30", substituted: false, subjectName: "Matematika" },
  ]);
});

test("begona sinf ro'yxati berilmaydi", async (t) => {
  if (IS_SUNDAY) return t.skip("yakshanba — dars yo'q");
  reset();

  await assert.rejects(
    service.getTeacherClassRoster(actor, { classId: CLASS_D }),
    /sinf rahbarligingizda ham emas/,
  );
  // Nofaol sinf ham begona
  await assert.rejects(
    service.getTeacherClassRoster(actor, { classId: CLASS_C }),
    /sinf rahbarligingizda ham emas/,
  );
});

/* ───────────────────────── Belgilash ───────────────────────── */

test("belgilash: sinf serverdan, yozuv yadroga tushadi", async (t) => {
  if (IS_SUNDAY) return t.skip("yakshanba — dars yo'q");
  reset();

  const result = await service.markTeacherAttendance(actor, {
    classId: CLASS_A,
    records: [
      // ⚠️ Panel boshqa sinf yuborsa ham e'tiborga olinmaydi
      { studentId: ALI, classId: CLASS_D, status: "present", excuseReason: "  " },
      { studentId: VALI, status: "excused", excuseReason: " shifokorda " },
    ],
  });

  assert.equal(result.length, 2);
  assert.equal(db.upserts.length, 2);
  assert.equal(db.upserts[0].create.classId, CLASS_A);
  assert.equal(db.upserts[0].create.createdBy, TEACHER);
  assert.equal(db.upserts[0].create.autoMarked, false);
  assert.equal(db.upserts[0].create.excuseReason, null);
  assert.equal(db.upserts[1].create.status, "excused");
  assert.equal(db.upserts[1].create.excuseReason, "shifokorda");
  // Kun — bugun (UTC yarim tuni)
  assert.equal(db.upserts[0].create.date.getTime(), TODAY.getTime());
});

test("belgilash rad etiladi: begona sinf, ro'yxatda yo'q o'quvchi, takror, xato holat", async (t) => {
  if (IS_SUNDAY) return t.skip("yakshanba — dars yo'q");
  reset();

  const records = [{ studentId: ALI, status: "present" }];

  await assert.rejects(
    service.markTeacherAttendance(actor, { classId: CLASS_D, records }),
    /sinf rahbarligingizda ham emas/,
  );

  // Boshqa sinfning o'quvchisi va davri yopilgani — ro'yxatda yo'q
  for (const studentId of [OTHER, GONE]) {
    await assert.rejects(
      service.markTeacherAttendance(actor, {
        classId: CLASS_A,
        records: [{ studentId, status: "present" }],
      }),
      /Ro'yxatda yo'q o'quvchi/,
    );
  }

  await assert.rejects(
    service.markTeacherAttendance(actor, {
      classId: CLASS_A,
      records: [
        { studentId: ALI, status: "present" },
        { studentId: ALI, status: "absent" },
      ],
    }),
    /ikki marta/,
  );

  await assert.rejects(
    service.markTeacherAttendance(actor, {
      classId: CLASS_A,
      records: [{ studentId: ALI, status: "keldi" }],
    }),
    /Noto'g'ri status/,
  );

  // ⚠️ YARIM YOZUV BO'LMAYDI: birinchi qator to'g'ri, ikkinchisi xato —
  // ikkalasi ham yozilmaydi (holat yozishdan OLDIN tekshiriladi)
  await assert.rejects(
    service.markTeacherAttendance(actor, {
      classId: CLASS_A,
      records: [
        { studentId: ALI, status: "present" },
        { studentId: VALI, status: "bor" },
      ],
    }),
    /Noto'g'ri status/,
  );

  await assert.rejects(
    service.markTeacherAttendance(actor, { classId: CLASS_A, records: [] }),
    /yozuvlar yo'q/,
  );

  assert.equal(db.upserts.length, 0);
});

test("maktabda bo'lmasa belgilanmaydi, sozlama o'chirilsa ochiladi", async (t) => {
  if (IS_SUNDAY) return t.skip("yakshanba — dars yo'q");
  reset();
  db.staffAttendance = [];

  const day = await service.getTeacherDay(actor, {});
  assert.equal(day.canMark, false);
  assert.equal(day.presence.atSchool, false);
  // Ro'yxat ko'rinishda qoladi — faqat yozish yopiladi
  assert.equal(day.classes.length, 2);

  await assert.rejects(
    service.markTeacherAttendance(actor, {
      classId: CLASS_A,
      records: [{ studentId: ALI, status: "present" }],
    }),
    /Siz maktabda emassiz/,
  );

  db.settings.gradingRequiresPresence = false;
  const marked = await service.markTeacherAttendance(actor, {
    classId: CLASS_A,
    records: [{ studentId: ALI, status: "present" }],
  });
  assert.equal(marked.length, 1);
});

test("bayram kunida belgilash yopiq", async (t) => {
  if (IS_SUNDAY) return t.skip("yakshanba — dars yo'q");
  reset();
  db.holidays = new Set([dayKey(TODAY)]);

  const day = await service.getTeacherDay(actor, {});
  assert.equal(day.closed, "holiday");
  assert.deepEqual(day.classes, []);

  await assert.rejects(
    service.markTeacherAttendance(actor, {
      classId: CLASS_A,
      records: [{ studentId: ALI, status: "present" }],
    }),
    /Bayram kuni/,
  );
});

/* ─────────────── Sinf rahbarligi: ikkinchi manba ─────────────── */

/** TEACHER ni 7-D (darsi yo'q sinf) ning rahbari qiladi. */
const makeLeaderOfD = () => {
  db.classLeaders.push({ leaderId: TEACHER, classId: CLASS_D });
};

const leaderActor = { id: TEACHER, role: "teacher", extraRoles: [LEADER_ROLE] };

test("sinf rahbarligi: DARSI YO'Q sinf ham ro'yxatga tushadi", async (t) => {
  if (IS_SUNDAY) return t.skip("yakshanba — dars yo'q");
  reset();
  makeLeaderOfD();

  const day = await service.getTeacherDay(leaderActor, {});

  // 7-D — TEACHER ning darsi YO'Q (u SUB ning darsi), lekin rahbarligida
  assert.deepEqual(day.classes.map((c) => c.name), ["5-A", "6-B", "7-D"]);

  const d = day.classes.find((c) => c.name === "7-D");
  assert.equal(d.access, "leader");
  // ⚠️ Darslar ro'yxati BO'SH bo'lishi normal hol: huquq jadvaldan emas
  assert.deepEqual(d.lessons, []);
  // Yig'indi baribir hisoblanadi (7-D da bitta o'quvchi)
  assert.equal(d.summary.total, 1);

  // Dars orqali kelgan sinflar o'z belgisini saqlaydi
  assert.equal(day.classes.find((c) => c.name === "5-A").access, "lesson");
});

test("ikki asos birlashadi: dars + rahbarlik → both", async (t) => {
  if (IS_SUNDAY) return t.skip("yakshanba — dars yo'q");
  reset();
  db.classLeaders.push({ leaderId: TEACHER, classId: CLASS_A });

  const day = await service.getTeacherDay(leaderActor, {});

  // Sinf IKKI MARTA chiqmaydi — bitta qator, ikki asos
  assert.deepEqual(day.classes.map((c) => c.name), ["5-A", "6-B"]);
  const a = day.classes.find((c) => c.name === "5-A");
  assert.equal(a.access, "both");
  // Darslari saqlanadi (rahbarlik ularni bosib ketmaydi)
  assert.equal(a.lessons.length, 1);
});

test("ROL BELGISI YO'Q bo'lsa biriktirish huquq bermaydi", async (t) => {
  if (IS_SUNDAY) return t.skip("yakshanba — dars yo'q");
  reset();
  makeLeaderOfD();

  // ⚠️ Biriktirish BOR, lekin odamda sinf rahbari roli YO'Q: rolni olish
  // aynan "bu odam endi sinf rahbari emas" degani
  const noRole = await service.getTeacherDay(actor, {});
  assert.deepEqual(noRole.classes.map((c) => c.name), ["5-A", "6-B"]);

  // Rolga belgi QO'YILMAGAN bo'lsa ham (platformada hech qaysi rol sinf
  // rahbari emas) — huquq yo'q
  db.leaderRoles = [];
  const noFlag = await service.getTeacherDay(leaderActor, {});
  assert.deepEqual(noFlag.classes.map((c) => c.name), ["5-A", "6-B"]);
});

test("nofaol sinfning rahbarligi ro'yxatga tushmaydi", async (t) => {
  if (IS_SUNDAY) return t.skip("yakshanba — dars yo'q");
  reset();
  db.classLeaders.push({ leaderId: SUB, classId: CLASS_C });

  const subLeader = { id: SUB, role: "teacher", extraRoles: [LEADER_ROLE] };
  const day = await service.getTeacherDay(subLeader, {});

  // "Yopiq sinf" (nofaol) chiqmaydi — SUB da faqat o'z darsi (7-D) qoladi
  assert.deepEqual(day.classes.map((c) => c.name), ["7-D"]);
});

test("sinf rahbari o'z sinfiga belgilaydi, begonasiga yo'q", async (t) => {
  if (IS_SUNDAY) return t.skip("yakshanba — dars yo'q");
  reset();
  makeLeaderOfD();

  // Ro'yxat ochiladi
  const roster = await service.getTeacherClassRoster(leaderActor, { classId: CLASS_D });
  assert.equal(roster.classInfo.name, "7-D");
  assert.equal(roster.access, "leader");
  assert.deepEqual(roster.lessons, []);
  assert.deepEqual(roster.students.map((r) => r.student.id), [OTHER]);

  // Yozuv yadroga tushadi, sinf SERVERDAN qo'yiladi
  const marked = await service.markTeacherAttendance(leaderActor, {
    classId: CLASS_D,
    records: [{ studentId: OTHER, status: "present" }],
  });
  assert.equal(marked.length, 1);
  assert.equal(db.upserts[0].create.classId, CLASS_D);
  assert.equal(db.upserts[0].create.status, "present");

  // Rahbarligida ham, darsida ham bo'lmagan sinf — 403
  db.classLeaders = [];
  await assert.rejects(
    service.markTeacherAttendance(leaderActor, {
      classId: CLASS_D,
      records: [{ studentId: OTHER, status: "present" }],
    }),
    /sinf rahbarligingizda ham emas/,
  );
});

test("sinf rahbariga ham maktabda bo'lish sharti qo'llanadi", async (t) => {
  if (IS_SUNDAY) return t.skip("yakshanba — dars yo'q");
  reset();
  makeLeaderOfD();
  db.staffAttendance = [];

  const day = await service.getTeacherDay(leaderActor, {});
  assert.equal(day.canMark, false);
  // Ro'yxat ko'rinadi, yozish yopiq — dars yo'li bilan AYNI
  assert.equal(day.classes.length, 3);

  await assert.rejects(
    service.markTeacherAttendance(leaderActor, {
      classId: CLASS_D,
      records: [{ studentId: OTHER, status: "present" }],
    }),
    /Siz maktabda emassiz/,
  );
});

test("o'quvchi bu yo'lga umuman kirmaydi", async () => {
  reset();
  const student = { id: ALI, role: "student" };

  await assert.rejects(service.getTeacherDay(student, {}), /xodimlar uchun/);
  await assert.rejects(
    service.getTeacherClassRoster(student, { classId: CLASS_A }),
    /xodimlar uchun/,
  );
  await assert.rejects(
    service.markTeacherAttendance(student, {
      classId: CLASS_A,
      records: [{ studentId: ALI, status: "present" }],
    }),
    /xodimlar uchun/,
  );
  assert.equal(db.upserts.length, 0);
});
