const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * FANGA BAHO QO'YISH RUXSATI (`GradingGrant`).
 *
 * Tekshiriladi: huquq hal qiluvchisi ruxsatni qanday qo'llaydi (ustunlik,
 * bitta dars, o'rinbosarlik bilan to'qnashuv), davr presetlari va chegaralari,
 * ruxsat yaratishdagi rad etishlar. Baza xotirada.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const hex = (c) => c.repeat(24);
const ACTOR = hex("a");
const OWNER = hex("b");
const OTHER = hex("e");
const CLASS = hex("c");
const ENGLISH = hex("1");
const MOTHER_TONGUE = hex("2");
const ADMIN = hex("f");

const db = {
  users: new Map(),
  classes: new Map(),
  subjects: new Map(),
  lessons: [],
  grants: [],
};

const reset = () => {
  db.users = new Map([
    [ACTOR, { id: ACTOR, firstName: "Ona tili", lastName: "O'qituvchi", role: "teacher", extraRoles: [], isArchived: false }],
    [OWNER, { id: OWNER, firstName: "Ingliz", lastName: "O'qituvchi", role: "teacher", extraRoles: [], isArchived: false }],
    [ADMIN, { id: ADMIN, firstName: "Boshliq", lastName: "", role: "owner", extraRoles: [], isArchived: false }],
  ]);
  db.classes = new Map([[CLASS, { id: CLASS, name: "11-A", isActive: true }]]);
  db.subjects = new Map([
    [ENGLISH, { id: ENGLISH, name: "Ingliz tili" }],
    [MOTHER_TONGUE, { id: MOTHER_TONGUE, name: "Ona tili" }],
  ]);
  // Haftalik jadval: dushanba 2-dars va chorshanba 4-dars — ingliz tili (OWNER),
  // dushanba 3-dars — ona tili (ACTOR)
  db.lessons = [
    { subjectId: ENGLISH, teacherId: OWNER, order: 2, schedule: { day: "dushanba", classId: CLASS } },
    { subjectId: ENGLISH, teacherId: OWNER, order: 4, schedule: { day: "chorshanba", classId: CLASS } },
    { subjectId: MOTHER_TONGUE, teacherId: ACTOR, order: 3, schedule: { day: "dushanba", classId: CLASS } },
  ];
  db.grants = [];
};
reset();

const pick = (row, select) =>
  select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row;

const prismaFake = {
  user: {
    findUnique: async ({ where, select }) => {
      const row = db.users.get(where.id);
      return row ? pick(row, select) : null;
    },
    findMany: async ({ where }) => [...db.users.values()].filter((u) => where.id.in.includes(u.id)),
  },
  class: {
    findUnique: async ({ where }) => db.classes.get(where.id) ?? null,
    findMany: async ({ where }) => [...db.classes.values()].filter((c) => where.id.in.includes(c.id)),
  },
  subject: {
    findUnique: async ({ where }) => db.subjects.get(where.id) ?? null,
    findMany: async ({ where }) => [...db.subjects.values()].filter((s) => where.id.in.includes(s.id)),
  },
  scheduleLesson: {
    findMany: async ({ where }) =>
      db.lessons.filter(
        (l) => l.subjectId === where.subjectId && l.schedule.classId === where.schedule.classId,
      ),
  },
  holiday: { findMany: async () => [] },
  gradingGrant: {
    findFirst: async ({ where }) =>
      db.grants.find(
        (g) =>
          g.teacherId === where.teacherId &&
          g.classId === where.classId &&
          g.subjectId === where.subjectId &&
          g.revokedAt === null &&
          g.dateFrom <= where.dateFrom.lte &&
          g.dateTo >= where.dateTo.gte &&
          where.OR.some((c) => c.lessonOrder === g.lessonOrder),
      ) ?? null,
    create: async ({ data }) => {
      const row = { id: hex(String(db.grants.length + 3)), revokedAt: null, revokedBy: null, revokeReason: "", createdAt: new Date(), ...data };
      db.grants.push(row);
      return row;
    },
  },
  lessonSubstitutionItem: { findMany: async () => [] },
  $executeRaw: async () => 0,
  $transaction: async (fn) => fn(prismaFake),
};

fakeModule("../src/config/prisma", prismaFake);

const { resolveLessonAccess } = require("../src/helpers/teacherAccess");
const {
  parseWindow,
  presetEnd,
  countOpenedLessons,
  createGrant,
  statusOf,
} = require("../src/services/gradingGrant.service");

