const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * ERP VA KUNDALIK.COM — o'quvchi tashqi tizimlarda bormi.
 *
 * Himoya qilinadigan narsa:
 *   · filtrlar tekshiriladi: noto'g'ri qiymat 400, "hammasi" — shart yo'q;
 *   · sanoq kartalari faqat SINF filtriga bog'liq, jadval — hammasiga;
 *   · belgi idempotent: qayta "bor" qatorni o'zgartirmaydi, arxivlangan
 *     o'quvchi belgilanmaydi;
 *   · Excel: sinf tabiiy tartibda, sinfsizlar oxirida, ikki sinfdagi
 *     o'quvchi jamida bir marta sanaladi.
 *
 * Servis HAQIQIY kodi ishlaydi; filial bazasi xotiradagi soxta bilan
 * almashtiriladi.
 */

/* ───────────────────────── Soxta muhit ───────────────────────── */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const db = { users: [], marks: [], calls: [] };

fakeModule("../src/config/prisma", {
  user: {
    findMany: async ({ where }) =>
      db.users.filter(
        (u) =>
          u.role === where.role &&
          u.isArchived === where.isArchived &&
          where.id.in.includes(u.id),
      ),
  },
  studentSystemMark: {
    createMany: async (args) => {
      db.calls.push(["createMany", args]);
      if (db.failWith) throw db.failWith;
      let count = 0;
      for (const row of args.data) {
        const exists = db.marks.some((m) => m.studentId === row.studentId && m.system === row.system);
        if (!exists) {
          db.marks.push({ ...row });
          count += 1;
        }
      }
      return { count };
    },
    deleteMany: async (args) => {
      db.calls.push(["deleteMany", args]);
      const before = db.marks.length;
      db.marks = db.marks.filter(
        (m) => !(m.system === args.where.system && args.where.studentId.in.includes(m.studentId)),
      );
      return { count: before - db.marks.length };
    },
  },
});

const service = require("../src/services/studentSystem.service");

const {
  parseListQuery,
  parseExportQuery,
  buildListWhere,
  buildExportRows,
  buildClassSummary,
  countPresence,
  setStudentSystemMarks,
  MARK_BATCH_MAX,
} = service;

const id = (ch) => ch.repeat(24);
const S1 = id("1");
const S2 = id("2");
const S3 = id("3");
const ACTOR = id("e");
const C5A = { id: id("a"), name: "5-A" };
const C10A = { id: id("b"), name: "10-A" };
const C9B = { id: id("c"), name: "9-B" };

function reset() {
  db.users = [
    { id: S1, role: "student", isArchived: false },
    { id: S2, role: "student", isArchived: false },
    { id: S3, role: "student", isArchived: true },
  ];
  db.marks = [];
  db.calls = [];
  db.failWith = null;
}

/* ───────────────────────── Filtrlar ───────────────────────── */

test("ro'yxat filtri: sukut, 'hammasi', sinfsiz va sahifa chegarasi", () => {
  const defaults = parseListQuery({});
  assert.equal(defaults.classFilter, null);
  assert.deepEqual(defaults.presence, { erp: null, kundalik: null });
  assert.equal(defaults.page, 1);
  assert.equal(defaults.limit, 50);

  const parsed = parseListQuery({ classId: "none", erp: "no", kundalik: "all", limit: "9999", page: "3" });
  assert.equal(parsed.classFilter, "none");
  assert.deepEqual(parsed.presence, { erp: "no", kundalik: null });
  assert.equal(parsed.limit, 200);
  assert.equal(parsed.page, 3);
});

test("ro'yxat filtri: noto'g'ri qiymat rad etiladi", () => {
  assert.throws(() => parseListQuery({ erp: "maybe" }), /ERP filtri/);
  assert.throws(() => parseListQuery({ kundalik: "1" }), /Kundalik\.com filtri/);
  assert.throws(() => parseListQuery({ classId: "5-A" }), /sinf formati/);
});

