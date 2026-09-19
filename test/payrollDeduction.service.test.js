const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * OYLIKDAN USHLAB QOLISH — hisob, muhrni qayta hisoblash, bekor qilish.
 *
 * `payrollDeduction.service` va payroll dvigateli HAQIQIY kod bilan
 * ishlaydi; baza xotiradagi soxta. Eng xavfli joylar: to'langan oylikka
 * tegmaslik, oylik manfiy bo'lmasligi va to'lov bilan poyga.
 */

const { Decimal } = require("../src/helpers/money.helpers");
const { computeDeductions } = require("../src/helpers/salaryRules.helpers");
const { currentMonthKey, nextMonth } = require("../src/helpers/month.helpers");

/* ───────────────────────── Sof hisob ───────────────────────── */

test("foizlar yalpidan va qo'shiladi, jami yalpidan oshmaydi", () => {
  const r = computeDeductions("5000000.00", [
    { id: "a", reason: "A", type: "percent", value: "10" },
    { id: "b", reason: "B", type: "percent", value: "5" },
    { id: "c", reason: "C", type: "fixed", value: "4500000" },
  ]);

  // 10% + 5% = yalpining 15% (kompaund emas): 500 000 + 250 000
  assert.equal(r.breakdown[0].amount, "500000.00");
  assert.equal(r.breakdown[1].amount, "250000.00");
  // Qolgan 4 250 000 — qat'iy 4 500 000 chegaraga uriladi
  assert.equal(r.breakdown[2].amount, "4250000.00");
  assert.equal(r.breakdown[2].capped, true);
  assert.equal(r.total.toString(), "5000000");
});

test("dars soati: soat × soat narxi; narx yo'q bo'lsa ushlanmaydi", () => {
  const withRate = computeDeductions("6000000", [{ id: "h", reason: "H", type: "hours", value: "3" }], {
    perHourRate: "50000",
  });
  assert.equal(withRate.breakdown[0].amount, "150000.00");
  assert.equal(withRate.breakdown[0].noRate, false);

  const noRate = computeDeductions("6000000", [{ id: "h", reason: "H", type: "hours", value: "3" }]);
  assert.equal(noRate.total.toString(), "0");
  assert.equal(noRate.breakdown[0].noRate, true);
});

test("yalpi nol bo'lsa hech narsa ushlanmaydi", () => {
  const r = computeDeductions("0", [{ id: "a", reason: "A", type: "fixed", value: "100" }]);
  assert.equal(r.total.toString(), "0");
  assert.equal(r.breakdown[0].capped, true);
});

/* ───────────────────────── Soxta muhit ───────────────────────── */

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
    if (key === "AND") return cond.every((c) => matches(row, c));
    const value = row[key];
    if (cond && typeof cond === "object" && !Decimal.isDecimal(cond)) {
      if ("in" in cond) return cond.in.includes(value);
      if ("not" in cond) return !same(value, cond.not);
      return (
        value != null &&
        (!("lte" in cond) || value <= cond.lte) &&
        (!("gte" in cond) || value >= cond.gte)
      );
    }
    if (typeof cond === "number" && Decimal.isDecimal(value)) return same(value, cond);
    return same(value, cond);
  });

let db;
let seq = 0;
const table = (name) => ({
  findMany: async ({ where, orderBy } = {}) => {
    const rows = db[name].filter((r) => matches(r, where));
    return orderBy ? [...rows].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)) : rows;
  },
  findUnique: async ({ where }) => db[name].find((r) => r.id === where.id) ?? null,
  count: async ({ where } = {}) => db[name].filter((r) => matches(r, where)).length,
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
  updateMany: async ({ where, data }) => {
    const rows = db[name].filter((r) => matches(r, where));
    for (const row of rows) Object.assign(row, data);
    return { count: rows.length };
  },
  groupBy: async () => [],
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

const service = require("../src/services/payrollDeduction.service");
const { loadContext, computeForStaff } = require("../src/services/payrollEngine.service");

const MONTH = currentMonthKey();
const IDS = { a: "a".repeat(24), b: "b".repeat(24), c: "c".repeat(24), student: "d".repeat(24) };

const person = (id, firstName) => ({
  id,
  firstName,
  lastName: "",
  username: firstName.toLowerCase(),
  role: "teacher",
  isArchived: false,
  positionId: null,
  salaryCategoryId: null,
});

