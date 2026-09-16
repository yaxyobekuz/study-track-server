const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * O'TGAN KUNLAR DARSIGA BAHO QO'YISH OYNASI.
 *
 * `gradingUnlock.service` haqiqiy kodi; baza, soat hisobi va "maktabda"
 * tekshiruvi soxta. Eng muhim qoidalar: faqat o'tgan kunlar ochiladi,
 * oyna hammaga yoki tanlanganlarga tegishli, yopilgan/muddati o'tgan oyna
 * baho qo'yishga ruxsat bermaydi, o'qituvchi ro'yxatida faqat ochiq
 * kunlardagi baho qo'yilmagan darslar chiqadi.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const { currentDayDate } = require("../src/helpers/month.helpers");
const { dayKey } = require("../src/helpers/lessonHours");

const DAY = 24 * 3600 * 1000;
const TODAY = currentDayDate();
const daysAgo = (n) => new Date(TODAY.getTime() - n * DAY);
const monthOf = (date) => date.getUTCFullYear() * 100 + date.getUTCMonth() + 1;

const T1 = "a".repeat(24);
const T2 = "b".repeat(24);
const STUDENT = "c".repeat(24);
const ARCHIVED = "d".repeat(24);
const OWNER = "e".repeat(24);

const USERS = [
  { id: T1, firstName: "Dildora", lastName: "Nurmatova", role: "teacher", isArchived: false },
  { id: T2, firstName: "Sardor", lastName: "Karimov", role: "teacher", isArchived: false },
  { id: STUDENT, firstName: "O'quvchi", lastName: "Bir", role: "student", isArchived: false },
  { id: ARCHIVED, firstName: "Eski", lastName: "Xodim", role: "teacher", isArchived: true },
  { id: OWNER, firstName: "Bosh", lastName: "Direktor", role: "owner", isArchived: false },
];

let db;
let missedByMonth;
const resetDb = () => {
  db = { unlocks: [], audits: [], entries: [] };
  missedByMonth = new Map();
};

/* ── `where` ning shu servis ishlatadigan qismi ── */
const cmp = (value, cond) => {
  if (cond === undefined) return true;
  if (cond === null) return value == null;
  if (cond instanceof Date) return value?.getTime() === cond.getTime();
  if (typeof cond !== "object") return value === cond;
  if ("not" in cond) return cond.not === null ? value != null : value !== cond.not;
  if ("in" in cond) return cond.in.includes(value);
  if ("has" in cond) return (value ?? []).includes(cond.has);
  return (
    (cond.gt === undefined || value > cond.gt) &&
    (cond.gte === undefined || value >= cond.gte) &&
    (cond.lt === undefined || value < cond.lt) &&
    (cond.lte === undefined || value <= cond.lte)
  );
};
const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) =>
    key === "OR" ? cond.some((c) => matches(row, c)) : cmp(row[key], cond),
  );

const prisma = {
  user: {
    findMany: async ({ where }) => USERS.filter((u) => matches(u, where)),
  },
  gradingUnlock: {
    findFirst: async ({ where }) =>
      db.unlocks
        .filter((r) => matches(r, where))
        .sort((a, b) => b.expiresAt - a.expiresAt)[0] ?? null,
    findUnique: async ({ where }) => db.unlocks.find((r) => r.id === where.id) ?? null,
    findMany: async ({ where }) => db.unlocks.filter((r) => matches(r, where)),
    count: async ({ where }) => db.unlocks.filter((r) => matches(r, where)).length,
    create: async ({ data }) => {
      const row = {
        id: String(db.unlocks.length + 1).padStart(24, "0"),
        revokedAt: null,
        revokedBy: null,
        createdAt: new Date(),
        ...data,
      };
      db.unlocks.push(row);
      return row;
    },
    update: async ({ where, data }) => {
      const row = db.unlocks.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    },
  },
  payrollEntry: {
    count: async ({ where }) => db.entries.filter((e) => matches(e, where)).length,
  },
  payrollAudit: { create: async ({ data }) => db.audits.push(data) },
  $transaction: async (fn) => fn(prisma),
};

fakeModule("../src/config/prisma", prisma);
fakeModule("../src/services/lessonHours.service", {
  getTeachersHours: async (ids, month) =>
    new Map(ids.map((id) => [id, { missedLessons: missedByMonth.get(month) ?? [] }])),
});
fakeModule("../src/services/gradingPresence.service", {
  getGradingPresence: async () => ({ required: true, atSchool: false, state: "notArrived", message: "Siz maktabda emassiz" }),
});

