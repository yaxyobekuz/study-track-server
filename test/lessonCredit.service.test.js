const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * "O'TILDI" BELGISI — `lessonCredit.service` haqiqiy kodi; baza xotirada,
 * soat hisobi va oylik dvigateli soxta.
 *
 * Eng muhim qoidalar: faqat o'tgan kun; server ro'yxatni O'ZI qayta oladi
 * (o'tilmagan bo'lmagan dars belgilanmaydi); bitta darsga bitta faol belgi;
 * "Baho qo'ymaslik" jarimasi ixtiyoriy bekor qilinadi va belgi bekor
 * qilinganda AYNAN qaytadi; yopilgan oyning muhrlangan oyligi aytiladi.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const { currentDayDate, monthKeyOfDate, currentMonthKey } = require("../src/helpers/month.helpers");
const { dayKey } = require("../src/helpers/lessonHours");
const { gradePenaltyTitle } = require("../src/helpers/gradePenalty.helpers");
const { Decimal } = require("../src/helpers/money.helpers");

const DAY = 24 * 3600 * 1000;
const TODAY = currentDayDate();

/** Bugundan oldingi eng yaqin yakshanba bo'lmagan kun (n kun orqaga, kamida). */
const pastWeekday = (n) => {
  let date = new Date(TODAY.getTime() - n * DAY);
  while (date.getUTCDay() === 0) date = new Date(date.getTime() - DAY);
  return date;
};

const T1 = "a".repeat(24);
const T2 = "b".repeat(24);
const ARCH = "d".repeat(24);
const OWNER = "e".repeat(24);
const C1 = "1".repeat(24);
const S1 = "2".repeat(24);
const S2 = "3".repeat(24);

const USERS = [
  { id: T1, firstName: "Dildora", lastName: "Nurmatova", role: "teacher", isArchived: false, penaltyPoints: 3 },
  { id: T2, firstName: "Sardor", lastName: "Karimov", role: "teacher", isArchived: false, penaltyPoints: 0 },
  { id: ARCH, firstName: "Eski", lastName: "Xodim", role: "teacher", isArchived: true, penaltyPoints: 0 },
  { id: OWNER, firstName: "Bosh", lastName: "Direktor", role: "owner", isArchived: false, penaltyPoints: 0 },
];

let db;
let missed; // teacherId → missedLessons (soxta soat hisobi)
let seq = 0;
const nextId = () => String(++seq).padStart(24, "f");

let resynced;
const resetDb = () => {
  db = { credits: [], penalties: [], audits: [], entries: [], attendance: [] };
  resynced = [];
  missed = new Map();
  for (const user of USERS) user.penaltyPoints = user.id === T1 ? 3 : 0;
};

/* ── `where` ning shu servis ishlatadigan qismi ── */
const cmp = (value, cond) => {
  if (cond === undefined) return true;
  if (cond === null) return value == null;
  if (cond instanceof Date) return value?.getTime() === cond.getTime();
  if (typeof cond !== "object") return value === cond;
  if ("not" in cond) return cond.not === null ? value != null : value !== cond.not;
  if ("in" in cond) return cond.in.includes(value);
  const v = value instanceof Date ? value.getTime() : value;
  const n = (x) => (x instanceof Date ? x.getTime() : x);
  return (
    (cond.gt === undefined || Number(v) > Number(n(cond.gt))) &&
    (cond.gte === undefined || v >= n(cond.gte)) &&
    (cond.lt === undefined || v < n(cond.lt)) &&
    (cond.lte === undefined || v <= n(cond.lte))
  );
};
const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) =>
    key === "OR" ? cond.some((c) => matches(row, c)) : cmp(row[key], cond),
  );