const rule = (staffId, fixed, rate = 0) => ({
  id: `rule-${staffId}`,
  staffId,
  type: "fixed",
  fixedAmount: new Decimal(fixed),
  perHourRate: new Decimal(rate),
  allowances: [],
  startMonth: 202501,
  endMonth: null,
  categoryId: null,
});

const entry = (staffId, amount, extra = {}) => ({
  id: `entry-${staffId}`,
  staffId,
  month: MONTH,
  amount: new Decimal(amount),
  paidAmount: new Decimal(extra.paid ?? 0),
  status: extra.status ?? "unpaid",
  fixedAmount: new Decimal(amount),
  kpiAmount: new Decimal(0),
  allowanceAmount: new Decimal(0),
  perHourRate: new Decimal(extra.rate ?? 0),
  deductionAmount: new Decimal(0),
  deductionBreakdown: [],
  staffSnapshot: { firstName: staffId === IDS.b ? "Bobur" : "Ali", lastName: "" },
});

const resetDb = () => {
  seq = 0;
  db = {
    users: [
      person(IDS.a, "Ali"),
      person(IDS.b, "Bobur"),
      person(IDS.c, "Charos"),
      { ...person(IDS.student, "Talaba"), role: "student" },
    ],
    positions: [],
    categories: [],
    bonuses: [],
    deductions: [],
    audits: [],
    salaries: [rule(IDS.a, 5_000_000, 40_000), rule(IDS.b, 4_000_000), rule(IDS.c, 3_000_000, 50_000)],
    entries: [
      // Ali — muhrlangan, to'lanmagan → qayta hisoblanadi (muhrdagi soat narxi 40 000)
      entry(IDS.a, 5_000_000, { rate: 40_000 }),
      // Bobur — qisman to'langan → QULFLANGAN
      entry(IDS.b, 4_000_000, { paid: 1_000_000, status: "partial" }),
      // Charos — shu oy hali shakllantirilmagan → jonli
    ],
  };
};

const draft = (extra = {}) => ({
  staffIds: [IDS.a, IDS.b, IDS.c],
  type: "percent",
  value: "10",
  reason: "Kechikishlar uchun",
  startMonth: MONTH,
  ...extra,
});

/* ───────────────────────── Qoralama ───────────────────────── */

