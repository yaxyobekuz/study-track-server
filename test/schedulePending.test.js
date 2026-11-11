const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * TASDIQLANMAGAN SHEET TAHRIRI — O'QITUVCHI TOMONI.
 *
 * Tekshiriladi: sana → hafta kuni, farqdan AYNAN shu o'qituvchining
 * darslarini ajratish (darsi olinadigani ham, yangi dars beriladigani ham),
 * push ro'yxati va servisning holat qoidalari (rejim, tahrir holati,
 * "o'zgarish yo'q", kesh).
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const T1 = "a".repeat(24); // Aliyev — darsi o'zgaradi va bittasi olinadi
const T2 = "b".repeat(24); // Valiyev — ikki yangi dars oladi
const C1 = "c".repeat(24);
const C2 = "d".repeat(24);
const S1 = "e".repeat(24);
const S2 = "f".repeat(24);

const cell = (subjectId, subjectName, teacherId, teacherName) => ({
  subjectId,
  subjectName,
  teacherId,
  teacherName,
  startTime: "10:20",
  endTime: "11:05",
});

// 7-A: seshanba 3-dars fani o'zgaradi (T1 da qoladi), dushanba 1-dars T1 dan
//      T2 ga o'tadi. 8-B: juma 2-darsda T2 ga yangi dars qo'shiladi.
const DIFF = {
  totals: { added: 1, removed: 0, changed: 2, classesChanged: 2 },
  classes: [
    {
      classId: C1,
      className: "7-A",
      sheetLabel: "7-A",
      changes: [
        {
          day: "seshanba",
          dayLabel: "Seshanba",
          order: 3,
          type: "changed",
          field: "subject",
          before: cell(S1, "Fizika", T1, "Aliyev A."),
          after: cell(S2, "Kimyo", T1, "Aliyev A."),
        },
        {
          day: "dushanba",
          dayLabel: "Dushanba",
          order: 1,
          type: "changed",
          field: "teacher",
          before: cell(S1, "Fizika", T1, "Aliyev A."),
          after: cell(S1, "Fizika", T2, "Valiyev V."),
        },
      ],
    },
    {
      classId: C2,
      className: "8-B",
      sheetLabel: "8-B",
      changes: [
        {
          day: "juma",
          dayLabel: "Juma",
          order: 2,
          type: "added",
          field: null,
          before: null,
          after: cell(S2, "Kimyo", T2, "Valiyev V."),
        },
      ],
    },
  ],
};

// ─────────────────────────────────────────────
// Sof funksiyalar
// ─────────────────────────────────────────────

const helpers = require("../src/helpers/schedulePending.helpers");
const { buildSheetPendingPush } = require("../src/helpers/schedulePush.helpers");

test("sana → hafta kuni; berilmasa butun hafta", () => {
  assert.deepEqual(helpers.resolveDayFilter(undefined), { date: null, day: null });
  assert.deepEqual(helpers.resolveDayFilter("  "), { date: null, day: null });
  assert.deepEqual(helpers.resolveDayFilter("2026-11-10"), { date: "2026-11-10", day: "seshanba" });
  // Yakshanba qabul qilinadi — jadvalda bunday kun yo'q, ro'yxat bo'sh qoladi
  assert.deepEqual(helpers.resolveDayFilter("2026-11-08"), { date: "2026-11-08", day: "yakshanba" });
});

test("yaroqsiz sana rad etiladi (surilib ketmaydi)", () => {
  assert.throws(() => helpers.resolveDayFilter("10.11.2026"), /YYYY-MM-DD/);
  assert.throws(() => helpers.resolveDayFilter("2026-11-10T00:00:00Z"), /YYYY-MM-DD/);
  assert.throws(() => helpers.resolveDayFilter("2026-02-31"), /Sana noto'g'ri/);
  assert.throws(() => helpers.resolveDayFilter("2026-13-01"), /Sana noto'g'ri/);
});

test("farqdan faqat o'z darslari, kun tartibida", () => {
  const mine = helpers.teacherLessonsFromDiff(DIFF, T1);
  assert.equal(mine.length, 2);
  // Dushanba seshanbadan oldin (ro'yxat hafta kuni bo'yicha saralanadi)
  assert.deepEqual(
    mine.map((l) => `${l.day}:${l.order}:${l.mine}`),
    ["dushanba:1:before", "seshanba:3:both"],
  );
  assert.equal(mine[0].className, "7-A");
  // Katak nomlar bilan: ilova "Fizika → Kimyo" deb yozadi
  assert.deepEqual(mine[1].before, {
    subjectId: S1,
    subject: "Fizika",
    teacherId: T1,
    teacher: "Aliyev A.",
    startTime: "10:20",
    endTime: "11:05",
  });
  assert.equal(mine[1].after.subject, "Kimyo");
});

