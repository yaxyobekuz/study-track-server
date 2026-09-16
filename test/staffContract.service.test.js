const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * SHARTNOMA SHARTI — jonli hisob va saqlash oqimi.
 *
 * `staffContract.service` HAQIQIY kodi va HAQIQIY payroll dvigateli
 * ishlaydi; baza xotiradagi soxta, dars soati esa qat'iy son bilan
 * almashtiriladi (jadvalni yoyish bu testning mavzusi emas).
 */

const { Decimal } = require("../src/helpers/money.helpers");

/* ───────────────────────── Soxta muhit ───────────────────────── */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const HOURS = 80;

let db;
const resetDb = () => {
  db = {
    users: [
      {
        id: "u1",
        firstName: "Ali",
        lastName: "Valiyev",
        username: "ali",
        role: "teacher",
        isArchived: false,
        positionId: "p1",
        salaryCategoryId: null,
      },
    ],
    positions: [
      { id: "p1", name: "Metodist", baseSalary: new Decimal(3_000_000), department: { name: "Boshqaruv" } },
    ],
    categories: [
      {
        id: "c1",
        name: "1-toifa",
        perHourRate: new Decimal(60_000),
        isArchived: false,
        isActive: true,
        department: { name: "Boshlang'ich" },
      },
    ],
    salaries: [
      {
        id: "s1",
        staffId: "u1",
        type: "fixed",
        fixedAmount: new Decimal(5_000_000),
        perHourRate: new Decimal(0),
        categoryId: null,
        allowances: [],
        startMonth: 202601,
        endMonth: null,
        note: "",
      },
    ],
    bonuses: [],
    entries: [{ staffId: "u1", month: 202609, status: "unpaid" }],
    audits: [],
  };
};

const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return cond.some((c) => matches(row, c));
    const value = row[key];
    if (cond && typeof cond === "object") {
      if ("in" in cond) return cond.in.includes(value);
      if ("not" in cond) return value !== cond.not;
      return (
        value != null &&
        (!("lte" in cond) || value <= cond.lte) &&
        (!("gte" in cond) || value >= cond.gte)
      );
    }
    return value === cond;
  });

const sortByStart = (rows, orderBy) => {
  const dir = orderBy?.startMonth;
  if (!dir) return rows;
  return [...rows].sort((a, b) =>
    dir === "desc" ? b.startMonth - a.startMonth : a.startMonth - b.startMonth,
  );
};

const table = (name) => ({
  findUnique: async ({ where }) => db[name].find((r) => matches(r, where)) ?? null,
  findFirst: async ({ where, orderBy }) =>
    sortByStart(db[name].filter((r) => matches(r, where)), orderBy)[0] ?? null,
  findMany: async ({ where, orderBy } = {}) =>
    sortByStart(db[name].filter((r) => matches(r, where)), orderBy),
  update: async ({ where, data }) => {
    const row = db[name].find((r) => matches(r, where));
    Object.assign(row, data);
    return row;
  },
  create: async ({ data }) => {
    const row = { id: `${name}-${db[name].length + 1}`, ...data };
    db[name].push(row);
    return row;
  },
  delete: async ({ where }) => {
    db[name] = db[name].filter((r) => !matches(r, where));
  },
});

const prisma = {
  user: table("users"),
  position: table("positions"),
  salaryCategory: table("categories"),
  staffSalary: table("salaries"),
  payrollBonus: table("bonuses"),
  payrollEntry: table("entries"),
  payrollAudit: table("audits"),
  $transaction: async (fn) => fn(prisma),
};

fakeModule("../src/config/prisma", prisma);
fakeModule("../src/services/lessonHours.service", {
  computeLessonHoursForMonth: async (month, ids) =>
    new Map(ids.map((id) => [String(id), { hours: HOURS }])),
  computeLessonHoursForStaff: async () => ({ hours: HOURS }),
});

const service = require("../src/services/staffContract.service");

/* ───────────────────────── Testlar ───────────────────────── */

test("forma amaldagi qoida, lavozim va toifalardan ochiladi", async () => {
  resetDb();
  const contract = await service.getContract("u1", 202609);

  assert.equal(contract.rateSource, "none");
  assert.equal(contract.fixedAmount, "5000000.00");
  assert.equal(contract.rule.id, "s1");
  assert.equal(contract.position.baseSalary, "3000000.00");
  assert.equal(contract.categories.length, 1);
});

