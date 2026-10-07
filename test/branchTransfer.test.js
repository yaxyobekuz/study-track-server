const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * FILIALLARARO KO'CHIRISH VA ASOSIY OYLIK EGASI.
 *
 * Himoya qilinadigan narsa:
 *   · o'qish davri manbada T−1 da yopiladi, T dan boshlangani o'chiriladi;
 *     ko'chish oyi bitta filialda hisoblanadi (1-kuni — maqsadda, aks holda
 *     manbada) — bir oy ikki filialda ikki marta yozilmaydi;
 *   · kesishadigan tariflardan chegarada faqat G'OLIB nusxalanadi (aks holda
 *     maqsadda `(student_id, start_month)` to'qnashardi);
 *   · asosiy oylik boshqa filialda bo'lsa dvigatel fiksa/ustama/bonusni NOL
 *     qiladi, dars soati va tyutorlik qoladi;
 *   · oy egasi: muhr → yagona filial → shartnoma qayerda → uy filiali;
 *   · reja xeshi kalit tartibiga bog'liq emas; SQL identifikatori qat'iy.
 *
 * Bazaga ulanish yo'q: platforma va filial client'lari soxta.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

// ── Soxta platforma (resolveOwners uchun) ──
const platform = {
  claims: [],
  directory: [],
  access: [],
  contracts: {}, // schemaName → Set(staffId)
};
fakeModule("../src/config/platformPrisma", {
  payrollMonthOwner: {
    findMany: async ({ where }) =>
      platform.claims.filter((c) => c.month === where.month && where.userId.in.includes(c.userId)),
  },
  userDirectory: {
    findMany: async ({ where }) => platform.directory.filter((d) => where.id.in.includes(d.id)),
  },
  userBranchAccess: {
    findMany: async ({ where }) => platform.access.filter((a) => where.userId.in.includes(a.userId)),
  },
  $queryRawUnsafe: async (sql, staffIds) => {
    const schema = /FROM "([a-z_0-9]+)"\."users"/.exec(sql)[1];
    const set = platform.contracts[schema] ?? new Set();
    return staffIds.filter((id) => set.has(id)).map((staff_id) => ({ staff_id }));
  },
  $executeRawUnsafe: async () => 0,
});
const BRANCHES = {
  A: { id: "a".repeat(24), name: "Chilonzor", schemaName: "public" },
  B: { id: "b".repeat(24), name: "Yunusobod", schemaName: "br_yunusobod" },
};
fakeModule("../src/services/branch.service", {
  findById: async (id) => Object.values(BRANCHES).find((b) => b.id === id) ?? null,
});

const { runWithBranch } = require("../src/config/branchContext");
const { resolveOwners, foreignFixedStaff } = require("../src/services/payrollOwnership.service");
const { planSourcePeriods, effectiveFrom } = require("../src/services/branchTransferStudent.service");
const { computeForStaff } = require("../src/services/payrollEngine.service");
const { quoteIdent, schemaType } = require("../src/helpers/crossSchema.helpers");
const { Decimal } = require("../src/helpers/money.helpers");
const { stableStringify, parseEffectiveDate } = require("../src/services/branchTransfer.service");
const { currentDayDate, currentMonthKey, monthStartDate, prevMonth } = require("../src/helpers/month.helpers");

const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
const period = (id, start, end = null) => ({ id, startDate: day(start), endDate: end ? day(end) : null });

// ─────────────────────────────────────────────
// O'qish davri va ko'chish oyi
// ─────────────────────────────────────────────

test("oy o'rtasida ko'chish: ochiq davr T−1 da yopiladi, ko'chish oyi MANBADA", () => {
  const plan = planSourcePeriods([period("p1", "2025-09-01")], day("2026-10-15"));
  assert.deepEqual(plan.closing.map((p) => p.id), ["p1"]);
  assert.deepEqual(plan.deleting, []);
  assert.equal(plan.kept[0].endDate.toISOString().slice(0, 10), "2026-10-14");
  assert.equal(plan.coversTransferMonth, true);
});

test("oyning 1-kuni ko'chish: manba shu oyni qamramaydi — oy MAQSADDA", () => {
  const plan = planSourcePeriods([period("p1", "2025-09-01")], day("2026-10-01"));
  assert.equal(plan.kept[0].endDate.toISOString().slice(0, 10), "2026-09-30");
  assert.equal(plan.coversTransferMonth, false);
});

test("davr ko'chish kuni yoki keyin boshlangan — manbada bir kun ham o'qimagan, o'chiriladi", () => {
  const plan = planSourcePeriods(
    [period("old", "2025-09-01", "2026-05-31"), period("new", "2026-10-07")],
    day("2026-10-07"),
  );
  assert.deepEqual(plan.deleting.map((p) => p.id), ["new"]);
  assert.deepEqual(plan.closing, []);
  // Eski davr may oyida tugagan — oktabrni qamramaydi
  assert.equal(plan.coversTransferMonth, false);
});

