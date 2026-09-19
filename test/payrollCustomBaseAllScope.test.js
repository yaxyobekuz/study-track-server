const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * SHAXSIY MAOSH va "HAMMAGA" USHLAB QOLISH.
 *
 * Himoya qilinadigan narsa:
 *   · shaxsiy maosh lavozim maoshi O'RNIGA olinadi, lekin faqat o'sha
 *     lavozimda (taxminiy almashtirishga ergashmaydi);
 *   · lavozim olinsa/toifaga o'tsa shaxsiy maosh tozalanadi;
 *   · "hammaga" guruh keyin oyligi belgilangan xodimga yoyiladi, lekin
 *     bekor qilingan, arxivlangan, oyligi yo'q va aynan takrori bor
 *     xodimga — yo'q; qayta chaqiruv ikkinchi qator yozmaydi.
 *
 * Servislar va payroll dvigateli HAQIQIY kod, baza xotiradagi soxta.
 */

const { Decimal } = require("../src/helpers/money.helpers");
const { currentMonthKey, prevMonth } = require("../src/helpers/month.helpers");

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const same = (a, b) => {
  if (Decimal.isDecimal(b) || Decimal.isDecimal(a)) {
    try {
      return new Decimal(a ?? 0).equals(new Decimal(b ?? 0));
    } catch {
      return false;
    }
  }
  return a === b;
};

const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return cond.some((c) => matches(row, c));
    const value = row[key];
    if (cond && typeof cond === "object" && !Decimal.isDecimal(cond)) {
      if ("in" in cond) return cond.in.includes(value);
      if ("not" in cond) return cond.not === null ? value != null : !same(value, cond.not);
      return (
        value != null &&
        (!("lte" in cond) || value <= cond.lte) &&
        (!("gte" in cond) || value >= cond.gte)
      );
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
  findUnique: async ({ where }) => db[name].find((r) => r.id === where.id) ?? null,
  createMany: async ({ data }) => {
    for (const row of data) {
      seq += 1;
      db[name].push({ id: `${name}-${seq}`, createdAt: seq, status: "active", ...row });
    }
    return { count: data.length };
  },
  create: async ({ data }) => {
    seq += 1;
    const row = { id: `${name}-${seq}`, createdAt: seq, ...data };
    db[name].push(row);
    return row;
  },
  update: async ({ where, data }) => {
    const row = db[name].find((r) => r.id === where.id);
    Object.assign(row, data);
    return row;
  },
  updateMany: async ({ where, data }) => {
    const rows = db[name].filter((r) => matches(r, where));
    for (const row of rows) Object.assign(row, data);
    return { count: rows.length };
  },
});

const prisma = {
  user: table("users"),
  position: table("positions"),
  salaryCategory: table("categories"),
  payrollBonus: table("bonuses"),
  payrollDeduction: table("deductions"),
  payrollEntry: table("entries"),
  payrollAudit: table("audits"),
  staffSalary: table("salaries"),
  $transaction: async (fn) => fn(prisma),
  // Tyutor guruhlari va oylikni to'xtatish (2026-09-17) — bu testlarda yo'q
  tutorGroup: { findMany: async () => [] },
  payrollSuspension: { findMany: async () => [] },
};

fakeModule("../src/config/prisma", prisma);
fakeModule("../src/services/lessonHours.service", {
  computeLessonHoursForMonth: async (month, ids) => new Map(ids.map((id) => [String(id), { hours: 0 }])),
  computeLessonHoursForStaff: async () => ({ hours: 0 }),
});

const deductions = require("../src/services/payrollDeduction.service");
const departments = require("../src/services/department.service");
const { loadContext, computeForStaff } = require("../src/services/payrollEngine.service");

const MONTH = currentMonthKey();
const id = (ch) => ch.repeat(24);
const POS_A = id("1");
const POS_B = id("2");
const CAT = id("3");
const ADMIN = id("9");