const prisma = {
  user: {
    findMany: async ({ where }) => USERS.filter((u) => matches(u, where)),
    findUnique: async ({ where }) => USERS.find((u) => u.id === where.id) ?? null,
    update: async ({ where, data }) => {
      const user = USERS.find((u) => u.id === where.id);
      if (data.penaltyPoints?.increment) user.penaltyPoints += data.penaltyPoints.increment;
      if (data.penaltyPoints?.decrement) user.penaltyPoints -= data.penaltyPoints.decrement;
      return user;
    },
  },
  // Kun o'qituvchilari: darsi bor hamma (hafta kuni soxta hisobda hal bo'ladi)
  scheduleLesson: {
    findMany: async ({ where }) =>
      [T1, T2, ARCH]
        .filter((id) => !where.teacherId || where.teacherId.in.includes(id))
        .map((teacherId) => ({ teacherId })),
  },
  lessonSubstitution: { findMany: async () => [] },
  class: { findMany: async () => [{ id: C1, name: "5-A" }] },
  lessonCredit: {
    findMany: async ({ where, skip = 0, take }) =>
      db.credits.filter((c) => matches(c, where)).slice(skip, take == null ? undefined : skip + take),
    count: async ({ where }) => db.credits.filter((c) => matches(c, where)).length,
    createMany: async ({ data, skipDuplicates }) => {
      let count = 0;
      for (const row of data) {
        const dup = db.credits.some((c) => c.activeKey != null && c.activeKey === row.activeKey);
        if (dup) {
          if (skipDuplicates) continue;
          throw new Error("unique");
        }
        db.credits.push({
          id: nextId(),
          penaltyId: null,
          penaltyPoints: 0,
          revokedAt: null,
          revokedBy: null,
          revokeReason: "",
          createdAt: new Date(),
          ...row,
        });
        count += 1;
      }
      return { count };
    },
    findFirst: async ({ where }) =>
      db.credits
        .filter((c) => matches(c, where))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0] ?? null,
    update: async ({ where, data }) => {
      const row = db.credits.find((c) => c.id === where.id);
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }) => {
      const rows = db.credits.filter((c) => matches(c, where));
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    },
  },
  attendance: {
    findUnique: async ({ where }) =>
      db.attendance.find(
        (a) => a.userId === where.userId_date.userId && a.date.getTime() === where.userId_date.date.getTime(),
      ) ?? null,
    create: async ({ data }) => {
      const row = { id: nextId(), checkIn: null, checkOut: null, penaltyApplied: false, penaltyRef: null, absenceReason: null, updatedAt: new Date(), ...data };
      db.attendance.push(row);
      return row;
    },
    updateMany: async ({ where, data }) => {
      const rows = db.attendance.filter((a) => matches(a, where));
      rows.forEach((row) => Object.assign(row, data, { updatedAt: new Date(Date.now() + 1) }));
      return { count: rows.length };
    },
    deleteMany: async ({ where }) => {
      const before = db.attendance.length;
      db.attendance = db.attendance.filter((a) => !matches(a, where));
      return { count: before - db.attendance.length };
    },
  },
  penalty: {
    findUnique: async ({ where }) => db.penalties.find((p) => p.id === where.id) ?? null,
    findMany: async ({ where }) => db.penalties.filter((p) => matches(p, where)),
    updateMany: async ({ where, data }) => {
      const rows = db.penalties.filter((p) => matches(p, where));
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    },
  },
  payrollEntry: {
    findMany: async ({ where }) => db.entries.filter((e) => matches(e, where)),
  },
  $transaction: async (fn) => fn(prisma),
};

fakeModule("../src/config/prisma", prisma);
fakeModule("../src/services/lessonHours.service", {
  getTeachersHours: async (ids) =>
    new Map(ids.map((id) => [id, { hours: 10, missedLessons: missed.get(id) ?? [] }])),
});
fakeModule("../src/services/payrollEngine.service", {
  loadContext: async () => ({}),
  toEngineHours: (info, hours) => ({ hours }),
  computeForStaff: (user) =>
    user.id === T1 ? { perHourRate: new Decimal("50000") } : { perHourRate: new Decimal(0) },
});
fakeModule("../src/services/staffSalary.service", { resolveSalariesForMonth: async () => new Map() });
fakeModule("../src/services/payroll.service", {
  PAYROLL_USER_SELECT: { id: true },
  STATUS_LABELS: { unpaid: "To'lanmagan", paid: "To'langan" },
});
fakeModule("../src/services/payrollAbsence.service", {
  resyncAfterAttendanceChange: (ids, date) => {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    if (list.length) resynced.push({ ids: list, day: dayKey(date) });
  },
});
fakeModule("../src/services/payrollAudit.service", {
  record: async (entry) => db.audits.push(entry),
});

const service = require("../src/services/lessonCredit.service");