test("qoralama tekshiruvi: xato qiymatlar rad etiladi, standart davr — bitta oy", () => {
  assert.throws(() => service.parseDraft(draft({ staffIds: [] })), /Kamida bitta xodim/);
  assert.throws(() => service.parseDraft(draft({ value: "101" })), /100 dan oshmasligi/);
  assert.throws(() => service.parseDraft(draft({ value: "0" })), /noldan katta/);
  assert.throws(() => service.parseDraft(draft({ reason: "  " })), /sababini/);
  assert.throws(() => service.parseDraft(draft({ type: "bonus" })), /so'm, foiz yoki dars soati/);
  assert.throws(
    () => service.parseDraft(draft({ endMonth: 202401 })),
    /oldin bo'lishi mumkin emas/,
  );

  assert.throws(() => service.parseDraft(draft({ type: "hours", value: "2.5" })), /butun son/);
  assert.throws(() => service.parseDraft(draft({ type: "hours", value: "501" })), /butun son/);
  assert.equal(service.parseDraft(draft({ type: "hours", value: "3" })).value.toString(), "3");

  assert.equal(service.parseDraft(draft()).endMonth, MONTH);
  assert.equal(service.parseDraft(draft({ endMonth: null })).endMonth, null);
  // Takror id bitta bo'lib qoladi
  assert.equal(service.parseDraft(draft({ staffIds: [IDS.a, IDS.a] })).staffIds.length, 1);
});

test("o'quvchi tanlansa butun amal rad etiladi", async () => {
  resetDb();
  await assert.rejects(
    service.previewDeductions(draft({ staffIds: [IDS.a, IDS.student] })),
    /O'quvchidan/,
  );
});

/* ───────────────────────── Oldindan hisob ───────────────────────── */

test("oldindan hisob: muhr holati va summalar, hech narsa yozilmaydi", async () => {
  resetDb();
  const preview = await service.previewDeductions(draft());
  const byName = Object.fromEntries(preview.items.map((row) => [row.fullName, row]));

  assert.equal(byName.Ali.sealState, "resync");
  assert.equal(byName.Ali.draftAmount, "500000.00");
  assert.equal(byName.Ali.netAfter, "4500000.00");
  assert.equal(byName.Bobur.sealState, "locked");
  assert.equal(byName.Bobur.applies, false);
  assert.equal(byName.Charos.sealState, "none");
  assert.equal(byName.Charos.draftAmount, "300000.00");

  // Qulflangan (Bobur) jamiga kirmaydi: 500 000 + 300 000
  assert.equal(preview.totals.totalAmount, "800000.00");
  assert.equal(preview.totals.lockedCount, 1);
  assert.equal(preview.totals.resyncCount, 1);
  assert.equal(db.deductions.length, 0);
});

/* ───────────────────────── Yaratish ───────────────────────── */

test("yaratish: har xodimga qator, to'lanmagan muhr qayta hisoblanadi, to'langaniga tegilmaydi", async () => {
  resetDb();
  const result = await service.createDeductions(draft(), "admin1");

  assert.equal(result.created, 3);
  assert.equal(new Set(db.deductions.map((d) => d.batchId)).size, 1);
  assert.equal(db.audits.length, 1);

  const ali = db.entries.find((e) => e.staffId === IDS.a);
  assert.equal(ali.amount.toString(), "4500000");
  assert.equal(ali.deductionAmount.toString(), "500000");
  // Yalpi qismlar TEGILMAYDI
  assert.equal(ali.fixedAmount.toString(), "5000000");
  assert.equal(ali.status, "unpaid");

  const bobur = db.entries.find((e) => e.staffId === IDS.b);
  assert.equal(bobur.amount.toString(), "4000000");
  assert.equal(result.resync.updated, 1);
  assert.deepEqual(result.resync.locked.map((l) => l.staffName), ["Bobur"]);

  // Charos — shakllantirilmagan oy: dvigatel jonli hisobda ushlab qoladi
  const users = db.users.filter((u) => u.id === IDS.c);
  const salaryRules = new Map([[IDS.c, db.salaries.find((s) => s.staffId === IDS.c)]]);
  const ctx = await loadContext(MONTH, users, { salaryRules, hoursMap: new Map() });
  const charos = computeForStaff(users[0], MONTH, ctx);
  assert.equal(charos.grossAmount.toString(), "3000000");
  assert.equal(charos.amount.toString(), "2700000");
});

test("aynan takror yozilmaydi — ikki marta bosilgan tugma ikki marta ushlamaydi", async () => {
  resetDb();
  await service.createDeductions(draft({ staffIds: [IDS.a] }), "admin1");
  await assert.rejects(
    service.createDeductions(draft({ staffIds: [IDS.a] }), "admin1"),
    /allaqachon yozilgan/,
  );

  const mixed = await service.createDeductions(draft({ staffIds: [IDS.a, IDS.c] }), "admin1");
  assert.equal(mixed.created, 1);
  assert.deepEqual(mixed.skippedDuplicates, ["Ali"]);
  assert.equal(db.deductions.filter((d) => d.staffId === IDS.a).length, 1);
});

test("to'liq ushlab qolingan muhr 0 so'm va 'to'langan' bo'ladi, bekor qilinsa qaytadi", async () => {
  resetDb();
  const { batchId } = await service.createDeductions(
    draft({ staffIds: [IDS.a], type: "fixed", value: "9000000" }),
    "admin1",
  );

  const ali = db.entries.find((e) => e.staffId === IDS.a);
  assert.equal(ali.amount.toString(), "0");
  assert.equal(ali.status, "paid");
  assert.equal(ali.deductionBreakdown[0].capped, true);

  const cancelled = await service.cancelBatch(batchId, "Xato kiritilgan", "admin1");
  assert.equal(cancelled.cancelled, 1);
  assert.equal(ali.amount.toString(), "5000000");
  assert.equal(ali.deductionAmount.toString(), "0");
  assert.equal(ali.status, "unpaid");
  assert.equal(db.deductions[0].status, "cancelled");
  assert.equal(db.deductions[0].cancelReason, "Xato kiritilgan");
  assert.equal(db.audits.length, 2);
});

test("poyga: muhr shu orada o'zgarsa yozilmaydi, ziddiyat sifatida qaytadi", async () => {
  resetDb();
  const original = prisma.payrollEntry.updateMany;
  // Qayta hisoblash o'qigandan keyin to'lov tushdi
  prisma.payrollEntry.updateMany = async (args) => {
    const ali = db.entries.find((e) => e.staffId === IDS.a);
    ali.paidAmount = new Decimal(100_000);
    ali.status = "partial";
    return original(args);
  };
  try {
    const result = await service.createDeductions(draft({ staffIds: [IDS.a] }), "admin1");
    assert.equal(result.resync.updated, 0);
    assert.equal(result.resync.conflicts, 1);
    assert.equal(db.entries.find((e) => e.staffId === IDS.a).amount.toString(), "5000000");
  } finally {
    prisma.payrollEntry.updateMany = original;
  }
});

test("bekor qilish sababsiz rad etiladi, qayta bekor qilib bo'lmaydi", async () => {
  resetDb();
  const { batchId } = await service.createDeductions(draft({ staffIds: [IDS.c] }), "admin1");
  const id = db.deductions[0].id;

  await assert.rejects(service.cancelDeduction(id, " ", "admin1"), /sababini/);
  await service.cancelBatch(batchId, "Kelishildi", "admin1");
  await assert.rejects(service.cancelDeduction(id, "Yana", "admin1"), /Faol ushlab qolish topilmadi/);
});

test("kelajak oyga yozilgan qoida joriy muhrga tegmaydi", async () => {
  resetDb();
  const result = await service.createDeductions(
    draft({ staffIds: [IDS.a], startMonth: nextMonth(MONTH) }),
    "admin1",
  );
  assert.equal(result.resync.updated, 0);
  assert.equal(db.entries.find((e) => e.staffId === IDS.a).amount.toString(), "5000000");
});

test("dars soati bo'yicha: narxi borlardan soat × narx, fiksa xodimdan ushlanmaydi", async () => {
  resetDb();
  const preview = await service.previewDeductions(draft({ type: "hours", value: "3" }));
  const byName = Object.fromEntries(preview.items.map((row) => [row.fullName, row]));

  // Ali — muhrlangan: narx MUHRDAN (40 000)
  assert.equal(byName.Ali.draftAmount, "120000.00");
  // Charos — jonli: narx oylik shartidan (50 000)
  assert.equal(byName.Charos.draftAmount, "150000.00");
  // Bobur — soat narxi yo'q (faqat fiksa)
  assert.equal(byName.Bobur.noRate, true);
  assert.equal(byName.Bobur.draftAmount, "0.00");
  assert.equal(preview.totals.noRateCount, 1);

  const result = await service.createDeductions(draft({ staffIds: [IDS.a], type: "hours", value: "3" }), "admin1");
  assert.equal(result.resync.updated, 1);
  const ali = db.entries.find((e) => e.staffId === IDS.a);
  assert.equal(ali.amount.toString(), "4880000");
  assert.equal(ali.deductionBreakdown[0].rate, "40000.00");
});


test("xodimning o'zi: sabab, izoh, qancha va qaysi oy — muhrdan yoki jonli hisobdan", async () => {
  resetDb();
  await service.createDeductions(
    draft({ staffIds: [IDS.a, IDS.c], note: "3 marta kechikkan: 2, 9, 11-sentabr" }),
    "admin1",
  );
  // Ali uchun ikkinchi, keyin bekor qilingan — muhrga yetib bormagan
  await service.createDeductions(
    draft({ staffIds: [IDS.c], type: "fixed", value: "100000", reason: "Xato" }),
    "admin1",
  );
  const wrong = db.deductions.find((d) => d.reason === "Xato");
  await service.cancelDeduction(wrong.id, "Xato kiritilgan", "admin1");

  // Ali — muhrlangan oy: aynan ushlangani
  const ali = await service.listMyDeductions(IDS.a);
  assert.equal(ali.items.length, 1);
  assert.equal(ali.items[0].reason, "Kechikishlar uchun");
  assert.equal(ali.items[0].note, "3 marta kechikkan: 2, 9, 11-sentabr");
  assert.equal(ali.items[0].type, "percent");
  assert.deepEqual(
    ali.items[0].months.map((m) => [m.month, m.amount, m.sealed]),
    [[MONTH, "500000.00", true]],
  );
  assert.equal(ali.totals.withheld, "500000.00");
  assert.equal(ali.totals.currentMonth, "500000.00");

  // Charos — shakllanmagan oy: jonli hisob; bekor qilingani ko'rinmaydi
  const charos = await service.listMyDeductions(IDS.c);
  assert.deepEqual(charos.items.map((item) => item.reason), ["Kechikishlar uchun"]);
  assert.deepEqual(
    charos.items[0].months.map((m) => [m.amount, m.sealed]),
    [["300000.00", false]],
  );
  assert.equal(charos.totals.withheld, "0.00");
  assert.equal(charos.totals.currentMonth, "300000.00");

  // Boshqa xodimda ushlab qolish yo'q
  assert.deepEqual((await service.listMyDeductions(IDS.b)).items, []);
});
