const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * OYLIKNI TO'XTATISH va MUHRLANGAN OYLIKNI QAYTA HISOBLASH
 * (`finance.md` §10, "Oylikni to'xtatish" va "TYUTOR PULI MOLIYAGA DARHOL TUSHADI").
 *
 * Himoya qilinadigan narsa:
 *   · qismlar (butun / asosiy / tyutor / qo'shimchalar / aniq bitta) MUSTAQIL,
 *     bir qism ikki marta ayirilmaydi;
 *   · amount = fixed + kpi + allowance − suspended − deduction, ushlab qolish
 *     TO'LANADIGAN yalpidan;
 *   · davr ikkala tomondan, ko'pi bilan 12 oy; "barcha xodimlar" — alohida
 *     tasdiq; aniq qo'shimcha faqat bitta xodimda;
 *   · aynan takror yozilmaydi; o'chirilmaydi — bekor qilinadi;
 *   · to'lov tushgan oylik: tarkib o'zgarsa faqat yangi summa to'langanidan
 *     kam bo'lmasa yangilanadi, faqat ushlab qolish o'zgarsa — tegilmaydi.
 *
 * `payrollSuspension`, `payrollDeduction` (qayta hisob), `payrollEngine` va
 * formula HAQIQIY kodi ishlaydi; baza xotiradagi soxta.
 */

/* ───────────────────────── Soxta muhit ───────────────────────── */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const { Decimal } = require("../src/helpers/money.helpers");

const same = (a, b) => {
  if (Decimal.isDecimal(a) || Decimal.isDecimal(b)) {
    try {
      return new Decimal(a ?? 0).equals(new Decimal(b ?? 0));
    } catch {
      return false;
    }
  }
  return a === b;
};

/** Prisma `where` ning shu yerda ishlatiladigan qismi. */
const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return cond.some((c) => matches(row, c));
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !Decimal.isDecimal(cond)) {
      if ("in" in cond && !cond.in.includes(value)) return false;
      if ("not" in cond && same(value, cond.not)) return false;
      if ("lte" in cond && !(value != null && value <= cond.lte)) return false;
      if ("gte" in cond && !(value != null && value >= cond.gte)) return false;
      return true;
    }
    return same(value ?? null, cond);
  });

let db;
let seq = 0;

const table = (name) => ({
  findMany: async ({ where, orderBy } = {}) => {
    const rows = db[name].filter((r) => matches(r, where));
    return orderBy ? [...rows].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)) : rows;
  },
  create: async ({ data }) => {
    seq += 1;
    const row = { id: `${name}-${seq}`, createdAt: seq, ...data };
    db[name].push(row);
    return row;
  },
  createMany: async ({ data }) => {
    for (const row of data) {
      seq += 1;
      db[name].push({ id: `${name}-${seq}`, createdAt: seq, status: "active", ...row });
    }
    return { count: data.length };
  },
  updateMany: async ({ where, data }) => {
    const rows = db[name].filter((r) => matches(r, where));
    for (const row of rows) Object.assign(row, data);
    return { count: rows.length };
  },
});

const prisma = {
  user: table("users"),
  payrollEntry: table("entries"),
  payrollSuspension: table("suspensions"),
  payrollDeduction: table("deductions"),
  payrollAudit: table("audits"),
  tutorGroup: table("groups"),
  userClass: { groupBy: async () => [] },
  $transaction: async (fn) => fn(prisma),
  $executeRaw: async () => 0,
};

fakeModule("../src/config/prisma", prisma);
fakeModule("../src/config/platformPrisma", { role: { findMany: async () => [] } });
fakeModule("../src/services/lessonHours.service", {
  computeLessonHoursForMonth: async (month, ids) => new Map(ids.map((id) => [String(id), { hours: 0 }])),
  computeLessonHoursForStaff: async () => ({ hours: 0 }),
});
fakeModule("../src/services/staffSalary.service", {
  resolveSalariesForMonth: async () => new Map(),
});

const suspensions = require("../src/services/payrollSuspension.service");
const engine = require("../src/services/payrollEngine.service");
const { recomputeSealedEntry, isResyncBlocked } = require("../src/services/payrollDeduction.service");
const { computeSuspensions } = require("../src/helpers/salaryRules.helpers");
const { currentMonthKey, nextMonth } = require("../src/helpers/month.helpers");
const { BadRequestError, ConflictError, NotFoundError } = require("../src/utils/errors");