const person = (key, firstName, extra = {}) => ({
  id: id(key),
  firstName,
  lastName: "",
  username: firstName.toLowerCase(),
  role: "cleaner",
  isArchived: false,
  positionId: POS_A,
  salaryCategoryId: null,
  customBaseSalary: null,
  ...extra,
});

const deduction = (staffId, extra = {}) => ({
  id: `d-${staffId}-${extra.batchId ?? "X"}`,
  staffId,
  batchId: "X",
  reason: "Soliq",
  type: "percent",
  value: new Decimal(10),
  startMonth: MONTH,
  endMonth: null,
  note: "",
  status: "active",
  appliesToAll: true,
  createdBy: ADMIN,
  createdAt: 5,
  ...extra,
});

const resetDb = () => {
  seq = 100;
  db = {
    users: [
      person("a", "Ali"),
      person("b", "Bobur"),
      person("c", "Charos", { positionId: null }), // oyligi yo'q
      person("d", "Dilshod", { isArchived: true }),
      person("e", "Erkin"), // guruhdagi qatori bekor qilingan
      person("f", "Farida"), // xuddi shu ushlab qolish boshqa guruhda bor
      person("s", "Talaba", { role: "student" }),
    ],
    positions: [
      { id: POS_A, name: "Farrosh", departmentId: "dept", baseSalary: new Decimal(2_400_000) },
      { id: POS_B, name: "Oshpaz", departmentId: "dept", baseSalary: new Decimal(5_000_000) },
    ],
    categories: [{ id: CAT, name: "1-toifa", departmentId: "teach", perHourRate: new Decimal(60_000) }],
    bonuses: [],
    deductions: [
      deduction(id("a")),
      deduction(id("e"), { status: "cancelled" }),
      deduction(id("f"), { batchId: "OLD", appliesToAll: false }),
    ],
    entries: [],
    audits: [],
    salaries: [],
  };
};

/* ───────────────────────── Shaxsiy maosh ───────────────────────── */

test("shaxsiy maosh lavozim maoshi o'rniga olinadi, faqat o'sha lavozimda", async () => {
  resetDb();
  db.users[0].customBaseSalary = new Decimal(2_200_000);
  const ali = db.users[0];

  const ctx = await loadContext(MONTH, [ali]);
  const own = computeForStaff(ali, MONTH, ctx);
  assert.equal(own.fixedAmount.toString(), "2200000");
  assert.equal(own.baseIsCustom, true);

  // Taxminiy almashtirish: boshqa lavozim — shaxsiy summa ergashmaydi
  const moved = { ...ali, positionId: POS_B };
  const movedCtx = await loadContext(MONTH, [moved]);
  const other = computeForStaff(moved, MONTH, movedCtx);
  assert.equal(other.fixedAmount.toString(), "5000000");
  assert.equal(other.baseIsCustom, false);

  // Chaqiruvchi maydonni tanlamagan bo'lsa ham (select'siz obyekt) — bazadan
  const bare = { id: ali.id, positionId: POS_A, salaryCategoryId: null };
  const bareCtx = await loadContext(MONTH, [bare]);
  assert.equal(computeForStaff(bare, MONTH, bareCtx).fixedAmount.toString(), "2200000");
});

test("biriktirish: shaxsiy maosh yoziladi, takror rad etiladi, toifaga o'tganda tozalanadi", async () => {
  resetDb();
  const bobur = id("b");

  const withCustom = await departments.assignStaff(bobur, { positionId: POS_A, customBaseSalary: "2200000" }, ADMIN);
  assert.equal(withCustom.customBaseSalary, "2200000.00");

  await assert.rejects(
    departments.assignStaff(bobur, { positionId: POS_A, customBaseSalary: 2200000 }, ADMIN),
    /allaqachon "Farrosh" lavozimida shu maosh bilan/,
  );

  // Lavozimdan — shaxsiy summa olib tashlanadi
  const plain = await departments.assignStaff(bobur, { positionId: POS_A, customBaseSalary: null }, ADMIN);
  assert.equal(plain.customBaseSalary, null);

  await departments.assignStaff(bobur, { positionId: POS_A, customBaseSalary: "3000000" }, ADMIN);
  const toCategory = await departments.assignStaff(bobur, { salaryCategoryId: CAT }, ADMIN);
  assert.equal(toCategory.positionId, null);
  assert.equal(toCategory.customBaseSalary, null);

  await assert.rejects(
    departments.assignStaff(bobur, { positionId: POS_A, customBaseSalary: "0" }, ADMIN),
    /noldan katta/,
  );
});