/** O'tilmagan dars (soat hisobi shakli). */
const lesson = (date, lessonOrder, extra = {}) => ({
  date,
  dateLabel: "x",
  classId: C1,
  className: "5-A",
  subjectId: S1,
  subjectName: "Matematika",
  lessonOrder,
  reason: "noGrade",
  reasonLabel: "Baho qo'yilmagan",
  autoMarked: false,
  substituted: false,
  ...extra,
});

const DAY_A = pastWeekday(2);
const KEY_A = dayKey(DAY_A);

test.beforeEach(resetDb);

/* ─────────────────────── Tekshiruvlar ─────────────────────── */

test("faqat o'tgan kun: bugun va kelajak rad etiladi", async () => {
  await assert.rejects(
    service.createCredits({ date: dayKey(TODAY), mode: "day", reason: "x" }, OWNER),
    /o'tgan kun/,
  );
  await assert.rejects(
    service.getDay({ date: dayKey(new Date(TODAY.getTime() + DAY)) }),
    /o'tgan kun/,
  );
  await assert.rejects(service.getDay({ date: "2026-02-30" }), /mavjud emas/);
  await assert.rejects(service.getDay({ date: "05.10.2026" }), /noto'g'ri formatda/);
});

test("sabab majburiy, rejim va darslar tekshiriladi", async () => {
  await assert.rejects(service.createCredits({ date: KEY_A, mode: "day", reason: "  " }, OWNER), /majburiy/);
  await assert.rejects(service.createCredits({ date: KEY_A, mode: "x", reason: "a" }, OWNER), /tanlang/);
  await assert.rejects(
    service.createCredits({ date: KEY_A, mode: "lessons", lessons: [], reason: "a" }, OWNER),
    /Kamida bitta/,
  );
  await assert.rejects(
    service.createCredits(
      { date: KEY_A, mode: "lessons", lessons: [{ teacherId: "x", classId: C1, subjectId: S1, lessonOrder: 1 }], reason: "a" },
      OWNER,
    ),
    /noto'g'ri/,
  );
  await assert.rejects(
    service.createCredits(
      { date: KEY_A, mode: "lessons", lessons: [{ teacherId: T1, classId: C1, subjectId: S1, lessonOrder: 0 }], reason: "a" },
      OWNER,
    ),
    /tartib/,
  );
  await assert.rejects(
    service.createCredits({ date: KEY_A, mode: "day", reason: "a".repeat(201) }, OWNER),
    /200/,
  );
});

/* ─────────────────────── Kun ekrani ─────────────────────── */

test("kun ekrani: faqat shu kunning o'tilmagan darslari, soat narxi va arxivlangansiz", async () => {
  missed.set(T1, [lesson(DAY_A, 1), lesson(DAY_A, 3), lesson(pastWeekday(9), 2)]);
  missed.set(T2, [lesson(DAY_A, 2, { reason: "absent", reasonLabel: "Kelmagan" })]);
  missed.set(ARCH, [lesson(DAY_A, 4)]);

  const day = await service.getDay({ date: KEY_A });

  assert.deepEqual(
    day.teachers.map((t) => [t.teacherName, t.lessons.map((l) => l.lessonOrder), t.perHourRate, t.missedAmount]),
    [
      ["Dildora Nurmatova", [1, 3], "50000.00", "100000.00"],
      ["Sardor Karimov", [2], null, null],
    ],
  );
  assert.equal(day.totals.lessons, 3);
  assert.equal(day.totals.missedAmount, "100000.00");
  assert.equal(day.date, KEY_A);
});

/* ─────────────────────── Belgilash ─────────────────────── */

