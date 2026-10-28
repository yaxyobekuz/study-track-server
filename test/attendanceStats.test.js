/**
 * DAVOMAT STATISTIKASI — DAVR VA TARMOQ ARIFMETIKASI.
 *
 * Ikki narsa sinaladi va ikkalasi ham JIM xato bo'lardi:
 *
 *  1. DAVR. "Oylik" tanlanganda oldingi oyning AYNI qismi olinishi (28
 *     kunlik oktabr 30 kunlik sentabr bilan solishtirilmasligi) va oy
 *     chegarasida kun oshib ketmasligi (31-mart − 1 oy → 28-fevral).
 *  2. BIRLASHTIRISH. Hisobot umumiy birlashtiruvchidan ATAYLAB chetlab
 *     o'tadi (`aggregateRoute.registry.js` → `anchor`), ya'ni filiallarni
 *     qo'shish mas'uliyati `attendanceStatsNetwork.service.js` ning
 *     o'zida: foiz YIG'INDIDAN hisoblanishi, kunlar KALIT bo'yicha
 *     birlashishi va reyting QAYTA saralanishi kerak.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveStatPeriod,
  previousRange,
  bucketLabel,
} = require("../src/helpers/statPeriod.helpers");
const {
  combineStudentReports,
  combineTeacherReports,
  mergeLive,
} = require("../src/services/attendanceStatsNetwork.service");
const {
  bucketize,
  byWeekday,
  diffOf,
  sumDays,
  sumTeacherDays,
} = require("../src/services/attendanceStats.service");

/* ─────────────────────────── Yordamchilar ─────────────────────────── */

const branch = (id, name) => ({ id, name });

/** Kun qatori — `aggregateByDay` qaytaradigan shakl. */
const day = (date, { expected, present = 0, late = 0, absent = 0, excused = 0 }) => ({
  date,
  expected,
  present,
  late,
  absent,
  excused,
  total: present + late + absent + excused,
  came: present + late,
  unmarked: Math.max(0, expected - (present + late + absent + excused)),
  percent: expected ? Math.round(((present + late) / expected) * 1000) / 10 : null,
});

const period = (over = {}) => ({
  key: "month",
  label: "Oylik",
  fromKey: "2026-10-01",
  toKey: "2026-10-02",
  days: 2,
  granularity: "day",
  rangeLabel: "1-oktabr, 2026 — 2-oktabr, 2026",
  includesToday: true,
  todayKey: "2026-10-02",
  previous: {
    fromKey: "2026-09-01",
    toKey: "2026-09-02",
    days: 2,
    label: "1-sentabr, 2026 — 2-sentabr, 2026",
    title: "O'tgan oy",
  },
  ...over,
});

const studentReport = (days, over = {}) => {
  const totals = sumDays(days);
  const previous = sumDays([]);

  return {
    kind: "students",
    period: period(),
    totals,
    previous,
    previousDayKeys: [],
    change: diffOf(totals, previous, ["expected", "came"]),
    byDay: days,
    classes: [],
    students: [],
    ...over,
  };
};

const teacherDay = (date, { expected, present = 0, late = 0, absent = 0, excused = 0, unmarked = 0, lateMinutes = 0 }) => ({
  date,
  expected,
  present,
  late,
  absent,
  excused,
  unmarked,
  total: present + late + absent + excused,
  came: present + late,
  lateMinutes,
  percent: expected ? Math.round(((present + late) / expected) * 1000) / 10 : null,
});

/* ───────────────────────────── 1. DAVR ───────────────────────────── */

test("oldingi oy — davrning AYNI qismi, to'liq oy emas", () => {
  const prev = previousRange({ fromKey: "2026-10-01", toKey: "2026-10-28", preset: "month" });

  assert.equal(prev.fromKey, "2026-09-01");
  assert.equal(prev.toKey, "2026-09-28");
  assert.equal(prev.days, 28);
  assert.equal(prev.title, "O'tgan oy");
});