const day = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const TODAY = day(2026, 9, 30); // chorshanba
const MONDAY = day(2026, 10, 5);

const actor = { id: ACTOR };
const mondayLessons = [
  { id: "l2", subjectId: ENGLISH, teacherId: OWNER, order: 2 },
  { id: "l3", subjectId: MOTHER_TONGUE, teacherId: ACTOR, order: 3 },
  { id: "l5", subjectId: ENGLISH, teacherId: OTHER, order: 5 },
];
const grant = (over = {}) => ({ id: hex("9"), classId: CLASS, subjectId: ENGLISH, lessonOrder: null, ...over });

/* ─────────────────────── HUQUQ HAL QILUVCHISI ─────────────────────── */

test("ruxsatsiz — boshqaning darsi yopiq", async () => {
  const access = await resolveLessonAccess({
    actor,
    classId: CLASS,
    subjectId: ENGLISH,
    date: MONDAY,
    lessons: mondayLessons,
    cells: new Map(),
    grants: [],
  });
  assert.equal(access.allowed, false);
});

test("ruxsat sinf+fanning boshqa o'qituvchilardagi HAMMA darslarini ochadi", async () => {
  const access = await resolveLessonAccess({
    actor,
    classId: CLASS,
    subjectId: ENGLISH,
    date: MONDAY,
    lessons: mondayLessons,
    cells: new Map(),
    grants: [grant()],
  });
  assert.equal(access.allowed, true);
  assert.equal(access.via, "grant");
  assert.deepEqual(
    access.lessons.map((l) => [l.order, l.access, l.grantId]),
    [
      [2, "grant", hex("9")],
      [5, "grant", hex("9")],
    ],
  );
});

test("bitta darsga ruxsat faqat o'sha tartibni ochadi", async () => {
  const access = await resolveLessonAccess({
    actor,
    classId: CLASS,
    subjectId: ENGLISH,
    date: MONDAY,
    lessons: mondayLessons,
    cells: new Map(),
    grants: [grant({ lessonOrder: 5 })],
  });
  assert.deepEqual(access.lessons.map((l) => l.order), [5]);
});

test("o'z darsi o'z darsi bo'lib qoladi — ruxsat uni belgilamaydi (oylikdan tushmasin)", async () => {
  const access = await resolveLessonAccess({
    actor,
    classId: CLASS,
    date: MONDAY,
    lessons: mondayLessons,
    cells: new Map(),
    grants: [grant({ subjectId: MOTHER_TONGUE })],
  });
  assert.deepEqual(
    access.lessons.map((l) => [l.order, l.access, l.grantId]),
    [[3, "own", null]],
  );
  assert.equal(access.via, "own");
});

test("boshqa fanga ruxsat bu fanni ochmaydi, boshqa sinfga ham", async () => {
  const access = await resolveLessonAccess({
    actor,
    classId: CLASS,
    subjectId: ENGLISH,
    date: MONDAY,
    lessons: mondayLessons,
    cells: new Map(),
    grants: [grant({ subjectId: MOTHER_TONGUE }), grant({ classId: hex("d") })],
  });
  assert.equal(access.allowed, false);
});