/* ───────────────────────── "Hammaga" yoyish ───────────────────────── */

test("hammaga: oyligi bor yangi xodimga yoyiladi, istisnolarga yo'q, takror yozilmaydi", async () => {
  resetDb();
  // Farida'da AYNAN shu ushlab qolish boshqa (eski) guruhda faol
  db.deductions[2] = deduction(id("f"), { id: "d-f-OLD", batchId: "OLD", appliesToAll: false });

  const first = await deductions.extendAllScopeDeductions();
  assert.equal(first.created, 1);

  const added = db.deductions.filter((d) => d.batchId === "X" && d.status === "active" && d.staffId !== id("a"));
  assert.deepEqual(added.map((d) => d.staffId), [id("b")]);
  // Siyosat o'rnida qoladi: guruh davri va yaratilish vaqti
  assert.equal(added[0].createdAt, 5);
  assert.equal(added[0].startMonth, MONTH);
  assert.equal(added[0].appliesToAll, true);
  assert.equal(db.audits.at(-1).action, "deduction.extend");

  const again = await deductions.extendAllScopeDeductions();
  assert.equal(again.created, 0);
});

test("hammaga: faqat berilgan xodim, muddati tugagan va oddiy guruh yoyilmaydi", async () => {
  resetDb();
  // Charos endi lavozimga biriktirildi — faqat unga
  db.users[2].positionId = POS_B;
  const onlyCharos = await deductions.extendAllScopeDeductions([id("c")]);
  assert.equal(onlyCharos.created, 1);
  assert.equal(db.deductions.filter((d) => d.staffId === id("b")).length, 0);

  resetDb();
  db.deductions = [deduction(id("a"), { endMonth: prevMonth(MONTH), startMonth: prevMonth(MONTH) })];
  assert.equal((await deductions.extendAllScopeDeductions()).created, 0);

  resetDb();
  db.deductions = [deduction(id("a"), { appliesToAll: false })];
  assert.equal((await deductions.extendAllScopeDeductions()).created, 0);
});

test("mavjud guruhni hammaga qilish: belgi qo'yiladi va darhol yoyiladi", async () => {
  resetDb();
  db.deductions = [deduction(id("a"), { batchId: "Y", appliesToAll: false })];

  const res = await deductions.applyBatchToAll("Y", ADMIN);
  // Bobur, Erkin, Farida — oyligi bor, guruhda qatori yo'q
  assert.equal(res.created, 3);
  assert.ok(db.deductions.every((d) => d.appliesToAll));

  await assert.rejects(deductions.applyBatchToAll("Y", ADMIN), /allaqachon/);
});

test("yaratish: 'hammasi' bilan yozilgan guruh ro'yxatdan tashqaridagilarga ham yoyiladi", async () => {
  resetDb();
  db.deductions = [];

  const res = await deductions.createDeductions(
    {
      staffIds: [id("a")],
      scope: "all",
      type: "fixed",
      value: "100000",
      reason: "Forma",
      startMonth: MONTH,
      endMonth: null,
    },
    ADMIN,
  );

  assert.equal(res.created, 1);
  // Bobur, Erkin, Farida — Charos (oyligi yo'q), Dilshod (arxiv), talaba — yo'q
  assert.equal(res.extended, 3);
  assert.ok(db.deductions.every((d) => d.appliesToAll && d.batchId === res.batchId));
});