test("oy chegarasida kun OSHIB KETMAYDI (31-mart → 28-fevral)", () => {
  const prev = previousRange({ fromKey: "2026-03-01", toKey: "2026-03-31", preset: "month" });

  assert.equal(prev.toKey, "2026-02-28");
});

test("hafta — oldingi haftaning AYNI kunlari, yil — o'tgan yilning AYNI sanasi", () => {
  const week = previousRange({ fromKey: "2026-10-26", toKey: "2026-10-28", preset: "week" });
  assert.deepEqual([week.fromKey, week.toKey], ["2026-10-19", "2026-10-21"]);

  const year = previousRange({ fromKey: "2026-01-01", toKey: "2026-10-28", preset: "year" });
  assert.deepEqual([year.fromKey, year.toKey], ["2025-01-01", "2025-10-28"]);
});

test("qo'lda tanlangan oraliq — AYNI uzunlikdagi, darhol oldin turgan oyna", () => {
  const prev = previousRange({ fromKey: "2026-03-10", toKey: "2026-03-19", preset: null });

  assert.equal(prev.days, 10);
  assert.equal(prev.toKey, "2026-03-09");
  assert.equal(prev.fromKey, "2026-02-28");
});

test("yaroqsiz oraliq RAD ETILADI (jim qisqarmaydi)", () => {
  assert.throws(
    () => resolveStatPeriod({ from: "2026-10-10", to: "2026-10-01" }, { onError: (m) => new Error(m) }),
    /Davr boshi/,
  );
  assert.throws(
    () => resolveStatPeriod({ from: "2020-01-01", to: "2026-10-01" }, { onError: (m) => new Error(m) }),
    /bir yildan oshmasligi/,
  );
});

test("bo'lak yorlig'i — sana formati qoidasi bo'yicha", () => {
  assert.equal(bucketLabel("2026-10-27", "day"), "27-oktabr, 2026");
  assert.equal(bucketLabel("2026-10-26", "week"), "26-oktabr, 2026 dan boshlangan hafta");
  assert.equal(bucketLabel("2026-10-01", "month"), "Oktabr, 2026");
});

/* ──────────────────── 2. O'QUVCHILAR BIRLASHMASI ──────────────────── */

test("foiz YIG'INDIDAN hisoblanadi, filiallar o'rtachasi EMAS", () => {
  // Katta filial 90%, kichkinasi 50% — og'irliksiz o'rtacha 70% bo'lardi.
  const big = studentReport([day("2026-10-01", { expected: 1000, present: 900, absent: 100 })]);
  const small = studentReport([day("2026-10-01", { expected: 10, present: 5, absent: 5 })]);

  const net = combineStudentReports({
    reports: [
      { branch: branch("b1", "Katta"), report: big },
      { branch: branch("b2", "Kichik"), report: small },
    ],
  });

  assert.equal(net.totals.expected, 1010);
  assert.equal(net.totals.came, 905);
  assert.equal(net.totals.percent, 89.6);
  assert.notEqual(net.totals.percent, 70);
});

test("kunlar KALIT bo'yicha birlashadi — o'quv kunlari qo'shilib ketmaydi", () => {
  const a = studentReport([
    day("2026-10-01", { expected: 100, present: 90, absent: 10 }),
    day("2026-10-02", { expected: 100, present: 95, absent: 5 }),
  ]);
  const b = studentReport([day("2026-10-01", { expected: 50, present: 50 })]);

  const net = combineStudentReports({
    reports: [
      { branch: branch("b1", "A"), report: a },
      { branch: branch("b2", "B"), report: b },
    ],
  });

  // Ikkala filialda ham 1-oktabr bor — bu BITTA o'quv kuni
  assert.equal(net.byDay.length, 2);
  assert.equal(net.totals.schoolDays, 2);

  const first = net.byDay.find((row) => row.date === "2026-10-01");
  assert.equal(first.expected, 150);
  assert.equal(first.came, 140);
});

