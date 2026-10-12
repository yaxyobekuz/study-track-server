const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * FILIALLARARO KO'CHIRISH — DARS JADVALI VA KATALOG MOSLASHTIRGICH.
 *
 * Himoya qilinadigan narsa:
 *   · dars FAQAT o'qituvchi maqsad filialda HAQIQATAN bor bo'lsa ko'chadi —
 *     nomi bo'yicha moslanmaydi (bu jim huquq berish va begona odamga soat
 *     yozish bo'lardi);
 *   · maqsadda o'sha katakda band o'qituvchining darsi ko'chmaydi;
 *   · bitta ko'chirishda ikki sinf bitta katakni talab qilsa, ikkinchisi
 *     ham band hisoblanadi (nusxa o'zi to'qnashuv yaratmasin);
 *   · manbadan o'chirish KEYINGI OY boshida (jadval sanasiz shablon);
 *   · fan nomi bo'yicha moslanadi va yo'g'i ochiladi, o'qituvchi esa
 *     HECH QACHON ochilmaydi;
 *   · to'lov turi nom bo'yicha moslanadi, mos kelmasa — yo faol birinchi
 *     hisob, yo (faol hisob yo'q bo'lsa) hech narsa.
 */

const {
  planClassSchedules,
} = require("../src/services/branchTransferSchedule.service");
const {
  mapSubjects,
  mapClasses,
  presentStaff,
  mapPaymentAccounts,
  nameKey,
} = require("../src/services/branchTransferCatalog.service");

const SRC = "public";
const TGT = "br_b";
const ctx = {
  source: { id: "a".repeat(24), name: "Chilonzor", schemaName: SRC },
  target: { id: "b".repeat(24), name: "Yunusobod", schemaName: TGT },
  actor: { id: "u".repeat(24), name: "Admin" },
  month: 202610,
};

const T1 = "t".repeat(24);
const T2 = "q".repeat(24);
const CLASS = "c".repeat(24);
const SUB = "f".repeat(24);

const lesson = (over = {}) => ({
  classId: CLASS,
  day: "monday",
  id: "l1",
  subjectId: SUB,
  teacherId: T1,
  order: 1,
  startTime: "08:30",
  endTime: "09:15",
  position: 0,
  ...over,
});

const fakeDb = (data, writes = []) => ({
  $queryRawUnsafe: async (sql) => {
    if (sql.includes(`"${TGT}"."schedule_lessons"`)) return data.targetLessons ?? [];
    if (sql.includes(`"${SRC}"."schedule_lessons"`)) return data.lessons ?? [];
    if (sql.includes(`"${SRC}"."subjects"`)) return data.subjects ?? [];
    if (sql.includes(`"${TGT}"."subjects"`)) return data.targetSubjects ?? [];
    if (sql.includes(`"${SRC}"."users"`)) return data.users ?? [];
    if (sql.includes(`"${TGT}"."users"`)) return data.targetUsers ?? [];
    if (sql.includes(`"${SRC}"."classes"`)) return data.classes ?? [];
    if (sql.includes(`"${TGT}"."classes"`)) return data.targetClasses ?? [];
    if (sql.includes(`"${TGT}"."payment_accounts"`)) return data.targetAccounts ?? [];
    if (sql.includes(`"${SRC}"."payment_accounts"`)) return data.sourceAccounts ?? [];
    throw new Error(`Kutilmagan so'rov: ${sql.slice(0, 90)}`);
  },
  $executeRawUnsafe: async (sql, ...params) => {
    writes.push({ sql, params });
    return 1;
  },
});

const classes = [{ id: CLASS, name: "IT 3" }];

test("o'qituvchi maqsad filialda bor — dars ko'chadi", async () => {
  const db = fakeDb({
    lessons: [lesson()],
    subjects: [{ id: SUB, name: "Matematika" }],
    users: [{ id: T1, firstName: "Ali", lastName: "Valiyev" }],
    targetUsers: [{ id: T1 }],
  });
  const plans = await planClassSchedules(db, ctx, classes);
  const plan = plans.get(CLASS);

  assert.equal(plan.total, 1);
  assert.equal(plan.moving, 1);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.subjectIds, [SUB]);
  // Manbadan o'chirish KEYINGI oy boshida
  assert.equal(plan.removalMonth, 202611);
});

test("o'qituvchi maqsad filialda yo'q — dars ko'chmaydi, sababi aytiladi", async () => {
  const db = fakeDb({
    lessons: [lesson()],
    subjects: [{ id: SUB, name: "Matematika" }],
    users: [{ id: T1, firstName: "Ali", lastName: "Valiyev" }],
    targetUsers: [], // o'sha filialda bunday xodim yo'q
  });
  const plan = (await planClassSchedules(db, ctx, classes)).get(CLASS);

  assert.equal(plan.moving, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, "teacher_missing");
  assert.equal(plan.skipped[0].teacher, "Ali Valiyev");
  assert.equal(plan.skipped[0].subject, "Matematika");
});