test("jonli hisob dvigateldan: lavozim + fiksa + soat × qo'lda narx + foizli ustama", async () => {
  resetDb();
  const preview = await service.previewContract("u1", {
    month: 202609,
    fixedAmount: "5000000",
    rateSource: "manual",
    perHourRate: "40000",
    allowances: [{ label: "Sertifikat", type: "percent", value: 10 }],
  });

  // fiksa = 3 000 000 (lavozim) + 5 000 000; soat = 80 × 40 000 = 3 200 000
  // ustama = 10% × (8 000 000 + 3 200 000) = 1 120 000
  assert.equal(preview.fixedAmount, "8000000.00");
  assert.equal(preview.kpiAmount, "3200000.00");
  assert.equal(preview.allowanceAmount, "1120000.00");
  assert.equal(preview.amount, "12320000.00");
  assert.equal(preview.salaryType, "mixed");
  assert.equal(preview.changeKind, "split");
  assert.equal(preview.positionRemoved, false);
  assert.deepEqual(
    preview.sealedMonths.map((m) => m.month),
    [202609],
  );

  // Oldindan ko'rish hech narsa yozmaydi
  assert.equal(db.salaries.length, 1);
  assert.equal(db.audits.length, 0);
});

test("saqlash: eski davr yopiladi, yangisi ochiladi, audit yoziladi", async () => {
  resetDb();
  await service.saveContract(
    "u1",
    { month: 202609, fixedAmount: "6000000", rateSource: "manual", perHourRate: "40000" },
    "admin1",
  );

  const [old, next] = sortByStart(db.salaries, { startMonth: "asc" });
  assert.equal(old.endMonth, 202608);
  assert.equal(next.startMonth, 202609);
  assert.equal(next.endMonth, null);
  assert.equal(next.fixedAmount.toString(), "6000000");
  assert.equal(next.perHourRate.toString(), "40000");
  assert.equal(next.type, "mixed");
  assert.equal(db.audits.length, 1);
  assert.equal(db.audits[0].action, "salary.contract");
});

test("toifa tanlansa lavozim olib tashlanadi va toifa stavkasi ishlaydi", async () => {
  resetDb();
  const preview = await service.previewContract("u1", {
    month: 202609,
    fixedAmount: "5000000",
    rateSource: "category",
    categoryId: "c1",
  });

  assert.equal(preview.positionRemoved, true);
  assert.equal(preview.categoryChanged, true);
  assert.equal(preview.fixedAmount, "5000000.00");
  assert.equal(preview.kpiAmount, "4800000.00");
  // Qoida o'zgarmagan — faqat toifa
  assert.equal(preview.changeKind, "category");

  await service.saveContract(
    "u1",
    { month: 202609, fixedAmount: "5000000", rateSource: "category", categoryId: "c1" },
    "admin1",
  );

  assert.equal(db.users[0].salaryCategoryId, "c1");
  assert.equal(db.users[0].positionId, null);
  assert.equal(db.salaries.length, 1);
  assert.equal(db.salaries[0].endMonth, null);
  // Hosila rejim o'sha qatorda to'g'rilanadi, yangi davr ochilmaydi
  assert.equal(db.salaries[0].type, "mixed");
  assert.equal(db.audits.length, 1);
});

test("hech narsa o'zgarmasa yozilmaydi", async () => {
  resetDb();
  const draft = { month: 202609, fixedAmount: "5000000", rateSource: "none" };

  const preview = await service.previewContract("u1", draft);
  assert.equal(preview.changeKind, "none");

  await service.saveContract("u1", draft, "admin1");
  assert.equal(db.salaries.length, 1);
  assert.equal(db.audits.length, 0);
});

test("to'liq kiritilmagan qoralama rad etiladi", async () => {
  resetDb();
  await assert.rejects(
    service.previewContract("u1", { month: 202609, rateSource: "manual" }),
    /1 soat narxi/,
  );
  await assert.rejects(
    service.saveContract("u1", { month: 202609, rateSource: "category" }, "admin1"),
    /Toifa tanlanmagan/,
  );
});

test("dvigatel qo'lda soat narxli (toifasiz) o'qituvchining soatini ham yuklaydi", async () => {
  resetDb();
  const { loadContext, computeForStaff } = require("../src/services/payrollEngine.service");
  const user = { ...db.users[0], positionId: null };
  const salaryRules = new Map([
    ["u1", { staffId: "u1", fixedAmount: new Decimal(0), perHourRate: new Decimal(40_000), allowances: [] }],
  ]);

  // `hoursMap` BERILMAYDI — oylik shakllantirish aynan shunday chaqiradi
  const ctx = await loadContext(202609, [user], { salaryRules });
  const result = computeForStaff(user, 202609, ctx);

  assert.equal(result.kpiAmount.toString(), "3200000");
  assert.equal(result.salaryType, "kpi");
});
