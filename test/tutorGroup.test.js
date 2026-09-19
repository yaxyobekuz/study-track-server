const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * TYUTOR GURUHLARI — formula, oylik dvigateli va biriktirish qoidalari
 * (`finance.md` §10, "Tyutor guruhlari").
 *
 * Himoya qilinadigan narsa:
 *   · summa = guruh summasi + o'quvchiga summa × o'quvchilar soni (BITTA joy);
 *   · tyutor puli foizli ustama bazasiga KIRMAYDI;
 *   · faqat guruhi bor tyutor ham oylik oladi;
 *   · BIR OYDA BIR SINFGA BITTA TYUTOR, ommaviy biriktirish HAMMASI YOKI HECH
 *     NARSA, sinflar `id` o'sish tartibida qulflanadi;
 *   · o'tgan oyga biriktirilmaydi, o'tgan oylar summasi qayta yozilmaydi.
 *
 * `tutorGroup.service` va `payrollEngine` HAQIQIY kodi ishlaydi; filial va
 * platforma bazasi xotiradagi soxta bilan almashtiriladi. Muhrlangan oylikni
 * qayta hisoblash (`payrollDeduction.service`) bu yerda faqat CHAQIRILGANI
 * tekshiriladi — uning o'zi `payrollSuspension.test.js` da.
 */

/* ───────────────────────── Soxta muhit ───────────────────────── */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

/** Prisma `where` ning shu yerda ishlatiladigan qismi. */
const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return cond.some((c) => matches(row, c));
    if (key === "AND") return cond.every((c) => matches(row, c));
    const value = row[key];
    if (cond !== null && typeof cond === "object") {
      if ("in" in cond && !cond.in.includes(value)) return false;
      if ("notIn" in cond && cond.notIn.includes(value)) return false;
      if ("not" in cond && value === cond.not) return false;
      if ("lte" in cond && !(value != null && value <= cond.lte)) return false;
      if ("gte" in cond && !(value != null && value >= cond.gte)) return false;
      return true;
    }
    return value === cond;
  });

let db;
let seq = 0;
const locks = [];
const sideEffects = { extended: [], resynced: [] };

const withClass = (row) => (row ? { ...row, class: db.classes.find((c) => c.id === row.classId) } : null);

const prisma = {
  user: {
    findUnique: async ({ where }) => db.users.find((u) => u.id === where.id) ?? null,
    findMany: async ({ where } = {}) => db.users.filter((u) => matches(u, where)),
  },
  class: {
    findMany: async ({ where } = {}) =>
      db.classes.filter((c) => matches(c, where)).sort((a, b) => a.name.localeCompare(b.name)),
  },
  userClass: {
    groupBy: async ({ where }) =>
      where.classId.in
        .filter((id) => db.students[id] != null)
        .map((classId) => ({ classId, _count: { userId: db.students[classId] } })),
  },
  tutorGroup: {
    findMany: async ({ where } = {}) => db.groups.filter((g) => matches(g, where)).map(withClass),
    findUnique: async ({ where }) => withClass(db.groups.find((g) => g.id === where.id)),
    create: async ({ data }) => {
      seq += 1;
      const row = { id: seq.toString(16).padStart(24, "c"), createdAt: new Date(seq), ...data };
      db.groups.push(row);
      return withClass(row);
    },
    update: async ({ where, data }) => {
      const row = db.groups.find((g) => g.id === where.id);
      Object.assign(row, data);
      return withClass(row);
    },
    delete: async ({ where }) => {
      db.groups = db.groups.filter((g) => g.id !== where.id);
    },
  },
  payrollAudit: {
    create: async ({ data }) => db.audits.push(data),
    createMany: async ({ data }) => {
      db.audits.push(...data);
      return { count: data.length };
    },
  },
  $transaction: async (fn) => fn(prisma),
  // `pg_advisory_xact_lock(hashtext('tutor_group:<classId>'))` — kalit yoziladi
  $executeRaw: async (strings, ...values) => {
    locks.push(values[0]);
    return 0;
  },
};