/* ───────────────────────── Ma'lumot ───────────────────────── */

const CUR = currentMonthKey();
const addMonths = (month, n) => {
  let m = month;
  for (let i = 0; i < n; i += 1) m = nextMonth(m);
  return m;
};

const id = (prefix) => prefix.padEnd(24, "0");
const ALI = id("a1");
const VALI = id("a2");
const STUDENT = id("a3");
const ARCHIVED = id("a4");
const CLASS_A = id("c1");
const CLASS_B = id("c2");

/**
 * Oylik tarkibi: asosiy 3 000 000 (lavozim 2 000 000 + dars 1 000 000),
 * "Staj" bonusi 300 000, qoida ustamasi 100 000, ikki tyutor sinfi
 * 200 000 + 150 000. Yalpi = 3 750 000.
 */
const PARTS = {
  fixedAmount: "2000000",
  kpiAmount: "1000000",
  allowanceBreakdown: [
    { label: "Staj", type: "fixed", amount: "300000.00", bonusId: "bonus1" },
    { label: "Sinf rahbarligi", type: "fixed", amount: "100000.00", source: "rule" },
    { label: "Tyutor: 5-A", type: "tutor", amount: "200000.00", classId: CLASS_A },
    { label: "Tyutor: 5-B", type: "tutor", amount: "150000.00", classId: CLASS_B },
  ],
};

const groupOf = (classId, name, perStudentAmount, groupAmount) => ({
  id: `g-${classId}`,
  classId,
  class: { name },
  perStudentAmount,
  groupAmount,
});

/** Muhrdagi tyutor qatori — dvigatel yozgan shaklda. */
const tutorLine = (group, studentCount, amount) => ({
  label: `Tyutor: ${group.class.name}`,
  type: "tutor",
  value: Number(amount),
  amount,
  tutorGroupId: group.id,
  classId: group.classId,
  className: group.class.name,
  studentCount,
  perStudentAmount: new Decimal(group.perStudentAmount).toFixed(2),
  groupAmount: new Decimal(group.groupAmount).toFixed(2),
});

/**
 * Ali'ning amaldagi tyutor guruhlari. O'quvchilar soni soxta bazada 0,
 * ya'ni summa = guruh summasi. ⚠️ Muhrdagi tyutor qatorlari SHU guruhlarga
 * mos bo'lishi shart: qayta hisob guruhi yo'q qatorni "olib tashlangan"
 * deb o'chiradi (`resealTutorLines`).
 */
const GROUP_A = { ...groupOf(CLASS_A, "5-A", "0", "200000"), tutorId: ALI, startMonth: CUR, endMonth: null };
const GROUP_B = { ...groupOf(CLASS_B, "5-B", "0", "150000"), tutorId: ALI, startMonth: CUR, endMonth: null };

const susp = (component, extra = {}) => ({ id: `s-${component}-${extra.itemKey ?? ""}`, component, ...extra });
const suspended = (list) => computeSuspensions(PARTS, list).total.toFixed(2);

function reset() {
  db = {
    users: [
      { id: ALI, firstName: "Ali", lastName: "Valiyev", role: "teacher", isArchived: false },
      { id: VALI, firstName: "Vali", lastName: "Aliyev", role: "reception", isArchived: false },
      { id: STUDENT, firstName: "O'quvchi", lastName: "", role: "student", isArchived: false },
      { id: ARCHIVED, firstName: "Ketgan", lastName: "", role: "teacher", isArchived: true },
    ],
    entries: [],
    suspensions: [],
    deductions: [],
    audits: [],
    groups: [{ ...GROUP_A }, { ...GROUP_B }],
  };
}

/* ───────────────────────── Formula: qaysi qism ───────────────────────── */

test("qism: butun oylik — hamma birliklar", () => {
  assert.equal(suspended([susp("all")]), "3750000.00");
});

test("qism: asosiy oylik — faqat lavozim maoshi + dars soati", () => {
  assert.equal(suspended([susp("base")]), "3000000.00");
});

test("qism: tyutorlik — faqat tyutor sinflari, boshqa qo'shimcha emas", () => {
  assert.equal(suspended([susp("tutor")]), "350000.00");
});

test("qism: barcha qo'shimchalar — tyutordan BOSHQA ustamalar", () => {
  assert.equal(suspended([susp("allowances")]), "400000.00");
});