test("yangi dars beriladigan o'qituvchi ham ro'yxatda", () => {
  const mine = helpers.teacherLessonsFromDiff(DIFF, T2);
  assert.deepEqual(
    mine.map((l) => `${l.day}:${l.className}:${l.mine}:${l.type}`),
    ["dushanba:7-A:after:changed", "juma:8-B:after:added"],
  );
  // `added` da eski katak yo'q
  assert.equal(mine[1].before, null);
});

test("kun filtri va begona o'qituvchi", () => {
  assert.equal(helpers.teacherLessonsFromDiff(DIFF, T1, "seshanba").length, 1);
  assert.equal(helpers.teacherLessonsFromDiff(DIFF, T1, "juma").length, 0);
  assert.equal(helpers.teacherLessonsFromDiff(DIFF, T1, "yakshanba").length, 0);
  assert.equal(helpers.teacherLessonsFromDiff(DIFF, "z".repeat(24)).length, 0);
  assert.deepEqual(helpers.teacherLessonsFromDiff(null, T1), []);
});

test("push: ikki tomondagi o'qituvchilar va har kimning raqami", () => {
  assert.deepEqual(helpers.affectedTeacherIds(DIFF).sort(), [T1, T2].sort());
  assert.deepEqual(helpers.affectedTeacherIds(null), []);
  const counts = helpers.lessonCountByTeacher(DIFF);
  assert.equal(counts.get(T1), 2);
  assert.equal(counts.get(T2), 2);

  const push = buildSheetPendingPush({ revisionId: "r1", branchId: "b1", lessonCount: 2 });
  assert.match(push.body, /hali tasdiqlanmagan/);
  assert.match(push.body, /2 ta darsga/);
  assert.deepEqual(push.data, {
    type: "schedule",
    event: "sheet_pending",
    revisionId: "r1",
    branchId: "b1",
  });
});

// ─────────────────────────────────────────────
// Servis — holat qoidalari va kesh
// ─────────────────────────────────────────────

const state = {
  settings: { mode: "sheet", spreadsheetId: "sid", sheetTab: "Jadval" },
  latest: null,
  activeRows: [],
  mapping: { count: 0, updatedAt: null },
  result: null,
  reviewCalls: 0,
};

fakeModule("../src/config/prisma", {
  scheduleSyncSettings: { findUnique: async () => state.settings },
  scheduleSheetMapping: {
    aggregate: async () => ({
      _count: { _all: state.mapping.count },
      _max: { updatedAt: state.mapping.updatedAt },
    }),
  },
  scheduleSheetRevision: {
    findUnique: async ({ where }) => (state.latest?.id === where.id ? { ...state.latest, data: {} } : null),
  },
});
fakeModule("../src/config/branchContext", {
  requireBranch: () => ({ id: "b1", schemaName: "public" }),
  getBranch: () => ({ id: "b1", schemaName: "public" }),
  runWithBranch: (branch, fn) => fn(),
});
fakeModule("../src/services/scheduleWriteGuard.service", {
  MODES: { PLATFORM: "platform", SHEET: "sheet" },
});
fakeModule("../src/services/scheduleSyncReview.service", {
  findLatestRevision: async () => state.latest,
  loadActiveRows: async () => state.activeRows,
  reviewRevision: async () => {
    state.reviewCalls += 1;
    return { review: state.result };
  },
});

const pending = require("../src/services/scheduleSheetPending.service");

const DETECTED = new Date("2026-11-11T07:40:00Z");
const setPending = (overrides = {}) => {
  state.latest = { id: "r".repeat(24), status: "pending", createdAt: DETECTED, ...overrides };
  state.result = { diff: DIFF, hasChanges: true, errors: [] };
  state.reviewCalls = 0;
};

test("platforma rejimida ogohlantirish yo'q", async () => {
  setPending();
  state.settings = { mode: "platform" };
  const data = await pending.getPendingForTeacher(T1, {});
  assert.equal(data.mode, "platform");
  assert.equal(data.hasPending, false);
  assert.equal(data.schoolPending, false);
  assert.deepEqual(data.lessons, []);
  assert.equal(state.reviewCalls, 0);
  state.settings = { mode: "sheet", spreadsheetId: "sid", sheetTab: "Jadval" };
});

test("tahrir qo'llangan / rad etilgan bo'lsa darhol yo'qoladi", async () => {
  for (const status of ["applied", "rejected", "superseded"]) {
    setPending({ status });
    const data = await pending.getPendingForTeacher(T1, {});
    assert.equal(data.hasPending, false, status);
    assert.equal(data.revisionId, null, status);
    assert.equal(state.reviewCalls, 0, status);
  }
});

test("tahrir yo'q bo'lsa — bo'sh javob", async () => {
  state.latest = null;
  const data = await pending.getPendingForTeacher(T1, {});
  assert.equal(data.hasPending, false);
  assert.equal(data.schoolPending, false);
});