fakeModule("../src/config/prisma", prisma);
fakeModule("../src/config/platformPrisma", {
  // "Tyutor" belgisi qo'yilgan rol — kaliti ataylab "tutor" emas: kod rol
  // kalitini qotirmasligi kerak
  role: { findMany: async () => [{ value: "sinf_rahbari" }] },
});
fakeModule("../src/services/payrollDeduction.service", {
  extendAllScopeDeductionsSafe: async (ids) => sideEffects.extended.push(...ids),
  resyncSealedEntries: async (ids, months) => {
    sideEffects.resynced.push({ ids, months });
    return { updated: 1, locked: [], conflicts: 0 };
  },
});
fakeModule("../src/services/lessonHours.service", {
  computeLessonHoursForMonth: async (month, ids) => new Map(ids.map((id) => [String(id), { hours: 0 }])),
});
fakeModule("../src/services/staffSalary.service", {
  resolveSalariesForMonth: async () => new Map(),
});

const tutorGroups = require("../src/services/tutorGroup.service");
const engine = require("../src/services/payrollEngine.service");
const { computeTutorGroupAmount } = require("../src/helpers/salaryRules.helpers");
const { currentMonthKey, nextMonth, prevMonth } = require("../src/helpers/month.helpers");
const { ConflictError, BadRequestError } = require("../src/utils/errors");

/* ───────────────────────── Ma'lumot ───────────────────────── */

const CUR = currentMonthKey();
const NEXT = nextMonth(CUR);
const PREV = prevMonth(CUR);

const id = (prefix) => prefix.padEnd(24, "0");
const TUTOR = id("a1");
const OTHER_TUTOR = id("a2");
const EXTRA_ROLE_TUTOR = id("a3");
const PLAIN_STAFF = id("a4");
const STUDENT = id("a5");
const ARCHIVED = id("a6");

// ⚠️ Nom tartibi `id` tartibiga TESKARI — qulf tartibi nomdan emas, id dan
const CLASS_A = id("b3"); // "5-A"
const CLASS_B = id("b2"); // "5-B"
const CLASS_C = id("b1"); // "5-V"
const CLASS_OFF = id("b4");

function reset() {
  db = {
    users: [
      { id: TUTOR, firstName: "Aziza", lastName: "Karimova", role: "sinf_rahbari", isArchived: false },
      { id: OTHER_TUTOR, firstName: "Bekzod", lastName: "Aliyev", role: "sinf_rahbari", isArchived: false },
      // Asosiy roli o'qituvchi, tyutorlik — qo'shimcha rol
      { id: EXTRA_ROLE_TUTOR, firstName: "Dilshod", lastName: "", role: "teacher", extraRoles: ["sinf_rahbari"], isArchived: false },
      { id: PLAIN_STAFF, firstName: "Erkin", lastName: "", role: "teacher", isArchived: false },
      { id: STUDENT, firstName: "Farrux", lastName: "", role: "student", extraRoles: ["sinf_rahbari"], isArchived: false },
      { id: ARCHIVED, firstName: "G'ayrat", lastName: "", role: "sinf_rahbari", isArchived: true },
    ],
    classes: [
      { id: CLASS_A, name: "5-A", isActive: true },
      { id: CLASS_B, name: "5-B", isActive: true },
      { id: CLASS_C, name: "5-V", isActive: true },
      { id: CLASS_OFF, name: "Eski sinf", isActive: false },
    ],
    students: { [CLASS_A]: 20, [CLASS_B]: 25, [CLASS_C]: 18 },
    groups: [],
    audits: [],
  };
  locks.length = 0;
  sideEffects.extended.length = 0;
  sideEffects.resynced.length = 0;
}

const assign = (data) =>
  tutorGroups.createGroup(
    { tutorId: TUTOR, perStudentAmount: "10000", groupAmount: "100000", ...data },
    "actor",
  );

/* ───────────────────────── Formula ───────────────────────── */

test("formula: guruh summasi + o'quvchiga summa × o'quvchilar soni", () => {
  const group = { groupAmount: "100000", perStudentAmount: "10000" };

  assert.equal(computeTutorGroupAmount(group, 20).toFixed(2), "300000.00");
  assert.equal(computeTutorGroupAmount(group, 0).toFixed(2), "100000.00");
  assert.equal(computeTutorGroupAmount({ perStudentAmount: "12500.50" }, 3).toFixed(2), "37501.50");
});