test("qism: aniq bitta qo'shimcha — tyutor sinfi, bonus yoki qoida kaliti bo'yicha", () => {
  assert.equal(suspended([susp("item", { itemKey: `tutor:${CLASS_B}` })]), "150000.00");
  assert.equal(suspended([susp("item", { itemKey: "bonus:bonus1" })]), "300000.00");
  assert.equal(suspended([susp("item", { itemKey: "rule:Sinf rahbarligi" })]), "100000.00");
  assert.equal(suspended([susp("item", { itemKey: "bonus:boshqa" })]), "0.00");
});

test("bir qismni ikki to'xtatish qamrasa — BIR MARTA ayiriladi, yaratilish tartibida birinchisiga", () => {
  const first = susp("tutor");
  const second = susp("all");
  const { total, breakdown } = computeSuspensions(PARTS, [first, second]);

  assert.equal(total.toFixed(2), "3750000.00", "yalpidan oshmaydi");
  assert.equal(breakdown[0].amount, "350000.00");
  assert.equal(breakdown[1].amount, "3400000.00", "tyutor qismi qayta sanalmaydi");
});

/* ───────────────────────── Dvigatel ───────────────────────── */

const STAFF = { id: ALI, positionId: "p1" };
const ctxWith = ({ suspensionRows = [], deductions = [], bonuses = [] } = {}) => ({
  positionMap: new Map([["p1", { id: "p1", name: "Tarbiyachi", baseSalary: "2000000" }]]),
  categoryMap: new Map(),
  salaryRules: new Map(),
  hoursMap: new Map(),
  bonusMap: new Map([[ALI, bonuses]]),
  deductionMap: new Map([[ALI, deductions]]),
  customBaseMap: new Map(),
  tutorGroupMap: new Map(),
  classStudentCounts: new Map(),
  suspensions: suspensionRows,
});

test("dvigatel: qismlar MUSTAQIL — asosiy oylik to'xtasa, undan foizli ustama o'zi to'xtamaydi", () => {
  const c = engine.computeForStaff(
    STAFF,
    CUR,
    ctxWith({
      bonuses: [{ id: "b1", label: "Ustama", type: "percent", value: "60" }],
      suspensionRows: [{ id: "s1", staffId: ALI, component: "base" }],
    }),
  );

  assert.equal(c.grossAmount.toFixed(2), "3200000.00"); // 2 000 000 + 60%
  assert.equal(c.suspendedAmount.toFixed(2), "2000000.00");
  assert.equal(c.amount.toFixed(2), "1200000.00");
  assert.equal(c.fixedAmount.toFixed(2), "2000000.00", "yalpi qismlar nolga yozilmaydi");
});

test("dvigatel: ushlab qolish TO'LANADIGAN yalpidan va invariant bajariladi", () => {
  const c = engine.computeForStaff(
    STAFF,
    CUR,
    ctxWith({
      bonuses: [{ id: "b1", label: "Staj", type: "fixed", value: "500000" }],
      suspensionRows: [{ id: "s1", staffId: ALI, component: "allowances" }],
      deductions: [{ id: "d1", reason: "Jarima", type: "percent", value: "10" }],
    }),
  );

  // Yalpi 2 500 000, to'xtatilgan 500 000 → to'lanadigan 2 000 000 → 10% = 200 000
  assert.equal(c.deductionAmount.toFixed(2), "200000.00");
  assert.equal(c.amount.toFixed(2), "1800000.00");
  // finance.md §9, 6-invariant
  const expected = c.fixedAmount
    .plus(c.kpiAmount)
    .plus(c.allowanceAmount)
    .minus(c.suspendedAmount)
    .minus(c.deductionAmount);
  assert.ok(c.amount.equals(expected));
});

test("dvigatel: to'liq to'xtatilgan oy — 0 so'm, ushlab qolish ham 0 (oylik manfiy bo'lmaydi)", () => {
  const c = engine.computeForStaff(
    STAFF,
    CUR,
    ctxWith({
      suspensionRows: [{ id: "s1", staffId: null, component: "all" }],
      deductions: [{ id: "d1", reason: "Qarz", type: "fixed", value: "300000" }],
    }),
  );

  assert.equal(c.amount.toFixed(2), "0.00");
  assert.equal(c.deductionAmount.toFixed(2), "0.00");
});

test("dvigatel: 'barcha xodimlar' qatori (staffId: null) hammaga, boshqaning qatori — yo'q", () => {
  const rows = [
    { id: "s-all", staffId: null, component: "base" },
    { id: "s-vali", staffId: VALI, component: "all" },
  ];
  assert.deepEqual(engine.suspensionsFor(rows, ALI).map((r) => r.id), ["s-all"]);
  assert.deepEqual(engine.suspensionsFor(rows, VALI).map((r) => r.id), ["s-all", "s-vali"]);
});