const service = require("../src/services/gradingUnlock.service");

const input = (overrides = {}) => ({
  dateFrom: dayKey(daysAgo(5)),
  dateTo: dayKey(daysAgo(1)),
  scope: "all",
  preset: "3d",
  ...overrides,
});

test("muddat: 3 kun / 1 hafta / oy oxiri / qo'lda — Toshkent kunining oxirigacha", () => {
  const endOf = (dayDate) => new Date(dayDate.getTime() + DAY - 5 * 3600 * 1000 - 1);

  assert.equal(service.parseExpiry({ preset: "3d" }).getTime(), endOf(new Date(TODAY.getTime() + 3 * DAY)).getTime());
  assert.equal(service.parseExpiry({ preset: "1w" }).getTime(), endOf(new Date(TODAY.getTime() + 7 * DAY)).getTime());

  const monthEnd = service.parseExpiry({ preset: "monthEnd" });
  const lastDay = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() + 1, 0));
  assert.equal(monthEnd.getTime(), endOf(lastDay).getTime());

  const until = dayKey(new Date(TODAY.getTime() + 10 * DAY));
  assert.equal(
    service.parseExpiry({ preset: "custom", until }).getTime(),
    endOf(new Date(TODAY.getTime() + 10 * DAY)).getTime(),
  );

  assert.throws(() => service.parseExpiry({ preset: "custom", until: dayKey(daysAgo(2)) }), /o'tib ketgan/);
  assert.throws(() => service.parseExpiry({}), /Muddatni tanlang/);
});