test("oy boshida ketgan, oy o'rtasida ko'chirildi — manba oyni baribir to'liq hisoblaydi", () => {
  const plan = planSourcePeriods([period("p1", "2025-09-01", "2026-10-05")], day("2026-10-20"));
  assert.deepEqual(plan.closing, []);
  assert.equal(plan.coversTransferMonth, true);
});

test("kelajakda tugaydigan yopiq davr ham T−1 gacha qisqaradi", () => {
  const plan = planSourcePeriods([period("p1", "2025-09-01", "2026-12-31")], day("2026-10-10"));
  assert.deepEqual(plan.closing.map((p) => p.id), ["p1"]);
  assert.equal(plan.kept[0].endDate.toISOString().slice(0, 10), "2026-10-09");
});

// ─────────────────────────────────────────────
// Kelajak qoidalari
// ─────────────────────────────────────────────

test("kesishadigan tariflar: chegarada faqat g'olib (eng kech boshlangani), keyingilari o'z holicha", () => {
  const rows = [
    { id: "t1", startMonth: 202509, endMonth: null },
    { id: "t2", startMonth: 202609, endMonth: null },
    { id: "t3", startMonth: 202701, endMonth: null },
    { id: "old", startMonth: 202501, endMonth: 202608 },
  ];
  assert.deepEqual(effectiveFrom(rows, 202611).map((r) => r.id), ["t2", "t3"]);
});

test("chegarani qamragan qator yo'q — faqat keyin boshlanadiganlar", () => {
  const rows = [{ id: "t3", startMonth: 202701, endMonth: null }];
  assert.deepEqual(effectiveFrom(rows, 202611).map((r) => r.id), ["t3"]);
});

// ─────────────────────────────────────────────
// Asosiy oylik egasi
// ─────────────────────────────────────────────

const reset = () => {
  platform.claims = [];
  platform.directory = [];
  platform.access = [];
  platform.contracts = {};
};

test("muhr bor — egasi muhrdagi filial (uy filiali o'zgargan bo'lsa ham)", async () => {
  reset();
  platform.claims = [{ userId: "s1", month: 202610, branchId: BRANCHES.A.id }];
  platform.directory = [{ id: "s1", branchId: BRANCHES.B.id }];
  platform.access = [{ userId: "s1", branchId: BRANCHES.B.id }];
  const owners = await resolveOwners(202610, ["s1"]);
  assert.deepEqual(owners.get("s1"), { branchId: BRANCHES.A.id, pinned: true });
});

test("bitta filial — o'sha filial; filialiga kirishi yo'q qoldiqda asosiy oylik hisoblanmaydi", async () => {
  reset();
  platform.directory = [{ id: "s1", branchId: BRANCHES.B.id }];
  platform.access = [{ userId: "s1", branchId: BRANCHES.B.id }];
  const foreign = await runWithBranch(BRANCHES.A, () => foreignFixedStaff(202611, ["s1"]));
  assert.equal(foreign.get("s1").branchId, BRANCHES.B.id);
  const own = await runWithBranch(BRANCHES.B, () => foreignFixedStaff(202611, ["s1"]));
  assert.equal(own.has("s1"), false);
});

test("ko'p filial: shartnoma faqat uy BO'LMAGAN filialda — o'sha filial ega (eski ma'lumot nolga tushmaydi)", async () => {
  reset();
  platform.directory = [{ id: "s1", branchId: BRANCHES.A.id }];
  platform.access = [
    { userId: "s1", branchId: BRANCHES.A.id },
    { userId: "s1", branchId: BRANCHES.B.id },
  ];
  platform.contracts = { br_yunusobod: new Set(["s1"]) };
  const owners = await resolveOwners(202610, ["s1"]);
  assert.equal(owners.get("s1").branchId, BRANCHES.B.id);
});

test("ko'p filial: ikkalasida shartnoma bor yoki hech qayerda yo'q — UY filiali", async () => {
  reset();
  platform.directory = [{ id: "s1", branchId: BRANCHES.A.id }, { id: "s2", branchId: BRANCHES.A.id }];
  platform.access = [
    { userId: "s1", branchId: BRANCHES.A.id },
    { userId: "s1", branchId: BRANCHES.B.id },
    { userId: "s2", branchId: BRANCHES.A.id },
    { userId: "s2", branchId: BRANCHES.B.id },
  ];
  platform.contracts = { public: new Set(["s1"]), br_yunusobod: new Set(["s1"]) };
  const owners = await resolveOwners(202610, ["s1", "s2"]);
  assert.equal(owners.get("s1").branchId, BRANCHES.A.id);
  assert.equal(owners.get("s2").branchId, BRANCHES.A.id);
});

