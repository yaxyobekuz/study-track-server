const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * OYLIK QANDAY HISOBLANDI — xodimning bitta oyi (`payrollBreakdown.service`).
 *
 * Himoya qilinadigan narsa:
 *   · zanjir: fiksa + soat × narx + ustamalar − kelmagan kunlar − to'xtatilgan
 *     − ushlab qolingan = oylik (`financeReconcile` invarianti 6);
 *   · o'tilmagan darslar KUNLAR kesimida: kun summasi = soat × dars narxi;
 *   · foizli ustama ta'siri yashirilmaydi (dvigatel farqi, `otherAmount`);
 *   · muhrlangan oy MUHRDAN o'qiladi, jonli soat farq qilsa — `hoursDrift`,
 *     summa muhrdagidek, taxminiy "reja" esa berilmaydi;
 *   · fiksa xodimda kelmagan kunlar kun bo'yicha, dars soati umuman o'qilmaydi;
 *   · "nega kam" — kelmagan kun, o'tilmagan va o'rinbosarga berilgan darslar
 *     BITTA xronologik ro'yxatda, jami har bir qator yig'indisiga teng;
 *     ayirma bo'lmasa ro'yxat bo'sh (panel "hech narsa ayrilmagan" deydi);
 *   · kelgusi oy rad etiladi.
 *
 * Servis, payroll dvigateli va kelmagan kun formulasi HAQIQIY kodi ishlaydi;
 * baza xotiradagi soxta, dars soati esa tayyor oy kesimi bilan almashtiriladi.
 */

const { Decimal } = require("../src/helpers/money.helpers");

/* ───────────────────────── Soxta muhit ───────────────────────── */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const id = (prefix) => prefix.padEnd(24, "0");
const TEACHER = id("t1");
const CLERK = id("w1");
const CAT = id("c1");
const POS = id("p1");

// Sentabr, 2026: 30 kun, yakshanbalar 6/13/20/27 → 26 ish kuni (bayramsiz)
const SEP = 202609;

let db;
let hoursCalls;
let monthHours;
let holidayKeys;

const resetDb = () => {
  hoursCalls = 0;
  holidayKeys = [];
  db = {
    settings: { id: "singleton", absenceDeductionFromMonth: 202601 },
    users: [
      { id: TEACHER, firstName: "Nodira", lastName: "Karimova", username: "nodira", role: "teacher", isArchived: false, positionId: null, salaryCategoryId: CAT },
      { id: CLERK, firstName: "Ali", lastName: "Valiyev", username: "ali", role: "worker", isArchived: false, positionId: POS, salaryCategoryId: null },
    ],
    categories: [
      { id: CAT, name: "Oliy toifa", perHourRate: new Decimal(50_000), department: { name: "Yuqori sinflar" } },
    ],
    positions: [
      { id: POS, name: "Kotiba", baseSalary: new Decimal(2_600_000), department: { name: "Boshqaruv" } },
    ],
    bonuses: [],
    deductions: [],
    entries: [],
    attendances: [],
    substitutions: [],
  };
  monthHours = regularMonth();
};

const lesson = (date, order, reason, extra = {}) => ({
  date: new Date(`${date}T00:00:00Z`),
  dateLabel: `${Number(date.slice(8))}-sentabr, 2026`,
  classId: "cls",
  className: "7-A",
  subjectId: "math",
  subjectName: "Matematika",
  lessonOrder: order,
  reason,
  reasonLabel: { absent: "Kelmagan", excused: "Sababli kelmagan", noGrade: "Baho qo'yilmagan" }[reason],
  autoMarked: false,
  substituted: false,
  ...extra,
});

// 3 ta o'tilmagan dars: 8-sentabr kelmagan (2 dars, tartibi aralash), 15-sentabr baho yo'q
const regularMonth = () => ({
  hours: 20,
  taughtHours: 20,
  remainingHours: 0,
  missedHours: 3,
  missedByReason: { absent: 2, excused: 0, noGrade: 1 },
  missedLessons: [
    lesson("2026-09-15", 1, "noGrade"),
    lesson("2026-09-08", 3, "absent", { autoMarked: true }),
    lesson("2026-09-08", 1, "absent"),
  ],
  scheduledHours: 23,
  substitutedOutHours: 0,
  substitutedInHours: 0,
  substitutedOutLessons: [],
  weeklyHours: 6,
  teachingDays: 26,
  isVacationMonth: false,
});