test("formula: noto'g'ri yoki manfiy o'quvchilar soni summani kamaytirmaydi", () => {
  const group = { groupAmount: "100000", perStudentAmount: "10000" };

  assert.equal(computeTutorGroupAmount(group, -5).toFixed(2), "100000.00");
  assert.equal(computeTutorGroupAmount(group, undefined).toFixed(2), "100000.00");
  assert.equal(computeTutorGroupAmount({}, 10).toFixed(2), "0.00");
});

/* ───────────────────────── Oylik dvigateli ───────────────────────── */

/** Dvigatel konteksti — faqat shu testlarga keraklisi. */
const ctxWith = ({ groups = [], counts = {}, positions = [], bonuses = [] } = {}) => ({
  positionMap: new Map(positions.map((p) => [p.id, p])),
  categoryMap: new Map(),
  salaryRules: new Map(),
  hoursMap: new Map(),
  bonusMap: new Map(bonuses.length ? [[TUTOR, bonuses]] : []),
  deductionMap: new Map(),
  customBaseMap: new Map(),
  tutorGroupMap: new Map(groups.length ? [[TUTOR, groups]] : []),
  classStudentCounts: new Map(Object.entries(counts)),
  suspensions: [],
});

const group5A = {
  id: "g1",
  classId: CLASS_A,
  class: { name: "5-A" },
  perStudentAmount: "10000",
  groupAmount: "100000",
};

test("dvigatel: faqat guruhi bor tyutor (lavozimsiz, toifasiz) ham oylik oladi", () => {
  const c = engine.computeForStaff({ id: TUTOR }, CUR, ctxWith({ groups: [group5A], counts: { [CLASS_A]: 20 } }));

  assert.ok(c, "tyutor oylik oladiganlar ro'yxatidan tushib qolmasligi kerak");
  assert.equal(c.amount.toFixed(2), "300000.00");
  assert.equal(c.tutorAmount.toFixed(2), "300000.00");
});

test("dvigatel: guruhi ham, lavozimi ham yo'q xodimga oylik yo'q", () => {
  assert.equal(engine.computeForStaff({ id: TUTOR }, CUR, ctxWith()), null);
});

test("dvigatel: tyutor qatoriga sinf, o'quvchilar soni va stavkalar MUHRLANADI", () => {
  const c = engine.computeForStaff({ id: TUTOR }, CUR, ctxWith({ groups: [group5A], counts: { [CLASS_A]: 20 } }));
  const [line] = c.allowanceBreakdown;

  assert.equal(line.type, "tutor");
  assert.equal(line.label, "Tyutor: 5-A");
  assert.equal(line.classId, CLASS_A);
  assert.equal(line.studentCount, 20);
  assert.equal(line.perStudentAmount, "10000.00");
  assert.equal(line.groupAmount, "100000.00");
  assert.equal(line.amount, "300000.00");
});

test("dvigatel: tyutor puli foizli ustama bazasiga KIRMAYDI", () => {
  const c = engine.computeForStaff(
    { id: TUTOR, positionId: "p1" },
    CUR,
    ctxWith({
      positions: [{ id: "p1", name: "Tarbiyachi", baseSalary: "2000000" }],
      bonuses: [{ id: "bn1", label: "Staj", type: "percent", value: "10" }],
      groups: [group5A],
      counts: { [CLASS_A]: 20 },
    }),
  );

  const percent = c.allowanceBreakdown.find((line) => line.type === "percent");
  // 10% × 2 000 000 (lavozim), 10% × 2 300 000 (lavozim + tyutor) EMAS
  assert.equal(percent.amount, "200000.00");
  assert.equal(c.amount.toFixed(2), "2500000.00"); // 2 000 000 + 200 000 + 300 000
});

test("dvigatel: ikki sinf — ikki alohida qator, har biri o'z stavkasi bilan", () => {
  const group5B = { id: "g2", classId: CLASS_B, class: { name: "5-B" }, perStudentAmount: "0", groupAmount: "150000" };
  const c = engine.computeForStaff(
    { id: TUTOR },
    CUR,
    ctxWith({ groups: [group5A, group5B], counts: { [CLASS_A]: 20, [CLASS_B]: 25 } }),
  );

  assert.deepEqual(
    c.allowanceBreakdown.map((line) => [line.label, line.amount]),
    [["Tyutor: 5-A", "300000.00"], ["Tyutor: 5-B", "150000.00"]],
  );
  assert.equal(c.amount.toFixed(2), "450000.00");
});