test("o'rinbosarga berilgan O'Z darsini ruxsat qayta ochmaydi", async () => {
  const cells = new Map([
    [
      `${CLASS}|dushanba|3`,
      {
        classId: CLASS,
        substitutionId: hex("7"),
        originalTeacherId: ACTOR,
        substituteTeacherId: OTHER,
        teacherSnapshot: { substitute: { name: "O'rinbosar" } },
      },
    ],
  ]);
  const access = await resolveLessonAccess({
    actor,
    classId: CLASS,
    subjectId: MOTHER_TONGUE,
    date: MONDAY,
    lessons: mondayLessons,
    cells,
    grants: [grant({ subjectId: MOTHER_TONGUE })],
  });
  assert.equal(access.allowed, false);
  assert.match(access.message, /O'rinbosar ga berilgan/);
});

test("yakshanba — ruxsat bo'lsa ham dars yo'q", async () => {
  const access = await resolveLessonAccess({
    actor,
    classId: CLASS,
    date: day(2026, 10, 4),
    lessons: mondayLessons,
    cells: new Map(),
    grants: [grant()],
  });
  assert.equal(access.allowed, false);
});

/* ─────────────────────── DAVR ─────────────────────── */

test("presetlar: 1 hafta = 7 kun, 1 oy, 1 yil — hammasi inklyuziv", () => {
  assert.deepEqual(presetEnd(TODAY, "1w"), day(2026, 10, 6));
  assert.deepEqual(presetEnd(TODAY, "1m"), day(2026, 10, 29));
  assert.deepEqual(presetEnd(TODAY, "1y"), day(2027, 9, 29));
  assert.deepEqual(presetEnd(day(2027, 2, 1), "1m"), day(2027, 2, 28));
  // Kabisa yili: 1 yil 366 kundan oshmaydi
  const { from, to } = parseWindow({ preset: "1y", dateFrom: "2027-03-01" }, TODAY);
  assert.equal(Math.round((to - from) / 86400000) + 1, 366);
});

test("davr: bugundan sukut, o'tgan kun va 1 yildan uzuni rad etiladi", () => {
  const win = parseWindow({ preset: "1w" }, TODAY);
  assert.deepEqual([win.from, win.to, win.lessonOrder], [TODAY, day(2026, 10, 6), null]);

  assert.throws(() => parseWindow({ preset: "1w", dateFrom: "2026-09-29" }, TODAY), /O'tgan kunga/);
  assert.throws(
    () => parseWindow({ preset: "custom", dateFrom: "2026-10-01", dateTo: "2027-10-02" }, TODAY),
    /1 yildan oshmasin/,
  );
  assert.throws(
    () => parseWindow({ preset: "custom", dateFrom: "2026-10-05", dateTo: "2026-10-01" }, TODAY),
    /Oraliq noto'g'ri/,
  );
  assert.throws(() => parseWindow({ preset: "2y" }, TODAY), /Muddatni tanlang/);
  assert.throws(() => parseWindow({ mode: "boshqa" }, TODAY), /Ruxsat turini/);
});

test("bitta dars: sana + tartib majburiy, o'tgan kun yo'q", () => {
  const win = parseWindow({ mode: "lesson", date: "2026-10-05", lessonOrder: 2 }, TODAY);
  assert.deepEqual([win.from, win.to, win.lessonOrder], [MONDAY, MONDAY, 2]);
  assert.throws(() => parseWindow({ mode: "lesson", date: "2026-10-05" }, TODAY), /Darsni tanlang/);
  assert.throws(() => parseWindow({ mode: "lesson", date: "2026-09-28", lessonOrder: 2 }, TODAY), /O'tgan kunga/);
});

test("holat: kutilmoqda → amalda → muddati tugagan; yopilgani doim yopilgan", () => {
  const row = { revokedAt: null, dateFrom: day(2026, 10, 1), dateTo: day(2026, 10, 7) };
  assert.equal(statusOf(row, TODAY), "upcoming");
  assert.equal(statusOf(row, day(2026, 10, 7)), "active");
  assert.equal(statusOf(row, day(2026, 10, 8)), "expired");
  assert.equal(statusOf({ ...row, revokedAt: new Date() }, day(2026, 10, 3)), "revoked");
});

test("ochilgan darslar soni: o'z darslari va bayram chiqariladi", () => {
  const cells = [
    { day: "dushanba", order: 2, teacherId: OWNER },
    { day: "dushanba", order: 3, teacherId: ACTOR },
    { day: "chorshanba", order: 4, teacherId: OWNER },
  ];
  // 5-oktabr (dush) — 11-oktabr (yak): dushanba + chorshanba
  const window = { from: MONDAY, to: day(2026, 10, 11), lessonOrder: null };
  assert.equal(countOpenedLessons(cells, window, ACTOR, new Set()), 2);
  assert.equal(countOpenedLessons(cells, window, ACTOR, new Set(["2026-10-07"])), 1);
  assert.equal(countOpenedLessons(cells, { ...window, lessonOrder: 4 }, ACTOR, new Set()), 1);
});

/* ─────────────────────── RUXSAT BERISH ─────────────────────── */

// `createGrant` haqiqiy bugungi kundan hisoblaydi — sanalar unga nisbatan
const { currentDayDate } = require("../src/helpers/month.helpers");
const { dayKey } = require("../src/helpers/lessonHours");
const REAL_TODAY = currentDayDate();
const NEXT_MONDAY = new Date(REAL_TODAY.getTime() + (((8 - REAL_TODAY.getUTCDay()) % 7) || 7) * 86400000);
const NEXT_SUNDAY = new Date(NEXT_MONDAY.getTime() - 86400000);

const base = () => ({
  teacherId: ACTOR,
  classId: CLASS,
  subjectId: ENGLISH,
  preset: "1m",
  reason: "IELTS sertifikati",
});

test("ruxsat beriladi — ochilgan darslar soni bilan", async () => {
  reset();
  const row = await createGrant(base(), ADMIN);
  assert.equal(row.mode, "period");
  assert.equal(row.className, "11-A");
  assert.equal(row.subjectName, "Ingliz tili");
  assert.equal(row.teacherName, "Ona tili O'qituvchi");
  assert.equal(row.grantedByName, "Boshliq");
  assert.equal(row.scopeLabel, "Barcha darslar");
  assert.ok(row.openedLessons > 0);
  assert.equal(db.grants.length, 1);
});

test("aynan takror (to'liq qamrab olingan) rad etiladi, qisman kesishgani emas", async () => {
  reset();
  await createGrant({ ...base(), preset: "1w" }, ADMIN);
  await assert.rejects(() => createGrant({ ...base(), preset: "1w" }, ADMIN), /allaqachon bor/);
  // Kengroq davr eskisini to'liq qamramaydi, aksincha — u yoziladi (huquq qo'shiladi)
  await createGrant(base(), ADMIN);
  assert.equal(db.grants.length, 2);
  // Bitta dars ham oylik ruxsat ichida — takror
  await assert.rejects(
    () => createGrant({ ...base(), mode: "lesson", date: dayKey(NEXT_MONDAY), lessonOrder: 2 }, ADMIN),
    /allaqachon bor/,
  );
});

test("jadvalda yo'q fan, o'z darsi va noto'g'ri dars rad etiladi", async () => {
  reset();
  db.subjects.set(hex("3"), { id: hex("3"), name: "Kimyo" });
  await assert.rejects(() => createGrant({ ...base(), subjectId: hex("3") }, ADMIN), /Kimyo darsi yo'q/);
  await assert.rejects(
    () => createGrant({ ...base(), subjectId: MOTHER_TONGUE }, ADMIN),
    /o'zida — ruxsat kerak emas/,
  );
  await assert.rejects(
    () => createGrant({ ...base(), mode: "lesson", date: dayKey(NEXT_MONDAY), lessonOrder: 4 }, ADMIN),
    /4-dars Ingliz tili emas/,
  );
  await assert.rejects(
    () => createGrant({ ...base(), mode: "lesson", date: dayKey(NEXT_SUNDAY), lessonOrder: 2 }, ADMIN),
    /yakshanba/,
  );
});

test("faqat o'qituvchi rolidagi, arxivlanmagan xodimga", async () => {
  reset();
  db.users.set(OTHER, { id: OTHER, firstName: "Kassir", lastName: "", role: "cashier", extraRoles: [], isArchived: false });
  await assert.rejects(() => createGrant({ ...base(), teacherId: OTHER }, ADMIN), /o'qituvchi rolida emas/);

  db.users.set(OTHER, { ...db.users.get(OTHER), extraRoles: ["teacher"], isArchived: true });
  await assert.rejects(() => createGrant({ ...base(), teacherId: OTHER }, ADMIN), /arxivlangan/);

  db.users.set(OTHER, { ...db.users.get(OTHER), isArchived: false });
  const row = await createGrant({ ...base(), teacherId: OTHER }, ADMIN);
  assert.equal(row.teacherId, OTHER);
});

/* ─────────────────────── RUXSAT KALITI ─────────────────────── */

test("ruxsat berish — alohida bo'lim: eski bare \"grades\" kaliti uni BERMAYDI", () => {
  const { PERMISSIONS, hasPermission, expandLegacyKeys } = require("../src/utils/permissions");
  assert.equal(PERMISSIONS.GRADEGRANTS_VIEW, "gradeGrants.view");
  assert.equal(PERMISSIONS.GRADEGRANTS_MANAGE, "gradeGrants.manage");
  assert.equal(hasPermission(["grades"], PERMISSIONS.GRADEGRANTS_MANAGE), false);
  assert.ok(!expandLegacyKeys(["grades"]).some((key) => key.startsWith("gradeGrants.")));
  assert.equal(hasPermission(["gradeGrants.manage"], PERMISSIONS.GRADEGRANTS_MANAGE), true);
});