const inRange = (value, cond) =>
  (cond.gte == null || value >= cond.gte) && (cond.lte == null || value <= cond.lte);

const prisma = {
  financeSettings: { upsert: async () => db.settings },
  holiday: { findMany: async () => [] },
  attendance: {
    findMany: async ({ where }) =>
      db.attendances.filter(
        (row) =>
          where.userId.in.includes(row.userId) &&
          inRange(row.date, where.date) &&
          where.status.in.includes(row.status),
      ),
  },
  user: {
    findUnique: async ({ where }) => db.users.find((u) => u.id === where.id) ?? null,
    findMany: async () => [],
  },
  position: {
    findMany: async ({ where }) => db.positions.filter((p) => where.id.in.includes(p.id)),
  },
  salaryCategory: {
    findMany: async ({ where }) => db.categories.filter((c) => where.id.in.includes(c.id)),
  },
  payrollBonus: {
    findMany: async ({ where }) => db.bonuses.filter((b) => where.staffId.in.includes(b.staffId)),
  },
  payrollDeduction: {
    findMany: async ({ where }) =>
      db.deductions.filter((d) =>
        where.staffId ? where.staffId.in.includes(d.staffId) : where.id.in.includes(d.id),
      ),
  },
  payrollEntry: {
    findFirst: async ({ where }) =>
      db.entries.find(
        (e) => e.staffId === where.staffId && e.month === where.month && e.status !== "cancelled",
      ) ?? null,
  },
  tutorGroup: { findMany: async () => [] },
  lessonSubstitution: {
    findMany: async ({ where }) => db.substitutions.filter((row) => where.id.in.includes(row.id)),
  },
  payrollSuspension: { findMany: async () => [] },
  userClass: { groupBy: async () => [] },
};

fakeModule("../src/config/prisma", prisma);
fakeModule("../src/config/platformPrisma", { role: { findMany: async () => [] } });
fakeModule("../src/services/lessonHours.service", {
  getTeacherHours: async () => {
    hoursCalls += 1;
    return monthHours;
  },
  getTeachersHours: async (ids) => new Map(ids.map((i) => [i, monthHours])),
  cutoffForMonth: () => null,
  getMonthCalendar: async () => ({ holidaySet: new Set(holidayKeys), isVacationMonth: false }),
  computeLessonHoursForMonth: async () => new Map(),
  computeLessonHoursForStaff: async () => ({ hours: 0 }),
});
fakeModule("../src/services/staffSalary.service", {
  resolveSalariesForMonth: async () => new Map(db.rules ?? []),
  TYPE_LABELS: { fixed: "Fiksa", kpi: "KPI (dars soati)", mixed: "Fiksa + KPI" },
  STAFF_SELECT: { id: true },
});

const { getMonthBreakdown } = require("../src/services/payrollBreakdown.service");

const money = (value) => new Decimal(value).toFixed(2);

/** amount = fixed + kpi + allowance − absence − suspended − deduction */
const assertChain = (data) => {
  const chain = new Decimal(data.fixedAmount)
    .plus(data.kpiAmount)
    .plus(data.allowanceAmount)
    .minus(data.absenceAmount)
    .minus(data.suspendedAmount)
    .minus(data.deductionAmount);
  assert.equal(chain.toFixed(2), data.amount);
  assert.equal(
    new Decimal(data.fixedAmount).plus(data.kpiAmount).plus(data.allowanceAmount).toFixed(2),
    data.grossAmount,
  );
};

/* ───────────────────────── Testlar ───────────────────────── */