test("oldingi davrning o'quv kunlari ham BIRLASHADI, qo'shilmaydi", () => {
  const withPrev = (keys) =>
    studentReport([day("2026-10-01", { expected: 10, present: 10 })], {
      previous: { ...sumDays([]), schoolDays: keys.length, percent: null },
      previousDayKeys: keys,
    });

  const net = combineStudentReports({
    reports: [
      { branch: branch("b1", "A"), report: withPrev(["2026-09-01", "2026-09-02"]) },
      { branch: branch("b2", "B"), report: withPrev(["2026-09-02", "2026-09-03"]) },
    ],
  });

  assert.equal(net.previous.schoolDays, 3);
});

test("filiallar kesimi — eng past davomat BIRINCHI turadi", () => {
  const good = studentReport([day("2026-10-01", { expected: 100, present: 99, absent: 1 })]);
  const bad = studentReport([day("2026-10-01", { expected: 100, present: 70, absent: 30 })]);

  const net = combineStudentReports({
    reports: [
      { branch: branch("b1", "Yaxshi"), report: good },
      { branch: branch("b2", "Past"), report: bad },
    ],
  });

  assert.deepEqual(
    net.byBranch.map((row) => row.branchName),
    ["Past", "Yaxshi"],
  );
  assert.equal(net.byBranch[0].percent, 70);
  assert.equal(net.byBranch[0].expected - net.byBranch[0].came, 30);
});

test("sinflar va o'quvchilar ro'yxati QAYTA saralanadi va filial bilan keladi", () => {
  const a = studentReport([day("2026-10-01", { expected: 10, present: 10 })], {
    classes: [{ classId: "c1", className: "5-A", expected: 10, came: 9, absent: 1, excused: 0, percent: 90 }],
    students: [{ studentId: "s1", name: "Ali", className: "5-A", expected: 10, came: 9, percent: 90 }],
  });
  const b = studentReport([day("2026-10-01", { expected: 10, present: 10 })], {
    classes: [{ classId: "c2", className: "9-B", expected: 10, came: 6, absent: 4, excused: 0, percent: 60 }],
    students: [{ studentId: "s2", name: "Vali", className: "9-B", expected: 10, came: 4, percent: 40 }],
  });

  const net = combineStudentReports({
    reports: [
      { branch: branch("b1", "A filial"), report: a },
      { branch: branch("b2", "B filial"), report: b },
    ],
  });

  assert.deepEqual(net.classes.map((row) => row.className), ["9-B", "5-A"]);
  assert.equal(net.classes[0].branchName, "B filial");
  // 6 kun qoldirgan "Vali" 1 kun qoldirgan "Ali" dan yuqorida
  assert.deepEqual(net.students.map((row) => row.name), ["Vali", "Ali"]);
});

test("tushib qolgan filial JIM qolmaydi", () => {
  const net = combineStudentReports({
    reports: [
      { branch: branch("b1", "A"), report: studentReport([day("2026-10-01", { expected: 5, present: 5 })]) },
    ],
    partial: ["B filial"],
  });

  assert.deepEqual(net.partial, ["B filial"]);
  assert.equal(net.isNetwork, true);
  assert.equal(net.branch, null);
});

/* ─────────────────── 3. O'QITUVCHILAR BIRLASHMASI ─────────────────── */

/**
 * ⚠️ Fixture jamini O'ZI hisoblamaydi — XIZMATNING funksiyalarini
 * chaqiradi. Aks holda test o'z arifmetikasini sinab, mahsulot kodidagi
 * xatoni o'tkazib yuborardi.
 */
const teacherReport = (days, over = {}) => {
  const totals = sumTeacherDays(days);
  const previous = sumTeacherDays([]);

  return {
    kind: "teachers",
    period: period(),
    staffCount: 10,
    totals,
    previous,
    previousDayKeys: [],
    change: diffOf(totals, previous, ["expected", "came", "late"]),
    byDay: days,
    teachers: [],
    live: null,
    ...over,
  };
};