test("tanlangan darslar: faqat haqiqatan o'tilmagani belgilanadi, qolgani o'tkazib yuboriladi", async () => {
  missed.set(T1, [lesson(DAY_A, 1), lesson(DAY_A, 3)]);

  const result = await service.createCredits(
    {
      date: KEY_A,
      mode: "lessons",
      reason: "Platforma ishlamadi",
      lessons: [
        { teacherId: T1, classId: C1, subjectId: S1, lessonOrder: 1 },
        // Takror — bitta dars
        { teacherId: T1, classId: C1, subjectId: S1, lessonOrder: 1 },
        // Fani boshqa — o'tilmaganlar ro'yxatida yo'q
        { teacherId: T1, classId: C1, subjectId: S2, lessonOrder: 3 },
      ],
    },
    OWNER,
  );

  assert.equal(result.created, 1);
  assert.equal(result.skipped, 1);
  assert.equal(db.credits.length, 1);
  const [row] = db.credits;
  assert.equal(row.teacherId, T1);
  assert.equal(row.lessonOrder, 1);
  assert.equal(row.missReason, "noGrade");
  assert.equal(dayKey(row.date), KEY_A);
  assert.equal(row.activeKey, `${T1}|${C1}|${S1}|1|${KEY_A}`);
  assert.equal(row.snapshot.teacherName, "Dildora Nurmatova");
  assert.equal(row.createdBy, OWNER);
  // Oylik tarixida qoladi
  assert.equal(db.audits.length, 1);
  assert.equal(db.audits[0].action, "lesson.credit");
  assert.match(db.audits[0].summary, /Platforma ishlamadi/);
});

test("kunning hammasi: hamma o'qituvchi yoki faqat tanlanganlar", async () => {
  missed.set(T1, [lesson(DAY_A, 1), lesson(DAY_A, 3)]);
  missed.set(T2, [lesson(DAY_A, 2)]);

  const only = await service.createCredits(
    { date: KEY_A, mode: "day", teacherIds: [T2], reason: "Davomat xato" },
    OWNER,
  );
  assert.equal(only.created, 1);
  assert.deepEqual(db.credits.map((c) => c.teacherId), [T2]);

  // Belgilangan dars endi o'tilmaganlarda yo'q (soat hisobi uni o'tilgan qiladi)
  missed.set(T2, []);
  const all = await service.createCredits({ date: KEY_A, mode: "day", reason: "Davomat xato" }, OWNER);
  assert.equal(all.created, 2);
  assert.equal(all.teachers, 1);
  assert.equal(db.credits.length, 3);
  // Bitta amal — bitta guruh
  assert.equal(new Set(db.credits.filter((c) => c.teacherId === T1).map((c) => c.batchId)).size, 1);
});

test("o'tilmagan dars yo'q yoki allaqachon belgilangan — 409, hech narsa yozilmaydi", async () => {
  await assert.rejects(
    service.createCredits({ date: KEY_A, mode: "day", reason: "a" }, OWNER),
    (error) => error.statusCode === 409 && /o'tilmagan dars yo'q/.test(error.message),
  );

  // Poyga: ro'yxat o'qilgandan keyin boshqa amal shu darsni belgilab qo'ygan
  missed.set(T1, [lesson(DAY_A, 1)]);
  db.credits.push({ id: nextId(), activeKey: `${T1}|${C1}|${S1}|1|${KEY_A}`, revokedAt: null, batchId: "z" });
  await assert.rejects(
    service.createCredits({ date: KEY_A, mode: "day", reason: "a" }, OWNER),
    (error) => error.statusCode === 409 && /allaqachon belgilangan/.test(error.message),
  );
  assert.equal(db.credits.length, 1);
  assert.equal(db.audits.length, 0);
});

/* ─────────────────────── Jarima ─────────────────────── */

const gradePenalty = (userId, order, points, extra = {}) => ({
  id: nextId(),
  userId,
  title: gradePenaltyTitle("5-A", order, KEY_A, extra.substituted),
  type: "penalty",
  status: "approved",
  isCustom: true,
  points,
  createdAt: new Date(),
  ...extra,
});