test("soatbay (jonli): o'tilmagan darslar kun bo'yicha, kun summasi = soat × narx", async () => {
  resetDb();

  const data = await getMonthBreakdown(TEACHER, SEP);

  assert.equal(data.isSealed, false);
  assert.equal(data.hasSalary, true);
  assert.equal(data.kpiAmount, money(1_000_000)); // 20 soat × 50 000
  assert.equal(data.amount, money(1_000_000));
  assertChain(data);

  const missed = data.missedLessons;
  assert.equal(missed.hours, 3);
  assert.equal(missed.perHourRate, money(50_000));
  assert.equal(missed.lessonsAmount, money(150_000));
  assert.equal(missed.amount, money(150_000));
  assert.equal(missed.otherAmount, money(0));
  assert.equal(missed.plannedAmount, money(1_150_000));

  // Kunlar sana bo'yicha, kun ichida darslar tartib bo'yicha
  assert.deepEqual(
    missed.days.map((d) => [d.date, d.hours, d.amount, d.lessons.map((l) => l.lessonOrder)]),
    [
      ["2026-09-08", 2, money(100_000), [1, 3]],
      ["2026-09-15", 1, money(50_000), [1]],
    ],
  );
  assert.equal(missed.days[0].lessons[1].autoMarked, true);
  assert.equal(missed.days[0].lessons[0].reasonLabel, "Kelmagan");

  // Kun summalari jami bilan teng
  assert.equal(
    missed.days.reduce((sum, d) => sum.plus(d.amount), new Decimal(0)).toFixed(2),
    missed.lessonsAmount,
  );

  assert.equal(data.work.paysByHours, true);
  assert.equal(data.work.plannedHours, 23);
  assert.equal(data.work.paidHours, 20);
  assert.equal(data.payment, null);
});

test("foizli ustama: o'tilmagan dars uni ham kamaytiradi — farq alohida ko'rsatiladi", async () => {
  resetDb();
  db.bonuses = [
    { id: "b1", staffId: TEACHER, label: "Sertifikat", type: "percent", value: new Decimal(10) },
  ];

  const data = await getMonthBreakdown(TEACHER, SEP);

  // Yalpi: 1 000 000 + 10% = 1 100 000; reja: 1 150 000 + 10% = 1 265 000
  assert.equal(data.allowanceAmount, money(100_000));
  assert.equal(data.amount, money(1_100_000));
  assertChain(data);
  assert.equal(data.missedLessons.lessonsAmount, money(150_000));
  assert.equal(data.missedLessons.amount, money(165_000));
  assert.equal(data.missedLessons.otherAmount, money(15_000));
  assert.equal(data.missedLessons.plannedAmount, money(1_265_000));
});

test("muhrlangan oy: zanjir MUHRDAN, to'lovlar va qoldiq bilan", async () => {
  resetDb();
  db.entries = [
    {
      id: "e1",
      staffId: TEACHER,
      month: SEP,
      status: "partial",
      salaryType: "kpi",
      amount: new Decimal(1_000_000),
      paidAmount: new Decimal(400_000),
      fixedAmount: new Decimal(0),
      kpiAmount: new Decimal(1_000_000),
      lessonHours: new Decimal(20),
      perHourRate: new Decimal(50_000),
      allowanceAmount: new Decimal(0),
      allowanceBreakdown: [],
      absenceAmount: new Decimal(0),
      absenceBreakdown: {},
      suspendedAmount: new Decimal(0),
      suspensionBreakdown: [],
      deductionAmount: new Decimal(0),
      deductionBreakdown: [],
      categoryName: "Oliy toifa",
      positionName: "",
      allocations: [
        { id: "a1", amount: new Decimal(400_000), appliedAt: new Date("2026-10-05T07:00:00Z"), payment: { paidAt: new Date("2026-10-05T07:00:00Z") } },
      ],
    },
  ];

  const data = await getMonthBreakdown(TEACHER, SEP);

  assert.equal(data.isSealed, true);
  assertChain(data);
  assert.equal(data.payment.paidAmount, money(400_000));
  assert.equal(data.payment.debt, money(600_000));
  assert.equal(data.payment.statusLabel, "Qisman to'langan");
  assert.equal(data.payment.payments[0].paidAtLabel, "5-oktabr, 2026");
  assert.equal(data.hoursDrift, null);
  // Jonli raqam muhrga mos — dvigatel farqi va reja beriladi
  assert.equal(data.missedLessons.amount, money(150_000));
  assert.equal(data.missedLessons.plannedAmount, money(1_150_000));
});