test("o'z darslari, sana yorlig'i va butun maktab belgisi", async () => {
  setPending();
  state.activeRows = [{ classId: C1, day: "dushanba", lessons: [] }];
  const data = await pending.getPendingForTeacher(T1, {});
  assert.equal(data.mode, "sheet");
  assert.equal(data.hasPending, true);
  assert.equal(data.schoolPending, true);
  assert.equal(data.diffAvailable, true);
  assert.equal(data.revisionId, state.latest.id);
  assert.equal(data.detectedAtLabel, "11-noyabr, 2026 12:40");
  assert.equal(data.lessons.length, 2);
});

test("o'zgarishi yo'q o'qituvchida ogohlantirish chiqmaydi", async () => {
  const data = await pending.getPendingForTeacher("z".repeat(24), {});
  // Butun maktabda tahrir bor, lekin bu o'qituvchining jadvali o'zgarmaydi
  assert.equal(data.schoolPending, true);
  assert.equal(data.hasPending, false);
  assert.deepEqual(data.lessons, []);
});

test("kun bo'yicha so'rov faqat o'sha kunni ko'radi", async () => {
  const tuesday = await pending.getPendingForTeacher(T1, { date: "2026-11-10" });
  assert.equal(tuesday.day, "seshanba");
  assert.equal(tuesday.hasPending, true);
  assert.equal(tuesday.lessons.length, 1);

  const wednesday = await pending.getPendingForTeacher(T1, { date: "2026-11-11" });
  assert.equal(wednesday.hasPending, false);
  assert.equal(wednesday.schoolPending, true);
  assert.deepEqual(wednesday.lessons, []);
});

test("farq bir marta hisoblanadi, jadval o'zgarsa qayta hisoblanadi", async () => {
  // Yangi tahrir — kesh kaliti oldingi testlardagidan boshqa
  setPending({ id: "n".repeat(24) });
  state.activeRows = [{ classId: C1, day: "chorshanba", lessons: [] }];
  await pending.getPendingForTeacher(T1, {});
  const first = state.reviewCalls;
  assert.equal(first, 1);

  // Boshqa o'qituvchilar ham bosh sahifani ochadi — hisob qaytarilmaydi
  await Promise.all([
    pending.getPendingForTeacher(T1, {}),
    pending.getPendingForTeacher(T2, { date: "2026-11-13" }),
  ]);
  assert.equal(state.reviewCalls, 1);

  // Amaldagi jadval o'zgardi (qo'llandi yoki qo'lda tenglashtirildi)
  state.activeRows = [
    { classId: C1, day: "chorshanba", lessons: [{ order: 1, subjectId: S1, teacherId: T2, position: 0 }] },
  ];
  await pending.getPendingForTeacher(T1, {});
  assert.equal(state.reviewCalls, 2);

  // Moslash qoidasi o'zgardi
  state.mapping = { count: 1, updatedAt: new Date("2026-11-11T08:00:00Z") };
  await pending.getPendingForTeacher(T1, {});
  assert.equal(state.reviewCalls, 3);
});

test("amaldagi jadval sheet bilan bir xil bo'lsa — ogohlantirish yo'q", async () => {
  setPending();
  state.result = { diff: DIFF, hasChanges: false, errors: [] };
  state.activeRows = [{ classId: C2, day: "juma", lessons: [] }];
  const data = await pending.getPendingForTeacher(T1, {});
  assert.equal(data.hasPending, false);
  assert.equal(data.schoolPending, false);
  assert.equal(data.revisionId, null);
});

test("sheet'da xato: tahrir bor, lekin qaysi dars ekani ma'lum emas", async () => {
  setPending();
  state.result = { diff: null, hasChanges: null, errors: [{ code: "lesson_unresolved" }] };
  state.activeRows = [{ classId: C2, day: "shanba", lessons: [] }];
  const data = await pending.getPendingForTeacher(T1, {});
  assert.equal(data.hasPending, true);
  assert.equal(data.schoolPending, true);
  assert.equal(data.diffAvailable, false);
  assert.deepEqual(data.lessons, []);
  assert.equal(data.revisionId, state.latest.id);
});

test("hisob yiqilsa o'qituvchi ilovasi yiqilmaydi", async () => {
  setPending();
  state.activeRows = [{ classId: C1, day: "payshanba", lessons: [] }];
  const review = require("../src/services/scheduleSyncReview.service");
  const original = review.reviewRevision;
  review.reviewRevision = async () => {
    throw new Error("buzilgan tahrir");
  };
  try {
    const data = await pending.getPendingForTeacher(T1, {});
    assert.equal(data.hasPending, false);
    assert.equal(data.mode, "sheet");
  } finally {
    review.reviewRevision = original;
  }
});