test("sanoq kartalari faqat sinf filtriga bog'liq, jadval — barcha filtrlarga", () => {
  const { scope, where } = buildListWhere(
    parseListQuery({ classId: C5A.id, search: "Ali", erp: "no", kundalik: "yes" }),
  );

  assert.deepEqual(scope, {
    AND: [
      { role: "student", isArchived: false },
      { classes: { some: { classId: C5A.id } } },
    ],
  });

  const [, , search, erp, kundalik] = where.AND;
  assert.ok(search.AND, "qidiruv sharti bor");
  assert.deepEqual(erp, { systemMarks: { none: { system: "erp" } } });
  assert.deepEqual(kundalik, { systemMarks: { some: { system: "kundalik" } } });

  const noClass = buildListWhere(parseListQuery({ classId: "none" }));
  assert.deepEqual(noClass.scope.AND[1], { classes: { none: {} } });
});

test("Excel so'rovi: sukut — butun maktab to'liq hisobot; sinflar ro'yxati tekshiriladi", () => {
  assert.deepEqual(parseExportQuery({}), { list: "all", scope: "school", classIds: null });

  // Butun maktabda yuborilgan sinflar e'tiborsiz
  assert.equal(parseExportQuery({ scope: "school", classIds: C5A.id }).classIds, null);

  assert.deepEqual(
    parseExportQuery({ list: "erp_no", scope: "classes", classIds: `${C5A.id}, ${C10A.id},${C5A.id}` }),
    { list: "erp_no", scope: "classes", classIds: [C5A.id, C10A.id] },
  );
  assert.deepEqual(
    parseExportQuery({ scope: "classes", classIds: [C9B.id] }).classIds,
    [C9B.id],
  );

  assert.throws(() => parseExportQuery({ list: "erp" }), /Ro'yxat turi/);
  assert.throws(() => parseExportQuery({ scope: "class" }), /Qamrov/);
  assert.throws(() => parseExportQuery({ scope: "classes" }), /Kamida bitta sinf/);
  assert.throws(() => parseExportQuery({ scope: "classes", classIds: "x" }), /sinf formati/);
});

/* ───────────────────────── Belgilash ───────────────────────── */

test("belgi: faqat joriy o'quvchilarga, qayta 'bor' qatorni o'zgartirmaydi", async () => {
  reset();

  const first = await setStudentSystemMarks(
    { studentIds: [S1, S2, S3, S1], system: "erp", present: true },
    { actorId: ACTOR },
  );
  assert.deepEqual(first.studentIds, [S1, S2]);
  assert.equal(first.changed, 2);
  assert.equal(first.skipped, 1, "arxivlangan o'quvchi belgilanmaydi");
  assert.equal(db.calls[0][1].skipDuplicates, true);
  assert.deepEqual(
    db.marks.map((m) => [m.studentId, m.system, m.markedBy]),
    [
      [S1, "erp", ACTOR],
      [S2, "erp", ACTOR],
    ],
  );

  // Boshqa xodim qayta bossa — birinchi belgilagan saqlanadi
  const again = await setStudentSystemMarks(
    { studentIds: [S1], system: "erp", present: true },
    { actorId: id("f") },
  );
  assert.equal(again.changed, 0);
  assert.equal(db.marks.find((m) => m.studentId === S1).markedBy, ACTOR);

  // Belgini olish faqat shu tizimga tegadi
  await setStudentSystemMarks({ studentIds: [S1], system: "kundalik", present: true }, { actorId: ACTOR });
  const removed = await setStudentSystemMarks(
    { studentIds: [S1], system: "erp", present: false },
    { actorId: ACTOR },
  );
  assert.equal(removed.changed, 1);
  assert.deepEqual(
    db.marks.map((m) => [m.studentId, m.system]),
    [
      [S2, "erp"],
      [S1, "kundalik"],
    ],
  );
});

test("belgi: noto'g'ri so'rov aniq xato bilan rad etiladi", async () => {
  reset();
  const actor = { actorId: ACTOR };

  await assert.rejects(setStudentSystemMarks({ studentIds: [S1], system: "emaktab", present: true }, actor), /Tizim noto'g'ri/);
  await assert.rejects(setStudentSystemMarks({ studentIds: [S1], system: "erp", present: "true" }, actor), /holati/);
  await assert.rejects(setStudentSystemMarks({ studentIds: [], system: "erp", present: true }, actor), /tanlanmagan/);
  await assert.rejects(setStudentSystemMarks({ studentIds: ["x"], system: "erp", present: true }, actor), /o'quvchi formati/);
  await assert.rejects(
    setStudentSystemMarks(
      { studentIds: Array.from({ length: MARK_BATCH_MAX + 1 }, (_, i) => i.toString(16).padStart(24, "0")), system: "erp", present: true },
      actor,
    ),
    /ko'pi bilan/,
  );
  await assert.rejects(setStudentSystemMarks({ studentIds: [S3], system: "erp", present: true }, actor), /arxivlangan/);
  await assert.rejects(setStudentSystemMarks({ studentIds: [S1], system: "erp", present: true }, {}), /aktyor/);

  // Tekshiruvdan keyin o'quvchi o'chirilgan (FK) — 500 emas
  db.failWith = Object.assign(new Error("fk"), { code: "P2003" });
  await assert.rejects(setStudentSystemMarks({ studentIds: [S1], system: "erp", present: true }, actor), /yangilab/);
  assert.equal(db.marks.length, 0);
});

/* ───────────────────────── Excel ───────────────────────── */

const student = (sid, firstName, classes, systems = []) => ({
  id: sid,
  firstName,
  lastName: null,
  classes,
  systems,
});

test("Excel qatorlari: sinf tabiiy tartibda, sinfsizlar oxirida, keyin ism", () => {
  const rows = buildExportRows([
    student(id("4"), "Zafar", [C10A]),
    student(id("5"), "Bekzod", []),
    student(id("6"), "Olim", [C5A], ["erp"]),
    student(id("7"), "Anvar", [C5A], ["kundalik"]),
    student(id("8"), "Dilshod", [C9B]),
  ]);

  assert.deepEqual(
    rows.map((r) => [r.name, r.classNames]),
    [
      ["Anvar", "5-A"],
      ["Olim", "5-A"],
      ["Dilshod", "9-B"],
      ["Zafar", "10-A"],
      ["Bekzod", "Sinfsiz"],
    ],
  );
  assert.equal(rows[1].erp, true);
  assert.equal(rows[1].kundalik, false);
  assert.equal(rows[0].kundalik, true);
});

test("Excel qatorlari: ikki sinfdagi o'quvchi tanlangan sinfi bo'yicha turadi", () => {
  const both = student(id("9"), "Aziz", [C10A, C5A]);

  assert.equal(buildExportRows([both])[0].groupClass.id, C5A.id, "butun maktabda — birinchi sinf");
  const [row] = buildExportRows([both], { classIds: [C10A.id] });
  assert.equal(row.groupClass.id, C10A.id);
  assert.equal(row.classNames, "5-A, 10-A", "Sinf ustunida hamma sinflari");
});

test("sinflar kesimi: tanlangan bo'sh sinf 0 bilan, jami takrorsiz", () => {
  const students = [
    student(id("4"), "Aziz", [C5A, C10A], ["erp"]),
    student(id("5"), "Bobur", [C5A], ["erp", "kundalik"]),
  ];

  const selected = [C10A, C5A, C9B];
  const rows = buildExportRows(students, { classIds: selected.map((c) => c.id) });
  const summary = buildClassSummary(rows, students, { classes: selected });

  assert.deepEqual(
    summary.map((s) => [s.name, s.students, s.systems.erp.yes, s.systems.kundalik.no]),
    [
      ["5-A", 2, 2, 1],
      ["9-B", 0, 0, 0],
      ["10-A", 1, 1, 1],
    ],
  );

  const totals = countPresence(rows);
  assert.equal(totals.students, 2, "ikki sinfdagi o'quvchi jamida bir marta");
  assert.deepEqual(totals.systems, { erp: { yes: 2, no: 0 }, kundalik: { yes: 1, no: 1 } });
});

test("sinflar kesimi: butun maktabda sinfsizlar alohida qator, oxirida", () => {
  const students = [student(id("4"), "Aziz", []), student(id("5"), "Bobur", [C9B], ["kundalik"])];
  const rows = buildExportRows(students);
  const summary = buildClassSummary(rows, students);

  assert.deepEqual(
    summary.map((s) => [s.name, s.students]),
    [
      ["9-B", 1],
      ["Sinfsiz", 1],
    ],
  );
});