test("muhrdan keyin soat o'zgargan: farq aytiladi, summa muhrdagidek, reja berilmaydi", async () => {
  resetDb();
  db.entries = [
    {
      id: "e1",
      staffId: TEACHER,
      month: SEP,
      status: "paid",
      salaryType: "kpi",
      amount: new Decimal(1_100_000),
      paidAmount: new Decimal(1_100_000),
      fixedAmount: new Decimal(0),
      kpiAmount: new Decimal(1_100_000),
      lessonHours: new Decimal(22),
      perHourRate: new Decimal(50_000),
      allowanceAmount: new Decimal(0),
      allowanceBreakdown: [],
      absenceAmount: new Decimal(0),
      absenceBreakdown: {},
      suspendedAmount: new Decimal(0),
      suspensionBreakdown: [],
      deductionAmount: new Decimal(0),
      deductionBreakdown: [],
      categoryName: "Oliy toifa",
      positionName: "",
      allocations: [],
    },
  ];

  const data = await getMonthBreakdown(TEACHER, SEP);

  assert.equal(data.amount, money(1_100_000));
  assert.equal(data.work.paidHours, 22);
  assert.deepEqual(data.hoursDrift, { sealedHours: 22, liveHours: 20 });
  assert.equal(data.missedLessons.amount, money(150_000)); // faqat soat × narx
  assert.equal(data.missedLessons.plannedAmount, null);
  assert.equal(data.payment.debt, money(0));
});

test("fiksa xodim: kelmagan kunlar kun bo'yicha, dars soati umuman o'qilmaydi", async () => {
  resetDb();
  db.attendances = [
    { userId: CLERK, date: new Date("2026-09-08T00:00:00Z"), status: "absent" },
    { userId: CLERK, date: new Date("2026-09-09T00:00:00Z"), status: "excused" },
    { userId: CLERK, date: new Date("2026-09-10T00:00:00Z"), status: "late" },
  ];
  db.deductions = [
    { id: id("d1"), staffId: CLERK, reason: "Jarima", note: "Kechikish", type: "fixed", value: new Decimal(50_000), createdAt: new Date() },
  ];

  const data = await getMonthBreakdown(CLERK, SEP);

  assert.equal(hoursCalls, 0);
  assert.equal(data.missedLessons, null);
  assert.equal(data.work.paysByHours, false);
  assert.equal(data.work.workDays, 26);
  assert.equal(data.work.dailyRate, money(100_000)); // 2 600 000 ÷ 26
  assert.equal(data.work.absentDays, 2);
  assert.deepEqual(
    data.absence.days.map((d) => [d.date, d.status, d.amount]),
    [
      ["2026-09-08", "absent", money(100_000)],
      ["2026-09-09", "excused", money(100_000)],
    ],
  );
  assert.equal(data.absenceAmount, money(200_000));
  assert.equal(data.deductions[0].reason, "Jarima");
  assert.equal(data.deductions[0].note, "Kechikish");
  assert.equal(data.amount, money(2_350_000));
  assertChain(data);
});

test("ayirma o'chiq oy: ish kunlari baribir aytiladi, kunlik summa — yo'q", async () => {
  resetDb();
  db.settings = { id: "singleton", absenceDeductionFromMonth: null };

  const data = await getMonthBreakdown(CLERK, SEP);

  assert.equal(data.absence, null);
  assert.equal(data.work.workDays, 26);
  assert.equal(data.work.dailyRate, null);
  assert.equal(data.amount, money(2_600_000));
});

test("sof soatbay xodim kelmasa: kelmagan kun '0 so'm' bo'lib chiqmaydi — u o'tilmagan darslarda", async () => {
  resetDb();
  db.attendances = [
    { userId: TEACHER, date: new Date("2026-09-08T00:00:00Z"), status: "absent" },
  ];

  const data = await getMonthBreakdown(TEACHER, SEP);

  assert.equal(data.fixedAmount, money(0));
  assert.equal(data.absence, null);
  assert.equal(data.work.workDays, null);
  assert.equal(data.work.dailyRate, null);
  assert.equal(data.absenceAmount, money(0));
  assert.equal(data.missedLessons.days[0].lessons[0].reason, "absent");
  assertChain(data);
});