test("jarima: so'ralsa shu darsning jarimasi bekor qilinadi, boshqasi tegilmaydi", async () => {
  missed.set(T1, [lesson(DAY_A, 1), lesson(DAY_A, 3, { substituted: true })]);
  const own = gradePenalty(T1, 1, 1);
  const substituted = gradePenalty(T1, 3, 1, { substituted: true });
  const otherLesson = gradePenalty(T1, 5, 1);
  const otherTeacher = gradePenalty(T2, 1, 1);
  db.penalties.push(own, substituted, otherLesson, otherTeacher);

  const result = await service.createCredits(
    { date: KEY_A, mode: "day", reason: "Platforma ishlamadi", cancelGradePenalty: true },
    OWNER,
  );

  assert.equal(result.penaltiesCancelled, 2);
  assert.equal(own.status, "rejected");
  assert.match(own.rejectionReason, /Dars o'tildi deb belgilandi: Platforma ishlamadi/);
  assert.equal(substituted.status, "rejected");
  assert.equal(otherLesson.status, "approved");
  assert.equal(otherTeacher.status, "approved");
  assert.equal(USERS[0].penaltyPoints, 1);
  assert.deepEqual(
    db.credits.map((c) => [c.penaltyId, c.penaltyPoints]).sort(),
    [[own.id, 1], [substituted.id, 1]].sort(),
  );
});

test("jarima: so'ralmasa tegilmaydi", async () => {
  missed.set(T1, [lesson(DAY_A, 1)]);
  const own = gradePenalty(T1, 1, 1);
  db.penalties.push(own);

  const result = await service.createCredits({ date: KEY_A, mode: "day", reason: "a" }, OWNER);
  assert.equal(result.penaltiesCancelled, 0);
  assert.equal(own.status, "approved");
  assert.equal(USERS[0].penaltyPoints, 3);
});

test("bekor qilish: belgi o'chmaydi, jarima va AYNAN olib tashlangan ball qaytadi", async () => {
  missed.set(T1, [lesson(DAY_A, 1)]);
  // Ball boshqa yo'l bilan kamaytirilgan: 2 ballik jarima, o'qituvchida 1 ball
  USERS[0].penaltyPoints = 1;
  const own = gradePenalty(T1, 1, 2);
  db.penalties.push(own);

  await service.createCredits(
    { date: KEY_A, mode: "day", reason: "a", cancelGradePenalty: true },
    OWNER,
  );
  // 0 dan pastga tushmaydi
  assert.equal(USERS[0].penaltyPoints, 0);
  const [credit] = db.credits;
  assert.equal(credit.penaltyPoints, 1);

  await assert.rejects(service.revokeCredits({ ids: [credit.id], reason: " " }, OWNER), /majburiy/);

  const result = await service.revokeCredits({ ids: [credit.id], reason: "Adashib belgilandi" }, OWNER);
  assert.equal(result.revoked, 1);
  assert.equal(result.penaltiesRestored, 1);
  assert.equal(own.status, "approved");
  assert.equal(own.rejectionReason, null);
  // Olib tashlangan 1 ball qaytdi — 2 emas
  assert.equal(USERS[0].penaltyPoints, 1);

  // Qator o'chmagan, faol kaliti bo'shatilgan — dars qayta belgilanishi mumkin
  assert.equal(db.credits.length, 1);
  assert.ok(credit.revokedAt instanceof Date);
  assert.equal(credit.activeKey, null);
  assert.equal(credit.revokeReason, "Adashib belgilandi");
  assert.equal(db.audits.at(-1).action, "lesson.uncredit");

  // Ikkinchi marta — 409, jarima ikki marta qaytmaydi
  await assert.rejects(
    service.revokeCredits({ ids: [credit.id], reason: "yana" }, OWNER),
    (error) => error.statusCode === 409,
  );
  assert.equal(USERS[0].penaltyPoints, 1);

  const again = await service.createCredits({ date: KEY_A, mode: "day", reason: "Endi to'g'ri" }, OWNER);
  assert.equal(again.created, 1);
});

/* ─────────────────────── Muhrlangan oylik ─────────────────────── */

test("yopilgan oy: soat narxi bor muhrlangan oylik aytiladi, ochiq oyda — yo'q", async () => {
  const closed = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - 1, 10));
  const closedDay = closed.getUTCDay() === 0 ? new Date(closed.getTime() + DAY) : closed;
  const month = monthKeyOfDate(closedDay);
  assert.ok(month < currentMonthKey());

  missed.set(T1, [lesson(closedDay, 1)]);
  missed.set(T2, [lesson(closedDay, 2)]);
  db.entries.push(
    { id: "e1", month, staffId: T1, status: "unpaid", perHourRate: new Decimal("50000"), amount: new Decimal("1000000"), staffSnapshot: { firstName: "Dildora", lastName: "Nurmatova" } },
    // Sof fiksa — soat pulga ta'sir qilmaydi
    { id: "e2", month, staffId: T2, status: "paid", perHourRate: new Decimal(0), amount: new Decimal("3000000"), staffSnapshot: {} },
  );

  const result = await service.createCredits(
    { date: dayKey(closedDay), mode: "day", reason: "a" },
    OWNER,
  );
  assert.equal(result.created, 2);
  assert.deepEqual(
    result.sealed.map((m) => [m.month, m.entries.map((e) => [e.entryId, e.staffName, e.statusLabel])]),
    [[month, [["e1", "Dildora Nurmatova", "To'lanmagan"]]]],
  );

  // Ochiq oy — soatbay oylik muhrlanmaydi, ogohlantirish yo'q
  missed.set(T1, [lesson(DAY_A, 1)]);
  if (monthKeyOfDate(DAY_A) === currentMonthKey()) {
    db.entries.push({ ...db.entries[0], id: "e3", month: currentMonthKey() });
    const open = await service.createCredits({ date: KEY_A, mode: "day", teacherIds: [T1], reason: "a" }, OWNER);
    assert.deepEqual(open.sealed, []);
  }
});