test("maqsadda o'sha katak band — dars ko'chmaydi", async () => {
  const db = fakeDb({
    lessons: [lesson()],
    subjects: [{ id: SUB, name: "Matematika" }],
    users: [{ id: T1, firstName: "Ali", lastName: "Valiyev" }],
    targetUsers: [{ id: T1 }],
    targetLessons: [{ teacherId: T1, day: "monday", order: 1 }],
  });
  const plan = (await planClassSchedules(db, ctx, classes)).get(CLASS);

  assert.equal(plan.moving, 0);
  assert.equal(plan.skipped[0].reason, "teacher_busy");
});

test("bitta ko'chirishda ikki sinf bitta katakni talab qilsa — ikkinchisi band", async () => {
  const CLASS2 = "d".repeat(24);
  const db = fakeDb({
    lessons: [lesson(), lesson({ classId: CLASS2, id: "l2" })],
    subjects: [{ id: SUB, name: "Matematika" }],
    users: [{ id: T1, firstName: "Ali", lastName: "Valiyev" }],
    targetUsers: [{ id: T1 }],
  });
  const plans = await planClassSchedules(db, ctx, [
    ...classes,
    { id: CLASS2, name: "IT 4" },
  ]);

  assert.equal(plans.get(CLASS).moving, 1);
  assert.equal(plans.get(CLASS2).moving, 0);
  assert.equal(plans.get(CLASS2).skipped[0].reason, "teacher_busy");
});

test("darsi yo'q sinfda jadval rejasi ham yo'q", async () => {
  const db = fakeDb({ lessons: [] });
  assert.equal((await planClassSchedules(db, ctx, classes)).get(CLASS), null);
});

// ─────────────────────────────────────────────
// Katalog moslashtirgich
// ─────────────────────────────────────────────

test("fan nomi bo'yicha moslanadi, yo'g'i OCHILADI", async () => {
  const writes = [];
  const db = fakeDb(
    {
      subjects: [
        { id: "s1", name: "Matematika", description: null },
        { id: "s2", name: " Fizika ", description: "izoh" },
      ],
      targetSubjects: [{ id: "x1", name: "matematika" }],
    },
    writes,
  );
  const { map, created } = await mapSubjects(db, ctx, ["s1", "s2"]);

  // Registr va ortiqcha bo'shliq farqi — moslashga to'siq emas
  assert.equal(map.get("s1"), "x1");
  assert.deepEqual(created, [" Fizika "]);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].sql.includes(`"${TGT}"."subjects"`));
});

test("sinf nomi bo'yicha moslanadi, tarix uchun NOFAOL ochiladi", async () => {
  const writes = [];
  const db = fakeDb(
    { classes: [{ id: "c9", name: "IT 3", capacity: 20 }], targetClasses: [] },
    writes,
  );
  const { map, created } = await mapClasses(db, ctx, ["c9"]);

  assert.equal(created.length, 1);
  assert.ok(map.get("c9"));
  // `active: false` — faqat ko'chgan tarixni ushlab turadi
  assert.equal(writes[0].params[3], false);
});

test("sinfning O'ZI ko'chayotganda tayyor moslama ishlatiladi — yangisi ochilmaydi", async () => {
  const writes = [];
  const db = fakeDb({ classes: [], targetClasses: [] }, writes);
  const known = new Map([["c9", "ready"]]);
  const { map, created } = await mapClasses(db, ctx, ["c9"], { known });

  assert.equal(map.get("c9"), "ready");
  assert.deepEqual(created, []);
  assert.equal(writes.length, 0);
});

test("xodim maqsadda faqat arxivlanmagan bo'lsa ishlatiladi, yangisi OCHILMAYDI", async () => {
  const writes = [];
  const db = fakeDb({ targetUsers: [{ id: T1 }] }, writes);
  const present = await presentStaff(db, ctx, [T1, T2]);

  assert.deepEqual([...present], [T1]);
  assert.equal(writes.length, 0);
});

test("to'lov turi nom bo'yicha, mos kelmasa — birinchi FAOL hisob", async () => {
  const db = fakeDb({
    sourceAccounts: [
      { id: "s1", name: "Naqd" },
      { id: "s3", name: "Ipoteka bank" },
    ],
    targetAccounts: [
      { id: "t0", name: "Arxiv", isActive: false, isArchived: true, sortOrder: 0 },
      { id: "t1", name: "Naqd", isActive: true, isArchived: false, sortOrder: 1 },
      { id: "t2", name: "Uzcard", isActive: true, isArchived: false, sortOrder: 2 },
    ],
  });
  const { map, fallback } = await mapPaymentAccounts(db, ctx, ["s1", "s3"]);

  assert.equal(map.get("s1"), "t1");
  // Nomi mos kelmagani birinchi FAOL hisobga tushadi (arxivlangani emas)
  assert.equal(map.get("s3"), "t1");
  assert.equal(fallback.id, "t1");
});

test("nom kaliti: registr va ortiqcha bo'shliq hisob emas", () => {
  assert.equal(nameKey("  IT   3 "), nameKey("it 3"));
  assert.notEqual(nameKey("IT 3"), nameKey("IT 4"));
});