test("kechikish daqiqalari qo'shiladi, o'rtachasi QAYTA hisoblanadi", () => {
  const a = teacherReport([teacherDay("2026-10-01", { expected: 10, present: 8, late: 2, lateMinutes: 40 })]);
  const b = teacherReport([teacherDay("2026-10-01", { expected: 10, present: 9, late: 1, lateMinutes: 20 })]);

  const net = combineTeacherReports({
    reports: [
      { branch: branch("b1", "A"), report: a },
      { branch: branch("b2", "B"), report: b },
    ],
  });

  assert.equal(net.totals.lateMinutes, 60);
  assert.equal(net.totals.late, 3);
  assert.equal(net.totals.avgLateMinutes, 20);
  assert.equal(net.totals.came, 20);
  assert.equal(net.totals.percent, 100);
  assert.equal(net.staffCount, 20);
});

test("belgilanmagan (bugungi) kunlar ham maxrajda qoladi", () => {
  const a = teacherReport([
    teacherDay("2026-10-02", { expected: 10, present: 6, unmarked: 4 }),
  ]);

  const net = combineTeacherReports({ reports: [{ branch: branch("b1", "A"), report: a }] });

  assert.equal(net.totals.expected, 10);
  assert.equal(net.totals.unmarked, 4);
  assert.equal(net.totals.percent, 60);
});

test("jonli blok: sanoqchilar qo'shiladi, 'dars yo'q' esa HAMMA filialda bo'lsagina qoladi", () => {
  const live = (closed, summary) => ({
    date: "2026-10-28",
    dateLabel: "28-oktabr, 2026",
    nowLabel: "09:15",
    closed,
    message: closed ? "Bayram kuni — dars yo'q" : null,
    summary: {
      teachers: 0,
      lessons: 0,
      ongoingLessons: 0,
      absentTeachers: 0,
      lateTeachers: 0,
      untimedLessons: 0,
      ...summary,
    },
    teachers: [],
  });

  const mixed = mergeLive([
    { branch: branch("b1", "A"), report: { live: live("holiday") } },
    { branch: branch("b2", "B"), report: { live: live(null, { teachers: 2, absentTeachers: 2 }) } },
  ]);
  assert.equal(mixed.closed, null, "bitta filialdagi bayram butun tarmoqqa yozilmaydi");
  assert.equal(mixed.message, null);
  assert.equal(mixed.summary.absentTeachers, 2);

  const all = mergeLive([
    { branch: branch("b1", "A"), report: { live: live("sunday") } },
    { branch: branch("b2", "B"), report: { live: live("sunday") } },
  ]);
  assert.equal(all.closed, "sunday");
});

test("jonli bloksiz davrda (o'tgan oraliq) `live` null qoladi", () => {
  const net = combineTeacherReports({
    reports: [
      { branch: branch("b1", "A"), report: teacherReport([teacherDay("2026-10-01", { expected: 5, present: 5 })]) },
    ],
  });

  assert.equal(net.live, null);
});

/* ──────────────────────── 4. BO'LAKLAR VA KUNLAR ──────────────────── */

test("dinamika davrning HAMMA bo'lagini beradi, yozuvsizini ham", () => {
  const days = [day("2026-10-01", { expected: 10, present: 10 })];

  const rows = bucketize(days, { fromKey: "2026-10-01", toKey: "2026-10-03", granularity: "day" }, [
    "expected",
    "came",
  ]);

  assert.equal(rows.length, 3);
  assert.equal(rows[0].percent, 100);
  // Yozuvsiz kun 0% EMAS, "o'lchanmagan" (null) bo'lib turadi
  assert.equal(rows[1].percent, null);
  assert.equal(rows[1].days, 0);
});

test("hafta kunlari kesimi — faqat yozuvi bor kunlar, indeks 0 = DUSHANBA", () => {
  // 2026-10-26 — dushanba, 2026-10-28 — chorshanba
  const rows = byWeekday(
    [
      day("2026-10-26", { expected: 10, present: 10 }),
      day("2026-10-28", { expected: 10, present: 5, absent: 5 }),
    ],
    ["expected", "came"],
  );

  assert.deepEqual(rows.map((row) => row.label), ["Dushanba", "Chorshanba"]);
  assert.equal(rows[0].percent, 100);
  assert.equal(rows[1].percent, 50);
});