/* ─────────────────────── Registr ─────────────────────── */

test("registr: holat va o'qituvchi bo'yicha, sahifalangan", async () => {
  missed.set(T1, [lesson(DAY_A, 1), lesson(DAY_A, 3)]);
  missed.set(T2, [lesson(DAY_A, 2)]);
  await service.createCredits({ date: KEY_A, mode: "day", reason: "a" }, OWNER);
  const t2Credit = db.credits.find((c) => c.teacherId === T2);
  await service.revokeCredits({ ids: [t2Credit.id], reason: "b" }, OWNER);

  const active = await service.listCredits({ status: "active" });
  assert.equal(active.pagination.total, 2);
  assert.ok(active.data.every((row) => row.status === "active" && row.teacherId === T1));
  assert.equal(active.data[0].createdByName, "Bosh Direktor");
  assert.equal(active.data[0].missReasonLabel, "Baho qo'yilmagan");

  const revoked = await service.listCredits({ status: "revoked", teacherId: T2 });
  assert.equal(revoked.data.length, 1);
  assert.equal(revoked.data[0].revokeReason, "b");
  assert.equal(revoked.data[0].revokedByName, "Bosh Direktor");

  await assert.rejects(service.listCredits({ status: "x" }), /Holat/);
  const paged = await service.listCredits({ limit: 1, page: 2 });
  assert.equal(paged.data.length, 1);
  assert.equal(paged.pagination.totalPages, 3);
});

/* ─────────────────────── Davomat: dars o'tilgan kun — kelgan kun ─────────────────────── */

const attendanceRow = (userId, status, extra = {}) => ({
  id: nextId(),
  userId,
  date: DAY_A,
  status,
  checkIn: null,
  checkOut: null,
  autoMarked: true,
  absenceReason: null,
  excuseReason: null,
  penaltyApplied: false,
  penaltyRef: null,
  lastModifiedBy: null,
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...extra,
});

test("davomat: \"kelmadi\" kuni dars o'tildi — \"keldi\" bo'ladi, jarimasi bekor, oylik yangilanadi", async () => {
  missed.set(T1, [lesson(DAY_A, 1, { reason: "absent" }), lesson(DAY_A, 3, { reason: "absent" })]);
  const absentPenalty = { id: nextId(), userId: T1, title: "Kelmadi", type: "penalty", status: "approved", isCustom: true, points: 2, createdAt: new Date() };
  db.penalties.push(absentPenalty);
  const record = attendanceRow(T1, "absent", { penaltyApplied: true, penaltyRef: absentPenalty.id });
  db.attendance.push(record);

  const result = await service.createCredits(
    { date: KEY_A, mode: "lessons", reason: "Darsda bo'lgan", lessons: [{ teacherId: T1, classId: C1, subjectId: S1, lessonOrder: 1 }] },
    OWNER,
  );

  assert.equal(result.attendanceFixed, 1);
  assert.equal(record.status, "present");
  assert.equal(record.autoMarked, false);
  assert.equal(record.penaltyApplied, false);
  assert.match(record.excuseReason, /Dars o'tildi deb belgilandi: Darsda bo'lgan/);
  assert.equal(absentPenalty.status, "rejected");
  assert.equal(USERS[0].penaltyPoints, 1);
  // Kelmagan kun ayirmasi muhrlangan oylikda ham darhol qayta hisoblanadi
  assert.deepEqual(resynced, [{ ids: [T1], day: KEY_A }]);
  // Avvalgi holat belgida
  const [credit] = db.credits;
  assert.equal(credit.attendanceRestore.status, "absent");
  assert.equal(credit.attendanceRestore.penaltyRemoved, 2);

  // Bekor qilish — "kelmadi", jarima va ball aynan qaytadi
  const back = await service.revokeCredits({ ids: [credit.id], reason: "Adashildi" }, OWNER);
  assert.equal(back.attendanceRestored, 1);
  assert.equal(record.status, "absent");
  assert.equal(record.autoMarked, true);
  assert.equal(record.penaltyApplied, true);
  assert.equal(record.excuseReason, null);
  assert.equal(absentPenalty.status, "approved");
  assert.equal(USERS[0].penaltyPoints, 3);
  assert.equal(resynced.length, 2);
});