/* ───────────────────────── Qoralama tekshiruvi ───────────────────────── */

const draft = (data = {}) =>
  suspensions.parseDraft({
    scope: "staff",
    staffIds: [ALI],
    parts: [{ component: "base" }],
    startMonth: CUR,
    reason: "Ta'til",
    ...data,
  });

test("'barcha xodimlar' — serverda alohida tasdiqsiz rad etiladi", () => {
  assert.throws(() => draft({ scope: "all", staffIds: [] }), /tasdiqlang/);
  assert.throws(() => draft({ scope: "all", confirmAll: "true" }), /tasdiqlang/, "faqat aynan true");
  assert.equal(draft({ scope: "all", confirmAll: true }).scope, "all");
  assert.throws(() => draft({ scope: undefined }), BadRequestError);
});

test("davr: tugash oyi berilmasa — bitta oy; teskari davr va 12 oydan ko'pi rad etiladi", () => {
  const single = draft();
  assert.equal(single.endMonth, single.startMonth);

  assert.throws(() => draft({ startMonth: addMonths(CUR, 1), endMonth: CUR }), /oldin/);
  assert.equal(draft({ endMonth: addMonths(CUR, 11) }).endMonth, addMonths(CUR, 11), "12 oy — mumkin");
  assert.throws(() => draft({ endMonth: addMonths(CUR, 12) }), /12 oy/);
  assert.throws(() => draft({ startMonth: undefined }), BadRequestError);
});

test("sabab majburiy", () => {
  assert.throws(() => draft({ reason: "   " }), /sababini/);
  assert.throws(() => draft({ reason: "x".repeat(201) }), /200/);
});