test("oraliq: faqat o'tgan kunlar, tartibli va chegaralangan", () => {
  assert.throws(() => service.parseRange({ dateFrom: dayKey(daysAgo(3)), dateTo: dayKey(TODAY) }), /o'tgan kunlarni/);
  assert.throws(() => service.parseRange({ dateFrom: dayKey(daysAgo(1)), dateTo: dayKey(daysAgo(3)) }), /noto'g'ri/);
  assert.throws(
    () => service.parseRange({ dateFrom: dayKey(daysAgo(service.MAX_RANGE_DAYS + 1)), dateTo: dayKey(daysAgo(1)) }),
    /kundan oshmasin/,
  );

  // Bitta kun — `dateTo` berilmasa ham
  const single = service.parseRange({ dateFrom: dayKey(daysAgo(2)) });
  assert.equal(single.from.getTime(), single.to.getTime());
  const max = service.parseRange({ dateFrom: dayKey(daysAgo(service.MAX_RANGE_DAYS)), dateTo: dayKey(daysAgo(1)) });
  assert.ok(max.from < max.to);
});

test("hammaga ochish: oyna yoziladi, audit va muhrlangan oylik ogohlantirishi", async () => {
  resetDb();
  db.entries.push(
    { staffId: T1, month: monthOf(daysAgo(1)), status: "unpaid" },
    { staffId: T2, month: monthOf(daysAgo(1)), status: "cancelled" },
  );

  const unlock = await service.createUnlock(input({ reason: "Platforma ishlamadi" }), OWNER);

  assert.equal(unlock.scope, "all");
  assert.equal(unlock.status, "active");
  assert.deepEqual(unlock.teachers, []);
  assert.equal(unlock.dayCount, 5);
  assert.equal(unlock.dateFrom, dayKey(daysAgo(5)));
  assert.match(unlock.rangeLabel, / — /);
  assert.equal(unlock.grantedByName, "Bosh Direktor");
  assert.equal(unlock.sealedCount >= 1, true);

  assert.equal(db.audits.length, 1);
  assert.equal(db.audits[0].action, "grading.unlock");
  assert.match(db.audits[0].summary, /hamma o'qituvchiga/);
  assert.match(db.audits[0].summary, /Platforma ishlamadi/);
});

test("tanlanganlarga ochish: o'quvchi, arxivlangan va bo'sh ro'yxat rad etiladi", async () => {
  resetDb();

  await assert.rejects(service.createUnlock(input({ scope: "selected", teacherIds: [] }), OWNER), /Kamida bitta/);
  await assert.rejects(service.createUnlock(input({ scope: "selected", teacherIds: [STUDENT] }), OWNER), /topilmadi/);
  await assert.rejects(service.createUnlock(input({ scope: "selected", teacherIds: [ARCHIVED] }), OWNER), /arxivlangan/);
  await assert.rejects(service.createUnlock(input({ scope: "hech kim" }), OWNER), /Kimga/);
  assert.equal(db.unlocks.length, 0);

  const unlock = await service.createUnlock(input({ scope: "selected", teacherIds: [T1, T1, T2] }), OWNER);
  assert.deepEqual(unlock.teacherIds, [T1, T2]);
  assert.deepEqual(unlock.teachers.map((t) => t.name), ["Dildora Nurmatova", "Sardor Karimov"]);
  assert.match(db.audits[0].summary, /2 ta o'qituvchiga/);
});

test("ochiq oyna: kimga va qaysi kunga tegishli, yopilgani va muddati o'tgani hisob emas", async () => {
  resetDb();
  await service.createUnlock(input({ scope: "selected", teacherIds: [T1] }), OWNER);

  assert.ok(await service.findActiveUnlock(T1, daysAgo(3)));
  assert.equal(await service.findActiveUnlock(T2, daysAgo(3)), null);
  assert.equal(await service.findActiveUnlock(T1, daysAgo(6)), null);

  // Hammaga ochilgani har kimni qamraydi
  const all = await service.createUnlock(input({ dateFrom: dayKey(daysAgo(10)), dateTo: dayKey(daysAgo(8)) }), OWNER);
  assert.equal((await service.findActiveUnlock(T2, daysAgo(9))).id, all.id);

  // Muddati o'tgan
  db.unlocks.find((r) => r.id === all.id).expiresAt = new Date(Date.now() - 1000);
  assert.equal(await service.findActiveUnlock(T2, daysAgo(9)), null);
});

test("yopish: faol oyna yopiladi, keyin topilmaydi va qayta yopib bo'lmaydi", async () => {
  resetDb();
  const unlock = await service.createUnlock(input(), OWNER);

  const revoked = await service.revokeUnlock(unlock.id, OWNER);
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.revokedByName, "Bosh Direktor");
  assert.equal(await service.findActiveUnlock(T1, daysAgo(2)), null);
  await assert.rejects(service.revokeUnlock(unlock.id, OWNER), /allaqachon yopilgan/);
  assert.equal(db.audits.at(-1).action, "grading.lock");

  const list = await service.listUnlocks({ status: "revoked" });
  assert.equal(list.data.length, 1);
  assert.equal(list.totals.active, 0);
  assert.equal((await service.listUnlocks({ status: "active" })).data.length, 0);
});

test("o'qituvchi huquqi: faqat ochiq kunlardagi baho qo'yilmagan darslar, sana bo'yicha", async () => {
  resetDb();
  await service.createUnlock(
    input({ scope: "selected", teacherIds: [T1], dateFrom: dayKey(daysAgo(3)), dateTo: dayKey(daysAgo(2)) }),
    OWNER,
  );

  const lesson = (date, order, className) => ({
    date,
    dateLabel: `label-${dayKey(date)}`,
    classId: `class-${className}`,
    className,
    subjectId: "s1",
    subjectName: "Matematika",
    lessonOrder: order,
    reason: "noGrade",
    reasonLabel: "Baho qo'yilmagan",
    substituted: false,
  });

  // Oylar kesishsa ham har oy alohida so'raladi
  for (const date of [daysAgo(1), daysAgo(2), daysAgo(3), daysAgo(4)]) {
    const month = monthOf(date);
    const list = missedByMonth.get(month) ?? [];
    list.push(lesson(date, 2, "7-B"), lesson(date, 1, "5-A"));
    missedByMonth.set(month, list);
  }

  const access = await service.getMyAccess({ id: T1, role: "teacher" });
  assert.equal(access.presence.atSchool, false);
  assert.equal(access.unlocks.length, 1);
  assert.deepEqual(access.days.map((d) => d.date), [dayKey(daysAgo(3)), dayKey(daysAgo(2))]);
  assert.deepEqual(access.days[0].lessons.map((l) => l.lessonOrder), [1, 2]);
  assert.ok(access.days[0].dayName);
  assert.ok(access.days[0].expiresAtLabel);

  // Boshqa o'qituvchida ochiq kun yo'q
  const other = await service.getMyAccess({ id: T2, role: "teacher" });
  assert.deepEqual(other.days, []);
  assert.deepEqual(other.unlocks, []);
});