test("davomat: qatori yo'q kun — \"keldi\" yoziladi, bekor qilinsa o'chadi; keldi/kech keldi tegilmaydi", async () => {
  missed.set(T1, [lesson(DAY_A, 1)]);
  missed.set(T2, [lesson(DAY_A, 2)]);
  const late = attendanceRow(T2, "late", { checkIn: new Date(), autoMarked: false });
  db.attendance.push(late);

  const result = await service.createCredits({ date: KEY_A, mode: "day", reason: "a" }, OWNER);
  assert.equal(result.attendanceFixed, 1);
  const created = db.attendance.find((a) => a.userId === T1);
  assert.equal(created.status, "present");
  assert.equal(created.createdBy, OWNER);
  assert.equal(late.status, "late");

  const ids = db.credits.map((c) => c.id);
  const back = await service.revokeCredits({ ids, reason: "b" }, OWNER);
  assert.equal(back.attendanceRestored, 1);
  assert.equal(db.attendance.some((a) => a.userId === T1), false);
  assert.equal(late.status, "late");
});

test("davomat: kunda boshqa faol belgi qolsa — \"keldi\" qoladi, qaytarish ma'lumoti unga ko'chadi", async () => {
  missed.set(T1, [lesson(DAY_A, 1, { reason: "absent" })]);
  const record = attendanceRow(T1, "absent");
  db.attendance.push(record);
  await service.createCredits({ date: KEY_A, mode: "day", reason: "a" }, OWNER);

  // Ikkinchi amal — boshqa darsi (davomat allaqachon "keldi")
  missed.set(T1, [lesson(DAY_A, 3, { reason: "noGrade" })]);
  const second = await service.createCredits({ date: KEY_A, mode: "day", reason: "b" }, OWNER);
  assert.equal(second.attendanceFixed, 0);

  const [first, other] = db.credits;
  await service.revokeCredits({ ids: [first.id], reason: "c" }, OWNER);
  assert.equal(record.status, "present");
  assert.equal(other.attendanceRestore.status, "absent");

  await service.revokeCredits({ ids: [other.id], reason: "d" }, OWNER);
  assert.equal(record.status, "absent");
});

test("davomat: admin keyin qo'lda o'zgartirgan bo'lsa — bekor qilish unga tegmaydi", async () => {
  missed.set(T1, [lesson(DAY_A, 1, { reason: "absent" })]);
  const record = attendanceRow(T1, "absent");
  db.attendance.push(record);
  await service.createCredits({ date: KEY_A, mode: "day", reason: "a" }, OWNER);

  // Admin kelish vaqtini yozib qo'ydi
  record.checkIn = new Date();
  const back = await service.revokeCredits({ ids: [db.credits[0].id], reason: "b" }, OWNER);
  assert.equal(back.attendanceRestored, 0);
  assert.equal(record.status, "present");
});

test("davomat: owner'ga tegilmaydi", async () => {
  missed.set(OWNER, [lesson(DAY_A, 1)]);
  // Kun o'qituvchilari ro'yxatiga owner ham kirsin
  const original = prisma.scheduleLesson.findMany;
  prisma.scheduleLesson.findMany = async () => [{ teacherId: OWNER }];
  try {
    const result = await service.createCredits({ date: KEY_A, mode: "day", reason: "a" }, OWNER);
    assert.equal(result.created, 1);
    assert.equal(result.attendanceFixed, 0);
    assert.equal(db.attendance.length, 0);
  } finally {
    prisma.scheduleLesson.findMany = original;
  }
});