test("aniq qo'shimcha — faqat BITTA xodim uchun va to'g'ri kalit bilan", () => {
  assert.throws(
    () => draft({ staffIds: [ALI, VALI], parts: [{ component: "item", itemKey: `tutor:${CLASS_A}` }] }),
    /faqat bitta xodim/,
  );
  assert.throws(
    () => draft({ scope: "all", confirmAll: true, parts: [{ component: "item", itemKey: `tutor:${CLASS_A}` }] }),
    /faqat bitta xodim/,
  );
  assert.throws(() => draft({ parts: [{ component: "item", itemKey: "label:Staj" }] }), /Qo'shimchani tanlang/);
  assert.equal(draft({ parts: [{ component: "item", itemKey: `tutor:${CLASS_A}` }] }).parts[0].itemKey, `tutor:${CLASS_A}`);
});

test("qismlar: takror olib tashlanadi, 'butun oylik' qolganlarini yutadi, 20 tadan ko'pi rad etiladi", () => {
  assert.equal(draft({ parts: [{ component: "base" }, { component: "base" }] }).parts.length, 1);
  assert.deepEqual(draft({ parts: [{ component: "tutor" }, { component: "all" }] }).parts, [
    { component: "all", itemKey: "" },
  ]);
  assert.throws(() => draft({ parts: Array.from({ length: 21 }, () => ({ component: "base" })) }), /20/);
  assert.throws(() => draft({ parts: [{ component: "salary" }] }), BadRequestError);
});

test("xodim identifikatori tekshiriladi", () => {
  assert.throws(() => draft({ staffIds: [] }), /Kamida bitta/);
  assert.throws(() => draft({ staffIds: ["' OR 1=1 --"] }), /identifikatori noto'g'ri/);
});

/* ───────────────────────── Yaratish ───────────────────────── */

const create = (data = {}) =>
  suspensions.createSuspension(
    { scope: "staff", staffIds: [ALI], parts: [{ component: "base" }], startMonth: CUR, reason: "Ta'til", ...data },
    "actor",
  );

test("yaratish: har xodim × har qism — alohida qator, bitta guruh (batchId)", async () => {
  reset();
  const result = await create({ staffIds: [ALI, VALI], parts: [{ component: "base" }, { component: "tutor" }] });

  assert.equal(result.rows, 4);
  assert.equal(db.suspensions.length, 4);
  assert.equal(new Set(db.suspensions.map((s) => s.batchId)).size, 1);
  assert.deepEqual(
    db.suspensions.map((s) => `${s.staffId === ALI ? "Ali" : "Vali"}:${s.component}`).sort(),
    ["Ali:base", "Ali:tutor", "Vali:base", "Vali:tutor"],
  );
  assert.equal(db.audits.at(-1).action, "suspension.create");
});

test("yaratish: 'barcha xodimlar' — BITTA qator, staffId: null", async () => {
  reset();
  await create({ scope: "all", confirmAll: true, staffIds: undefined });

  assert.equal(db.suspensions.length, 1);
  assert.equal(db.suspensions[0].staffId, null);
});

test("yaratish: aynan takror yozilmaydi — ikki marta bosilgan tugma ikki marta to'xtatmaydi", async () => {
  reset();
  await create();

  const second = await create({ staffIds: [ALI, VALI] });
  assert.equal(second.rows, 1, "faqat Vali yoziladi");
  assert.deepEqual(second.skippedDuplicates, ["Ali Valiyev"]);

  await assert.rejects(() => create(), ConflictError);
  assert.equal(db.suspensions.length, 2);
});

test("yaratish: o'quvchi yoki arxivlangan xodim bo'lsa BUTUN amal rad etiladi", async () => {
  reset();
  await assert.rejects(() => create({ staffIds: [ALI, STUDENT] }), /O'quvchiga oylik yo'q/);
  await assert.rejects(() => create({ staffIds: [ALI, ARCHIVED] }), /Arxivlangan/);
  await assert.rejects(() => create({ staffIds: [ALI, id("ff")] }), NotFoundError);
  assert.equal(db.suspensions.length, 0);
});

/* ───────────────────────── Muhrlangan oylikka ta'siri ───────────────────────── */

/** Muhrlangan majburiyat — `PARTS` tarkibi bilan, yalpi 3 750 000. */
const sealedEntry = (extra = {}) => ({
  id: "entry-ali",
  staffId: ALI,
  month: CUR,
  status: "unpaid",
  amount: "3750000.00",
  paidAmount: "0",
  fixedAmount: PARTS.fixedAmount,
  kpiAmount: PARTS.kpiAmount,
  allowanceAmount: "750000.00",
  allowanceBreakdown: [
    ...PARTS.allowanceBreakdown.filter((line) => line.type !== "tutor"),
    tutorLine(GROUP_A, 0, "200000.00"),
    tutorLine(GROUP_B, 0, "150000.00"),
  ],
  suspendedAmount: "0",
  suspensionBreakdown: [],
  deductionAmount: "0",
  deductionBreakdown: [],
  perHourRate: "0",
  staffSnapshot: { firstName: "Ali", lastName: "Valiyev" },
  ...extra,
});

test("to'lanmagan muhr: to'xtatish darhol ayiriladi, yalpi qismlarga tegilmaydi", async () => {
  reset();
  db.entries.push(sealedEntry());

  const result = await create({ parts: [{ component: "item", itemKey: `tutor:${CLASS_A}` }] });

  const entry = db.entries[0];
  assert.equal(result.resync.updated, 1);
  assert.equal(entry.suspendedAmount.toFixed(2), "200000.00");
  assert.equal(entry.amount.toFixed(2), "3550000.00");
  assert.equal(entry.fixedAmount, "2000000", "fiksa o'zgarmaydi");
  assert.equal(entry.allowanceBreakdown.length, 4, "tyutor qatori o'chirilmaydi — bekor qilinsa qaytadi");
});

test("to'lov tushgan muhr: summa to'langanidan kam bo'lib qolsa O'ZGARMAYDI (locked)", async () => {
  reset();
  db.entries.push(sealedEntry({ status: "paid", paidAmount: "3750000.00" }));

  const result = await create({ parts: [{ component: "tutor" }] });

  assert.equal(result.resync.updated, 0);
  assert.equal(result.resync.locked.length, 1);
  assert.equal(db.entries[0].amount, "3750000.00");
  assert.equal(db.suspensions.length, 1, "qoida baribir yoziladi — keyingi oylar uchun");
});

test("bekor qilish: sabab majburiy, oylik to'liq tiklanadi, ikkinchi marta bekor qilib bo'lmaydi", async () => {
  reset();
  db.entries.push(sealedEntry());
  await create({ parts: [{ component: "base" }] });
  assert.equal(db.entries[0].amount.toFixed(2), "750000.00");
  const [row] = db.suspensions;

  await assert.rejects(() => suspensions.cancelSuspension(row.id, " ", "actor"), /sababini/);

  const result = await suspensions.cancelSuspension(row.id, "Xato kiritilgan", "actor");
  assert.equal(result.cancelled, 1);
  assert.equal(row.status, "cancelled", "O'CHIRILMAYDI — bekor qilinadi");
  assert.equal(row.cancelReason, "Xato kiritilgan");
  assert.equal(row.cancelledBy, "actor");
  assert.equal(db.entries[0].amount.toFixed(2), "3750000.00");
  assert.equal(db.entries[0].suspendedAmount.toFixed(2), "0.00");

  await assert.rejects(() => suspensions.cancelSuspension(row.id, "yana", "actor"), NotFoundError);
});

/* ───────────────────────── Muhrni qayta hisoblash qoidalari ───────────────────────── */

const plainEntry = (extra = {}) =>
  sealedEntry({
    fixedAmount: "2000000",
    kpiAmount: "0",
    allowanceAmount: "0",
    allowanceBreakdown: [],
    amount: "2000000.00",
    ...extra,
  });

test("TYUTOR PULI DARHOL: to'langan oylikka guruh qo'shilsa summa oshadi, holat 'qisman' bo'ladi", () => {
  const entry = plainEntry({ status: "paid", paidAmount: "2000000.00" });
  const group = groupOf(CLASS_A, "5-A", "10000", "100000");

  const next = recomputeSealedEntry(entry, {
    groups: [group],
    studentCounts: new Map([[CLASS_A, 20]]),
    deductions: [],
    suspensions: [],
  });

  assert.equal(next.amount.toFixed(2), "2300000.00");
  assert.equal(next.data.status, "partial", "tyutor puli hali to'lanmagan");
  assert.equal(isResyncBlocked(entry, next), false);
});

test("to'langan oylikka faqat ushlab qolish qo'shilsa — tegilmaydi", () => {
  const entry = plainEntry({ status: "paid", paidAmount: "2000000.00" });

  const next = recomputeSealedEntry(entry, {
    groups: [],
    studentCounts: new Map(),
    deductions: [{ id: "d1", reason: "Jarima", type: "fixed", value: "100000" }],
    suspensions: [],
  });

  assert.equal(next.changed, true);
  assert.equal(next.structural, false);
  assert.equal(isResyncBlocked(entry, next), true);
});

test("to'lanmagan oylik har qanday o'zgarishda yangilanadi (bloklanmaydi)", () => {
  const entry = plainEntry();

  const next = recomputeSealedEntry(entry, {
    groups: [],
    studentCounts: new Map(),
    deductions: [{ id: "d1", reason: "Jarima", type: "fixed", value: "100000" }],
    suspensions: [{ id: "s1", staffId: ALI, component: "base" }],
  });

  assert.equal(next.amount.toFixed(2), "0.00");
  assert.equal(next.data.status, "paid", "0 so'mlik oylik 'to'langan' bo'ladi — registrdan yo'qolmaydi");
  assert.equal(isResyncBlocked(entry, next), false);
});

test("sinfga o'quvchi qo'shilishi muhrlangan tyutor qatorini QAYTA YOZMAYDI", () => {
  const group = groupOf(CLASS_A, "5-A", "10000", "100000");
  const entry = plainEntry({
    allowanceAmount: "300000.00",
    allowanceBreakdown: [tutorLine(group, 20, "300000.00")],
    amount: "2300000.00",
  });

  const next = recomputeSealedEntry(entry, {
    groups: [group],
    studentCounts: new Map([[CLASS_A, 25]]), // endi 25 ta
    deductions: [],
    suspensions: [],
  });

  assert.equal(next.changed, false);
  assert.equal(next.amount.toFixed(2), "2300000.00");
});

test("tyutor stavkasi o'zgarsa muhrlangan qator yangilanadi", () => {
  const oldGroup = groupOf(CLASS_A, "5-A", "10000", "100000");
  const entry = plainEntry({
    allowanceAmount: "300000.00",
    allowanceBreakdown: [tutorLine(oldGroup, 20, "300000.00")],
    amount: "2300000.00",
  });

  const next = recomputeSealedEntry(entry, {
    groups: [{ ...oldGroup, perStudentAmount: "15000" }],
    studentCounts: new Map([[CLASS_A, 20]]),
    deductions: [],
    suspensions: [],
  });

  assert.equal(next.changed, true);
  assert.equal(next.amount.toFixed(2), "2400000.00");
  assert.equal(next.data.allowanceAmount.toFixed(2), "400000.00");
});