test("nega kam: kelmagan kun, o'tilmagan va o'rinbosarga berilgan darslar bitta ro'yxatda", async () => {
  resetDb();
  // Aralash oylik: fiksa 2 600 000 (26 ish kuni → kuniga 100 000) + soat
  db.rules = [[TEACHER, { fixedAmount: new Decimal(2_600_000), perHourRate: new Decimal(0), allowances: [] }]];
  db.attendances = [
    { userId: TEACHER, date: new Date("2026-09-08T00:00:00Z"), status: "absent" },
  ];
  db.substitutions = [
    { id: "s1", reason: "illness", teacherSnapshot: { substitute: { name: "Aziz Rahimov" } } },
  ];
  monthHours = {
    ...regularMonth(),
    scheduledHours: 25,
    substitutedOutHours: 2,
    substitutedOutLessons: [
      { date: new Date("2026-09-22T00:00:00Z"), dateLabel: "22-sentabr, 2026", className: "8-B", subjectName: "Fizika", lessonOrder: 4, substitutionId: "s1" },
      { date: new Date("2026-09-08T00:00:00Z"), dateLabel: "8-sentabr, 2026", className: "8-B", subjectName: "Fizika", lessonOrder: 5, substitutionId: "s1" },
    ],
  };
  holidayKeys = ["2026-09-01", "2026-09-06", "2026-10-01"]; // 6-sentabr — yakshanba, 1-oktabr — boshqa oy
  db.deductions = [
    { id: id("d1"), staffId: TEACHER, reason: "Jarima", note: "", type: "fixed", value: new Decimal(30_000), createdAt: new Date() },
  ];

  const data = await getMonthBreakdown(TEACHER, SEP);

  assert.equal(data.salaryType, "mixed");
  assertChain(data);
  assert.equal(data.substitutedOut.hours, 2);
  assert.equal(data.substitutedOut.amount, money(100_000));
  assert.equal(data.substitutedOut.days[1].lessons[0].substituteName, "Aziz Rahimov");
  assert.equal(data.substitutedOut.days[1].lessons[0].reasonLabel, "Kasallik");

  // 8-sentabr: fiksadan kun + 2 o'tilmagan dars + 1 berilgan dars, tartib bilan
  const sep8 = data.reasons.days.find((d) => d.date === "2026-09-08");
  assert.deepEqual(sep8.items.map((i) => [i.kind, i.amount]), [
    ["absence", money(100_000)],
    ["missed", money(100_000)],
    ["substituted", money(50_000)],
  ]);
  assert.equal(sep8.amount, money(250_000));
  assert.deepEqual(data.reasons.days.map((d) => d.date), ["2026-09-08", "2026-09-15", "2026-09-22"]);

  // Jami = kunlar + ushlab qolish (foizli ustama yo'q — ta'sir 0)
  // 250 000 + 50 000 + 50 000 + 30 000
  assert.equal(data.reasons.total, money(380_000));

  // Bayram — faqat shu oyning yakshanba bo'lmagan kuni
  assert.deepEqual(data.reasons.holidays.map((h) => h.date), ["2026-09-01"]);
  assert.equal(data.work.scheduledHours, 25);
  assert.equal(data.work.substitutedOutHours, 2);
});

test("ayirma yo'q oy: sabablar ro'yxati bo'sh, jami 0", async () => {
  resetDb();
  monthHours = { ...regularMonth(), missedHours: 0, missedLessons: [], missedByReason: { absent: 0, excused: 0, noGrade: 0 } };

  const data = await getMonthBreakdown(TEACHER, SEP);

  assert.deepEqual(data.reasons.days, []);
  assert.equal(data.reasons.total, money(0));
  assert.equal(data.missedLessons, null);
  assert.equal(data.substitutedOut, null);
});

test("oyligi yo'q xodim — hasSalary: false, zanjirsiz", async () => {
  resetDb();
  db.users.push({ id: id("x1"), firstName: "X", lastName: "", username: "x", role: "worker", isArchived: false, positionId: null, salaryCategoryId: null });

  const data = await getMonthBreakdown(id("x1"), SEP);

  assert.equal(data.hasSalary, false);
  assert.equal(data.amount, undefined);
});

test("kelgusi oy rad etiladi", async () => {
  resetDb();
  await assert.rejects(() => getMonthBreakdown(TEACHER, 209912), /Kelgusi oy/);
});