/* ───────────────────────── Biriktirish ───────────────────────── */

test("biriktirish: bir nechta sinf — AYNI stavka va davr, har sinfga alohida qator", async () => {
  reset();
  const result = await assign({ classIds: [CLASS_A, CLASS_B] });

  assert.equal(result.count, 2);
  assert.equal(db.groups.length, 2);
  for (const row of db.groups) {
    assert.equal(row.tutorId, TUTOR);
    assert.equal(row.perStudentAmount.toFixed(2), "10000.00");
    assert.equal(row.groupAmount.toFixed(2), "100000.00");
    assert.equal(row.startMonth, CUR);
    assert.equal(row.endMonth, null);
  }
  assert.deepEqual(
    result.groups.map((g) => [g.className, g.studentCount, g.monthlyAmount]),
    [["5-A", 20, "300000.00"], ["5-B", 25, "350000.00"]],
  );
  // Har qatorga o'z audit yozuvi
  assert.equal(db.audits.filter((a) => a.action === "tutorGroup.create").length, 2);
});

test("biriktirish: joriy oyga — muhrlangan oylik darhol qayta hisoblanadi", async () => {
  reset();
  const result = await assign({ classIds: [CLASS_A] });

  assert.deepEqual(sideEffects.extended, [TUTOR], "'hammaga' ushlab qolish tyutorga yoyiladi");
  assert.deepEqual(sideEffects.resynced, [{ ids: [TUTOR], months: [CUR] }]);
  assert.equal(result.payrollUpdated, 1);
});

test("biriktirish: kelajak oyga — joriy oy muhriga tegilmaydi", async () => {
  reset();
  await assign({ classIds: [CLASS_A], startMonth: NEXT });

  assert.equal(sideEffects.resynced.length, 0);
});

test("biriktirish: takrorlangan sinf bitta qator bo'ladi", async () => {
  reset();
  await assign({ classIds: [CLASS_A, CLASS_A, ` ${CLASS_A} `] });

  assert.equal(db.groups.length, 1);
});

test("biriktirish: sinflar id O'SISH tartibida qulflanadi (nom tartibida emas)", async () => {
  reset();
  await assign({ classIds: [CLASS_A, CLASS_C, CLASS_B] });

  assert.deepEqual(locks, [CLASS_C, CLASS_B, CLASS_A].map((c) => `tutor_group:${c}`));
});

/* ───────────────────────── Bir oyda bir sinfga bitta tyutor ───────────────────────── */

test("bitta sinf: boshqa tyutorda band — rad etiladi, egasi va davri aytiladi", async () => {
  reset();
  await tutorGroups.createGroup(
    { tutorId: OTHER_TUTOR, classIds: [CLASS_A], perStudentAmount: "5000", groupAmount: "0" },
    "actor",
  );

  await assert.rejects(
    () => assign({ classIds: [CLASS_A] }),
    (error) =>
      error instanceof ConflictError &&
      /5-A sinfi/.test(error.message) &&
      /Bekzod Aliyev/.test(error.message) &&
      error.details.reason === "tutor_group_overlap",
  );
  assert.equal(db.groups.filter((g) => g.tutorId === TUTOR).length, 0);
});

test("HAMMASI YOKI HECH NARSA: bitta sinf band bo'lsa hech qaysi yozilmaydi, band sinflarning HAMMASI aytiladi", async () => {
  reset();
  await tutorGroups.createGroup(
    { tutorId: OTHER_TUTOR, classIds: [CLASS_A, CLASS_C], perStudentAmount: "5000", groupAmount: "0" },
    "actor",
  );
  const before = db.groups.length;

  await assert.rejects(
    () => assign({ classIds: [CLASS_A, CLASS_B, CLASS_C] }),
    (error) =>
      error instanceof ConflictError &&
      /2 ta sinf bu davrda band/.test(error.message) &&
      /Hech qaysi sinf biriktirilmadi/.test(error.message) &&
      [...error.details.classIds].sort().join() === [CLASS_A, CLASS_C].sort().join(),
  );
  assert.equal(db.groups.length, before, "bo'sh 5-B ham yozilmasligi kerak");
});