test("platformada yozuvi yo'q (filiallashtirishdan oldingi) xodim — joriy filialniki", async () => {
  reset();
  const foreign = await runWithBranch(BRANCHES.A, () => foreignFixedStaff(202610, ["legacy"]));
  assert.equal(foreign.size, 0);
});

// ─────────────────────────────────────────────
// Dvigatel: asosiy oylik boshqa filialda
// ─────────────────────────────────────────────

const engineCtx = (foreign) => ({
  positionMap: new Map([["pos", { id: "pos", baseSalary: "5000000", name: "Direktor o'rinbosari" }]]),
  categoryMap: new Map([["cat", { id: "cat", perHourRate: "50000", name: "Oliy" }]]),
  salaryRules: new Map([["s1", { fixedAmount: "1000000", perHourRate: 0, allowances: [{ label: "Ustama", type: "fixed", value: 300000 }] }]]),
  hoursMap: new Map([["s1", { hours: 10 }]]),
  bonusMap: new Map([["s1", [{ id: "b1", label: "Bonus", type: "fixed", value: "200000" }]]]),
  deductionMap: new Map(),
  customBaseMap: new Map(),
  tutorGroupMap: new Map([["s1", [{ id: "g1", classId: "c1", perStudentAmount: "10000", groupAmount: "100000", class: { name: "5-A" } }]]]),
  classStudentCounts: new Map([["c1", 20]]),
  suspensions: [],
  absence: { enabled: true, workDays: [], rateDayCount: 26, byStaff: new Map([["s1", [{ day: 1, status: "absent" }]]]) },
  foreignFixed: foreign,
});
const staff = { id: "s1", positionId: "pos", salaryCategoryId: "cat" };

test("ega filialda: fiksa + soat + ustama + bonus + tyutor — hammasi", () => {
  const c = computeForStaff(staff, 202610, engineCtx(new Map()));
  assert.equal(c.fixedOwner, null);
  assert.ok(new Decimal(c.fixedAmount).equals(6000000));
  assert.ok(new Decimal(c.kpiAmount).equals(500000));
  assert.ok(new Decimal(c.allowanceAmount).equals(300000 + 200000 + 100000 + 200000));
});

test("boshqa filial ega: fiksa, ustama, bonus va kelmagan kun ayirmasi NOL; dars soati va tyutor QOLADI", () => {
  const owner = { branchId: "x".repeat(24), branchName: "Chilonzor" };
  const c = computeForStaff(staff, 202610, engineCtx(new Map([["s1", owner]])));
  assert.deepEqual(c.fixedOwner, owner);
  assert.ok(new Decimal(c.fixedAmount).equals(0));
  assert.ok(new Decimal(c.baseAmount).equals(0));
  assert.equal(c.baseIsCustom, false);
  assert.ok(new Decimal(c.absenceAmount).equals(0));
  assert.ok(new Decimal(c.kpiAmount).equals(500000));
  // faqat tyutor qatori: 100 000 + 10 000 × 20
  assert.ok(new Decimal(c.allowanceAmount).equals(300000));
  assert.deepEqual(c.allowanceBreakdown.map((l) => l.type), ["tutor"]);
  assert.ok(new Decimal(c.amount).equals(800000));
});

// ─────────────────────────────────────────────
// Kirish ma'lumoti va SQL qavati
// ─────────────────────────────────────────────

test("reja xeshi kalit tartibiga bog'liq emas", () => {
  assert.equal(stableStringify({ b: 1, a: [{ y: 2, x: 1 }] }), stableStringify({ a: [{ x: 1, y: 2 }], b: 1 }));
});

test("ko'chish sanasi: bugun bo'ladi; kelajak va o'tgan oy rad etiladi", () => {
  const today = currentDayDate();
  assert.equal(parseEffectiveDate(undefined).getTime(), today.getTime());
  const iso = (d) => d.toISOString().slice(0, 10);
  const tomorrow = new Date(today.getTime() + 86400000);
  assert.throws(() => parseEffectiveDate(iso(tomorrow)), /bugundan keyin/);
  const lastMonth = monthStartDate(prevMonth(currentMonthKey()));
  assert.throws(() => parseEffectiveDate(iso(lastMonth)), /joriy oy/);
});

test("SQL identifikatori qat'iy — inyeksiya imkonsiz", () => {
  assert.equal(quoteIdent("student_tariffs"), '"student_tariffs"');
  assert.throws(() => quoteIdent('users"; DROP TABLE users; --'));
  assert.throws(() => quoteIdent("Users"));
  assert.equal(schemaType("br_x", "Gender"), '"br_x"."Gender"');
  assert.throws(() => schemaType("br_x", 'Gender"; --'));
  assert.throws(() => schemaType("Br-X", "Gender"));
});
