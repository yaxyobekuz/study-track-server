const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * KELMAGAN KUNLAR — fiksa oylikdan kunlik ayirma (`finance.md` §10,
 * biznes qarori 2026-10-02).
 *
 * Himoya qilinadigan narsa:
 *   · ish kunlari = oy − yakshanba − bayram; kunlik = fiksa ÷ ish kunlari;
 *   · "kelmadi" HAM, "sababli" HAM ayiriladi, kech kelgan — YO'Q;
 *   · yakshanba/bayramdagi belgi sanalmaydi, ayirma fiksadan oshmaydi;
 *   · faqat FIKSA qism (soatbay qism va ustamalar tegilmaydi);
 *   · "asosiy oylik" to'xtatilsa summa ikki marta ayirilmaydi;
 *   · amount = fixed + kpi + allowance − absence − suspended − deduction;
 *   · muhrlangan oylik davomat o'zgarsa qayta hisoblanadi, to'langanidan
 *     kam bo'lib qolsa — tegilmaydi (ortiqcha to'lov yo'q);
 *   · sozlamadagi boshlanish oyidan oldingi oylarga tegilmaydi.
 *
 * Formula, dvigatel va qayta hisob HAQIQIY kodi ishlaydi; baza xotiradagi soxta.
 */

/* ───────────────────────── Soxta muhit ───────────────────────── */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

let settings = { id: "singleton", absenceDeductionFromMonth: 202610 };
let attendances = [];
let holidays = [];

const inRange = (value, cond) =>
  (cond.gte == null || value >= cond.gte) && (cond.lte == null || value <= cond.lte);

const prisma = {
  financeSettings: { upsert: async () => settings },
  holiday: { findMany: async () => holidays },
  attendance: {
    findMany: async ({ where }) =>
      attendances.filter(
        (row) =>
          where.userId.in.includes(row.userId) &&
          inRange(row.date, where.date) &&
          where.status.in.includes(row.status),
      ),
  },
};

fakeModule("../src/config/prisma", prisma);
fakeModule("../src/config/platformPrisma", { role: { findMany: async () => [] } });

const { Decimal } = require("../src/helpers/money.helpers");
const { computeAbsenceDeduction } = require("../src/helpers/salaryRules.helpers");
const { computeForStaff } = require("../src/services/payrollEngine.service");
const { recomputeSealedEntry, isResyncBlocked } = require("../src/services/payrollDeduction.service");
const { loadAbsenceFacts, serializeAbsence } = require("../src/services/payrollAbsence.service");

/* ───────────────────────── Ma'lumot ───────────────────────── */