test("o'sha tyutorga qayta biriktirish ham kesishuv — ikki marta to'lanmaydi", async () => {
  reset();
  await assign({ classIds: [CLASS_A] });

  await assert.rejects(
    () => assign({ classIds: [CLASS_A], startMonth: NEXT }),
    (error) => error instanceof ConflictError && /allaqachon biriktirilgan/.test(error.message),
  );
  assert.equal(db.groups.length, 1);
});

test("kesishmaydigan davr — boshqa tyutorga biriktirish mumkin", async () => {
  reset();
  // Eski tyutor shu oy oxirigacha, yangisi keyingi oydan
  await tutorGroups.createGroup(
    { tutorId: OTHER_TUTOR, classIds: [CLASS_A], perStudentAmount: "5000", groupAmount: "0", endMonth: CUR },
    "actor",
  );

  await assign({ classIds: [CLASS_A], startMonth: NEXT });

  assert.deepEqual(
    db.groups.map((g) => [g.tutorId, g.startMonth, g.endMonth]),
    [[OTHER_TUTOR, CUR, CUR], [TUTOR, NEXT, null]],
  );
});

/* ───────────────────────── Kim va qachon ───────────────────────── */

test("o'tgan oyga biriktirib bo'lmaydi", async () => {
  reset();
  await assert.rejects(
    () => assign({ classIds: [CLASS_A], startMonth: PREV }),
    (error) => error instanceof BadRequestError && /O'tgan oyga/.test(error.message),
  );
  assert.equal(db.groups.length, 0);
});

test("tugash oyi boshlanishdan oldin bo'lolmaydi", async () => {
  reset();
  await assert.rejects(
    () => assign({ classIds: [CLASS_A], startMonth: NEXT, endMonth: CUR }),
    BadRequestError,
  );
});

test("tyutor roli: rol KALITI qotirilmagan, qo'shimcha rol ham hisob", async () => {
  reset();
  await tutorGroups.createGroup(
    { tutorId: EXTRA_ROLE_TUTOR, classIds: [CLASS_A], perStudentAmount: "1000", groupAmount: "0" },
    "actor",
  );
  assert.equal(db.groups[0].tutorId, EXTRA_ROLE_TUTOR);
});

test("tyutor roli yo'q xodim, o'quvchi va arxivlangan xodimga biriktirilmaydi", async () => {
  reset();
  await assert.rejects(() => assign({ tutorId: PLAIN_STAFF, classIds: [CLASS_A] }), /tyutor roli yo'q/);
  // O'quvchiga tyutor roli berilgan bo'lsa ham
  await assert.rejects(() => assign({ tutorId: STUDENT, classIds: [CLASS_A] }), /O'quvchiga/);
  await assert.rejects(() => assign({ tutorId: ARCHIVED, classIds: [CLASS_A] }), /Arxivlangan/);
  assert.equal(db.groups.length, 0);
});

test("faol bo'lmagan va mavjud bo'lmagan sinf rad etiladi", async () => {
  reset();
  await assert.rejects(() => assign({ classIds: [CLASS_A, CLASS_OFF] }), /Faol bo'lmagan sinf.*Eski sinf/);
  await assert.rejects(() => assign({ classIds: [CLASS_A, id("ff")] }), /1 tasi topilmadi/);
  assert.equal(db.groups.length, 0);
});

test("manfiy summa rad etiladi", async () => {
  reset();
  await assert.rejects(() => assign({ classIds: [CLASS_A], perStudentAmount: "-100" }), /manfiy/);
});

/* ───────────────────────── Tahrirlash ───────────────────────── */

/** Tayyor biriktirish qatori (o'tgan oydan boshlangan bo'lishi mumkin). */
const seedGroup = (data) => {
  seq += 1;
  const row = {
    id: seq.toString(16).padStart(24, "d"),
    tutorId: TUTOR,
    classId: CLASS_A,
    perStudentAmount: "10000",
    groupAmount: "100000",
    startMonth: CUR,
    endMonth: null,
    note: "",
    createdAt: new Date(seq),
    ...data,
  };
  db.groups.push(row);
  return row;
};

test("tahrir: o'tgan oydan boshlangan guruh summasi o'zgarsa — davr BO'LINADI, o'tgan oylar eski summada", async () => {
  reset();
  const old = seedGroup({ startMonth: PREV });

  const result = await tutorGroups.updateGroup(old.id, { perStudentAmount: "15000" }, "actor");

  assert.equal(result.split, true);
  const [closed, fresh] = db.groups;
  assert.equal(closed.id, old.id);
  assert.equal(closed.endMonth, PREV);
  assert.equal(closed.perStudentAmount, "10000", "o'tgan oy summasi qayta yozilmaydi");
  assert.equal(fresh.startMonth, CUR);
  assert.equal(fresh.perStudentAmount.toFixed(2), "15000.00");
  assert.deepEqual(sideEffects.resynced, [{ ids: [TUTOR], months: [CUR] }]);
});

test("tahrir: shu oydan boshlangan guruh — joyida yangilanadi, bo'linmaydi", async () => {
  reset();
  const row = seedGroup({ startMonth: CUR });

  const result = await tutorGroups.updateGroup(row.id, { groupAmount: "50000" }, "actor");

  assert.equal(result.split, false);
  assert.equal(db.groups.length, 1);
  assert.equal(db.groups[0].groupAmount.toFixed(2), "50000.00");
});

test("tahrir: faqat izoh o'zgarsa oylik qayta hisoblanmaydi", async () => {
  reset();
  const row = seedGroup({ startMonth: PREV });

  const result = await tutorGroups.updateGroup(row.id, { note: "yangi izoh" }, "actor");

  assert.equal(result.split, false);
  assert.equal(db.groups.length, 1);
  assert.equal(sideEffects.resynced.length, 0);
});

test("tahrir: boshlangan guruhning boshlanish oyi va tugagan guruh o'zgarmaydi", async () => {
  reset();
  const started = seedGroup({ startMonth: PREV });
  const ended = seedGroup({ classId: CLASS_B, startMonth: PREV, endMonth: PREV });

  await assert.rejects(
    () => tutorGroups.updateGroup(started.id, { startMonth: NEXT }, "actor"),
    /boshlanish oyini o'zgartirib bo'lmaydi/,
  );
  await assert.rejects(() => tutorGroups.updateGroup(ended.id, { groupAmount: "1" }, "actor"), /tugagan/);
});

/* ───────────────────────── Olib tashlash ───────────────────────── */

test("olib tashlash 'keyingi oydan': shu oy hisoblanadi, muhrga tegilmaydi", async () => {
  reset();
  const row = seedGroup({ startMonth: PREV });

  const result = await tutorGroups.removeGroup(row.id, { effective: "next" }, "actor");

  assert.equal(result.deleted, false);
  assert.equal(db.groups[0].endMonth, CUR);
  assert.equal(sideEffects.resynced.length, 0);
});

test("olib tashlash 'shu oydan': o'tgan oyda yopiladi va joriy muhr qayta hisoblanadi", async () => {
  reset();
  const row = seedGroup({ startMonth: PREV });

  const result = await tutorGroups.removeGroup(row.id, { effective: "current" }, "actor");

  assert.equal(result.deleted, false);
  assert.equal(db.groups[0].endMonth, PREV);
  assert.deepEqual(sideEffects.resynced, [{ ids: [TUTOR], months: [CUR] }]);
});

test("olib tashlash: hali kuchga kirmagan guruh (reja) O'CHIRILADI", async () => {
  reset();
  const planned = seedGroup({ startMonth: NEXT });

  const result = await tutorGroups.removeGroup(planned.id, { effective: "next" }, "actor");

  assert.equal(result.deleted, true);
  assert.equal(db.groups.length, 0);
  assert.equal(db.audits.at(-1).action, "tutorGroup.delete");
});

test("olib tashlash: noma'lum rejim va tugagan guruh rad etiladi", async () => {
  reset();
  const ended = seedGroup({ startMonth: PREV, endMonth: PREV });
  const live = seedGroup({ classId: CLASS_B });

  await assert.rejects(() => tutorGroups.removeGroup(live.id, { effective: "yesterday" }, "actor"), BadRequestError);
  await assert.rejects(() => tutorGroups.removeGroup(ended.id, {}, "actor"), /allaqachon tugagan/);
});