// Oktabr, 2026: 31 kun, yakshanbalar 4/11/18/25, 1-oktabr — bayram.
// Ish kunlari = 31 − 4 − 1 = 26. Fiksa 5 200 000 → kunlik 200 000.
const OCT = 202610;
const SUNDAYS = ["2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25"];
const HOLIDAY = "2026-10-01";
const WORK_DAYS = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`)
  .filter((day) => !SUNDAYS.includes(day) && day !== HOLIDAY);

const id = (prefix) => prefix.padEnd(24, "0");
const ALI = id("a1");
const POS = id("p1");
const CAT = id("k1");

const money = (value) => new Decimal(value).toFixed(2);

const day = (iso) => new Date(`${iso}T00:00:00Z`);

/** Ikki kelmagan ish kuni + sanalmaydiganlar (kech, yakshanba, bayram, takror). */
const ALI_ABSENCES = [
  { day: "2026-10-05", status: "absent" },
  { day: "2026-10-06", status: "excused" },
  { day: "2026-10-07", status: "late" },
  { day: "2026-10-04", status: "absent" },
  { day: HOLIDAY, status: "absent" },
  { day: "2026-10-05", status: "absent" },
];

/** Dvigatel konteksti — DB'siz, faqat shu testga kerak qismlar. */
const ctxOf = ({ absences = ALI_ABSENCES, enabled = true, category = null, hours = 0, suspensions = [], deductions = [] } = {}) => ({
  positionMap: new Map([[POS, { id: POS, name: "O'qituvchi", baseSalary: "5200000", department: { name: "Ta'lim" } }]]),
  categoryMap: new Map(category ? [[CAT, category]] : []),
  salaryRules: new Map(),
  hoursMap: new Map([[ALI, { hours }]]),
  bonusMap: new Map(),
  deductionMap: new Map([[ALI, deductions]]),
  customBaseMap: new Map(),
  tutorGroupMap: new Map(),
  classStudentCounts: new Map(),
  suspensions,
  absence: { enabled, workDays: WORK_DAYS, byStaff: new Map([[ALI, absences]]) },
});

const ali = (extra = {}) => ({ id: ALI, positionId: POS, salaryCategoryId: null, ...extra });

/* ───────────────────────── Formula ───────────────────────── */

test("formula: kunlik = fiksa ÷ ish kunlari; kelmadi va sababli sanaladi, kech/yakshanba/bayram/takror — yo'q", () => {
  const { total, breakdown } = computeAbsenceDeduction("5200000", {
    workDays: WORK_DAYS,
    absences: ALI_ABSENCES,
  });

  assert.equal(breakdown.workDays, 26);
  assert.equal(breakdown.dailyRate, "200000.00");
  assert.deepEqual(breakdown.days, [
    { date: "2026-10-05", status: "absent", amount: "200000.00" },
    { date: "2026-10-06", status: "excused", amount: "200000.00" },
  ]);
  assert.equal(money(total), "400000.00");
});

test("formula: kunlik summa butun so'mgacha PASTGA (xodim foydasiga)", () => {
  // 6 254 000 / 27 = 231 629.63 → 231 629
  const workDays = WORK_DAYS.concat(HOLIDAY);
  const { breakdown } = computeAbsenceDeduction("6254000", {
    workDays,
    absences: [{ day: "2026-10-05", status: "absent" }],
  });
  assert.equal(breakdown.workDays, 27);
  assert.equal(breakdown.dailyRate, "231629.00");
  assert.equal(breakdown.days[0].amount, "231629.00");
});

test("formula: ayirma fiksadan oshmaydi — oxirgi kun qoldiqqacha qisqaradi", () => {
  const workDays = ["2026-10-02", "2026-10-03", "2026-10-05"];
  const absences = workDays.map((d) => ({ day: d, status: "absent" }));
  const { total, breakdown } = computeAbsenceDeduction("2", { workDays, absences });

  // Fiksa ish kunlaridan kichik: butun so'm 0 bo'lardi → 2 xona, 0.67 × 3 = 2.01
  assert.equal(breakdown.dailyRate, "0.67");
  assert.deepEqual(breakdown.days.map((d) => d.amount), ["0.67", "0.67", "0.66"]);
  assert.equal(money(total), "2.00");
});

test("formula: fiksa yo'q (faqat soatbay / tyutor) — hech narsa ayirilmaydi", () => {
  const { total, breakdown } = computeAbsenceDeduction("0", { workDays: WORK_DAYS, absences: ALI_ABSENCES });
  assert.equal(money(total), "0.00");
  assert.ok(breakdown.days.every((d) => d.amount === "0.00"));
});

/* ───────────────────────── Dvigatel ───────────────────────── */

test("dvigatel: fiksa xodim — amount = yalpi − kelmagan kunlar", () => {
  const c = computeForStaff(ali(), OCT, ctxOf());

  assert.equal(money(c.grossAmount), "5200000.00");
  assert.equal(money(c.absenceAmount), "400000.00");
  assert.equal(money(c.amount), "4800000.00");
  // Yalpi qismlar O'ZGARMAYDI — davomat to'g'rilansa ayirma qaytadi
  assert.equal(money(c.fixedAmount), "5200000.00");
});

test("dvigatel: fiksa + soatbay — faqat fiksa qismdan, soat puli tegilmaydi", () => {
  const c = computeForStaff(
    ali({ positionId: POS, salaryCategoryId: CAT }),
    OCT,
    ctxOf({ category: { id: CAT, name: "Oliy", perHourRate: "50000" }, hours: 20 }),
  );

  assert.equal(money(c.kpiAmount), "1000000.00");
  assert.equal(money(c.absenceAmount), "400000.00");
  assert.equal(money(c.amount), "5800000.00");
});

test("dvigatel: asosiy oylik to'xtatilsa — kelmagan kun bilan ikki marta ayirilmaydi", () => {
  const c = computeForStaff(
    ali(),
    OCT,
    ctxOf({ suspensions: [{ id: "s1", component: "base", reason: "Ta'til" }] }),
  );

  assert.equal(money(c.absenceAmount), "400000.00");
  assert.equal(money(c.suspendedAmount), "4800000.00");
  assert.equal(money(c.amount), "0.00");
});

test("dvigatel: foizli ushlab qolish kelmagan kunlardan KEYINGI summadan olinadi", () => {
  const c = computeForStaff(
    ali(),
    OCT,
    ctxOf({ deductions: [{ id: "d1", reason: "Kredit", type: "percent", value: "10" }] }),
  );

  assert.equal(money(c.deductionAmount), "480000.00");
  assert.equal(money(c.amount), "4320000.00");
  // Invariant (financeReconcile 6)
  assert.equal(
    money(c.fixedAmount.plus(c.kpiAmount).plus(c.allowanceAmount)
      .minus(c.absenceAmount).minus(c.suspendedAmount).minus(c.deductionAmount)),
    money(c.amount),
  );
});

test("dvigatel: ayirma o'chiq (boshlanish oyidan oldin) — tafsilot bo'sh, summa to'liq", () => {
  const c = computeForStaff(ali(), OCT, ctxOf({ enabled: false }));
  assert.equal(money(c.absenceAmount), "0.00");
  assert.deepEqual(c.absenceBreakdown, {});
  assert.equal(money(c.amount), "5200000.00");
});

/* ───────────────────────── Muhrlangan oylik ───────────────────────── */

const sealed = (extra = {}) => ({
  id: "e1",
  staffId: ALI,
  month: OCT,
  fixedAmount: "5200000",
  kpiAmount: "0",
  allowanceAmount: "0",
  allowanceBreakdown: [],
  absenceAmount: "0",
  absenceBreakdown: {},
  suspendedAmount: "0",
  suspensionBreakdown: [],
  deductionAmount: "0",
  deductionBreakdown: [],
  perHourRate: "0",
  amount: "5200000",
  paidAmount: "0",
  status: "unpaid",
  ...extra,
});

const sourcesOf = (absences = ALI_ABSENCES, enabled = true) => ({
  groups: [],
  studentCounts: new Map(),
  deductions: [],
  suspensions: [],
  absence: { enabled, workDays: WORK_DAYS, absences },
});

test("muhr: davomatdan kelmagan kun qo'shiladi, yalpi qismlarga tegilmaydi", () => {
  const next = recomputeSealedEntry(sealed(), sourcesOf());

  assert.equal(next.changed, true);
  assert.equal(next.structural, true);
  assert.equal(money(next.data.amount), "4800000.00");
  assert.equal(money(next.data.absenceAmount), "400000.00");
  assert.equal(next.data.absenceBreakdown.days.length, 2);
  assert.equal("fixedAmount" in next.data, false);
});

test("muhr: davomat to'g'rilansa ayirma qaytadi", () => {
  const before = recomputeSealedEntry(sealed(), sourcesOf());
  const entry = sealed({ ...before.data, amount: before.data.amount.toFixed(2) });

  const next = recomputeSealedEntry(entry, sourcesOf([{ day: "2026-10-05", status: "present" }]));
  assert.equal(money(next.data.absenceAmount), "0.00");
  assert.equal(money(next.data.amount), "5200000.00");
});

test("muhr: o'zgarish yo'q — qayta yozilmaydi", () => {
  const before = recomputeSealedEntry(sealed(), sourcesOf());
  const entry = sealed({ ...before.data, amount: before.data.amount.toFixed(2) });
  assert.equal(recomputeSealedEntry(entry, sourcesOf()).changed, false);
});

test("muhr: to'lov tushgan — yangi summa to'langanidan kam bo'lmasa yangilanadi, aks holda locked", () => {
  const partial = sealed({ paidAmount: "3000000", status: "partial" });
  const okNext = recomputeSealedEntry(partial, sourcesOf());
  assert.equal(isResyncBlocked(partial, okNext), false);
  assert.equal(okNext.data.status, "partial");

  const nearlyPaid = sealed({ paidAmount: "5000000", status: "partial" });
  const blockedNext = recomputeSealedEntry(nearlyPaid, sourcesOf());
  assert.equal(isResyncBlocked(nearlyPaid, blockedNext), true);
});

test("muhr: manba berilmasa muhrdagi ayirma saqlanadi; o'chirilsa — tozalanadi", () => {
  const withAbsence = sealed({
    absenceAmount: "400000",
    absenceBreakdown: { workDays: 26, dailyRate: "200000.00", days: [] },
    amount: "4800000",
  });

  const { absence, ...noAbsence } = sourcesOf();
  assert.equal(recomputeSealedEntry(withAbsence, noAbsence).changed, false);

  const cleared = recomputeSealedEntry(withAbsence, sourcesOf([], false));
  assert.equal(money(cleared.data.absenceAmount), "0.00");
  assert.deepEqual(cleared.data.absenceBreakdown, {});
  assert.equal(money(cleared.data.amount), "5200000.00");
});

/* ───────────────────────── Faktlar ───────────────────────── */

test("faktlar: boshlanish oyidan oldin — davomat o'qilmaydi", async () => {
  settings = { id: "singleton", absenceDeductionFromMonth: OCT };
  const facts = await loadAbsenceFacts(202609, [ALI]);
  assert.equal(facts.enabled, false);

  settings = { id: "singleton", absenceDeductionFromMonth: null };
  assert.equal((await loadAbsenceFacts(OCT, [ALI])).enabled, false);
});

test("faktlar: ish kunlari bayram va yakshanbasiz, davomat xodim bo'yicha", async () => {
  settings = { id: "singleton", absenceDeductionFromMonth: OCT };
  holidays = [{ type: "single", date: day(HOLIDAY), isActive: true }];
  attendances = [
    { userId: ALI, date: day("2026-10-05"), status: "absent" },
    { userId: ALI, date: day("2026-10-06"), status: "excused" },
    { userId: ALI, date: day("2026-10-07"), status: "late" },
    { userId: ALI, date: day("2026-09-30"), status: "absent" },
    { userId: id("b1"), date: day("2026-10-05"), status: "absent" },
  ];

  const facts = await loadAbsenceFacts(OCT, [ALI]);
  assert.equal(facts.enabled, true);
  assert.deepEqual(facts.workDays, WORK_DAYS);
  assert.deepEqual(facts.byStaff.get(ALI), [
    { day: "2026-10-05", status: "absent" },
    { day: "2026-10-06", status: "excused" },
  ]);
});

test("ko'rinish: kun yorlig'i yagona formatda, holat nomi bilan", () => {
  const { total, breakdown } = computeAbsenceDeduction("5200000", {
    workDays: WORK_DAYS,
    absences: ALI_ABSENCES,
  });
  const view = serializeAbsence(breakdown, total);

  assert.equal(view.amount, "400000.00");
  assert.equal(view.dayCount, 2);
  assert.equal(view.days[0].dateLabel, "5-oktabr, 2026");
  assert.equal(view.days[1].statusLabel, "Sababli kelmagan");
  assert.equal(serializeAbsence({}, 0), null);
});
