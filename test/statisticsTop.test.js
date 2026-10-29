/**
 * BOSH SAHIFADAGI BESHTALIK — "eng yuqori" va "eng past".
 *
 * Kartaning butun ma'nosi shundaki, u Statistika bo'limi bilan AYNI
 * ro'yxatdan kesiladi. Shuning uchun bu yerda aynan KESISH sinaladi:
 * ikkinchi reyting qurilmasligi (o'rinlar ro'yxatdagicha qolishi), eng
 * past tomonda ball to'plamaganlar chetda qolishi va ikki ro'yxat
 * kesishmasligi. Buzilsa — rahbar bosh sahifada bir o'quvchini, bo'lim
 * ichida boshqasini birinchi o'rinda ko'rardi.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  splitTopAndBottom,
  byScoreThenName,
  assignRanks,
  TOP_LIMIT,
} = require("../src/services/statistics.service");

const {
  getStatisticsPeriodRange,
  STATISTICS_PERIODS,
} = require("../src/helpers/statistics.helpers");

/** Statistika bo'limidagi ro'yxatning o'zi: saralangan va o'rin berilgan. */
const rank = (students) =>
  assignRanks(
    students
      .map(([fullName, totalSum, totalGrades = Math.max(1, Math.round(totalSum / 5))]) => ({
        student: { id: fullName, fullName },
        classes: [],
        totalSum,
        totalGrades: totalSum === 0 ? 0 : totalGrades,
      }))
      .sort(byScoreThenName),
  );

const names = (rows) => rows.map((row) => row.student.fullName);

test("beshtalik ro'yxatdan KESILADI — o'rinlar qayta hisoblanmaydi", () => {
  const rows = rank([
    ["Anvar", 300], ["Bobur", 280], ["Dilnoza", 260], ["Eldor", 240],
    ["Farrux", 220], ["Gulnora", 200], ["Hasan", 120], ["Iroda", 90],
    ["Jamshid", 60], ["Kamola", 30],
  ]);

  const { best, worst } = splitTopAndBottom(rows);

  assert.deepEqual(names(best), ["Anvar", "Bobur", "Dilnoza", "Eldor", "Farrux"]);
  assert.deepEqual(
    best.map((row) => row.place),
    [1, 2, 3, 4, 5],
    "eng yuqorida o'rin — ro'yxatdagi HAQIQIY o'rin",
  );
  // Eng past: 1 = eng past (kartadagi "1 — eng past" yorlig'i bilan AYNI)
  assert.deepEqual(names(worst), ["Kamola", "Jamshid", "Iroda", "Hasan", "Gulnora"]);
  assert.deepEqual(worst.map((row) => row.place), [1, 2, 3, 4, 5]);
  assert.equal(worst[0].rank, 10, "haqiqiy o'rin ham qatorda qoladi");
});

test("BALL TO'PLAMAGANLAR eng past ro'yxatiga KIRMAYDI", () => {
  const rows = rank([
    ["Anvar", 300], ["Bobur", 280], ["Dilnoza", 260], ["Eldor", 240],
    ["Farrux", 220], ["Gulnora", 200], ["Hasan", 120], ["Iroda", 90],
    ["Jamshid", 60], ["Kamola", 30],
    // Davr ichida umuman baho olmaganlar — ro'yxatning aynan oxirida
    ["Laziz", 0], ["Madina", 0], ["Nodir", 0],
  ]);

  const result = splitTopAndBottom(rows);

  assert.equal(result.totalStudents, 13);
  assert.equal(result.scored, 10);
  assert.equal(result.unscored, 3, "soni YO'QOLMAYDI — kartada aytiladi");
  assert.ok(
    result.worst.every((row) => row.totalSum > 0),
    "0 ballik o'quvchi 'eng past' ro'yxatida turmaydi",
  );
  assert.deepEqual(names(result.worst).slice(0, 1), ["Kamola"]);
});

test("ballga ega o'quvchi kam bo'lsa ro'yxatlar KESISHMAYDI", () => {
  const rows = rank([
    ["Anvar", 50], ["Bobur", 40], ["Dilnoza", 30], ["Eldor", 20], ["Farrux", 10],
    ["Gulnora", 0],
  ]);

  const { best, worst } = splitTopAndBottom(rows);

  assert.equal(best.length, 3, "5 ta → 3");
  assert.equal(worst.length, 2, "5 ta → 2");

  const overlap = names(best).filter((name) => names(worst).includes(name));
  assert.deepEqual(overlap, [], "bitta bola ikkala ro'yxatda turmaydi");
});

test("bitta o'quvchi ball to'plagan bo'lsa — faqat eng yuqorida", () => {
  const rows = rank([["Anvar", 10], ["Bobur", 0], ["Dilnoza", 0]]);
  const { best, worst, unscored } = splitTopAndBottom(rows);

  assert.deepEqual(names(best), ["Anvar"]);
  assert.deepEqual(worst, [], "yarmidan bo'linganda pastki ro'yxat bo'sh qoladi");
  assert.equal(unscored, 2);
});

test("hech kim ball to'plamagan — ikkala ro'yxat bo'sh, soni aytiladi", () => {
  const rows = rank([["Anvar", 0], ["Bobur", 0]]);
  const result = splitTopAndBottom(rows);

  assert.deepEqual(result.best, []);
  assert.deepEqual(result.worst, []);
  assert.equal(result.unscored, 2);
  assert.equal(result.totalStudents, 2);
});

test("teng ball — teng o'rin (musobaqa reytingi saqlanadi)", () => {
  // 12 ta ball to'plagan o'quvchi — beshtalik to'liq chiqadi
  const rows = rank([
    ["Anvar", 300], ["Bobur", 280], ["Dilnoza", 280], ["Eldor", 240],
    ["Farrux", 220], ["Gulnora", 200], ["Hasan", 180], ["Iroda", 160],
    ["Jamshid", 140], ["Kamola", 120], ["Laziz", 100], ["Madina", 80],
  ]);

  const { best } = splitTopAndBottom(rows);

  assert.deepEqual(best.map((row) => row.place), [1, 2, 2, 4, 5]);
});

test("umumiy ko'rinishda filial belgisi qator bilan BIRGA qoladi", () => {
  const rows = assignRanks(
    [
      { student: { id: "a", fullName: "Anvar" }, classes: [], totalSum: 90, totalGrades: 18, _branch: { id: "1", name: "MBSI" } },
      { student: { id: "b", fullName: "Bobur" }, classes: [], totalSum: 40, totalGrades: 8, _branch: { id: "2", name: "AiHub" } },
    ].sort(byScoreThenName),
  );

  const { best, worst } = splitTopAndBottom(rows);

  assert.equal(best[0]._branch.name, "MBSI");
  assert.equal(worst[0]._branch.name, "AiHub");
});

test("chegara sukut bo'yicha 5 ta", () => {
  const rows = rank(Array.from({ length: 30 }, (_, i) => [`O'quvchi ${i}`, 300 - i * 5]));
  const { best, worst } = splitTopAndBottom(rows);

  assert.equal(TOP_LIMIT, 5);
  assert.equal(best.length, 5);
  assert.equal(worst.length, 5);
});

/* ─────────────────────── YILLIK DAVR ─────────────────────── */

test("yillik davr — KALENDAR yili, 1-yanvardan", () => {
  assert.ok(STATISTICS_PERIODS.year, "davr kataloquga qo'shilgan");

  const range = getStatisticsPeriodRange("year", "2025-06-15");

  assert.equal(range.period, "year");
  assert.equal(range.title, "Yillik");
  assert.equal(range.start.getFullYear(), 2025);
  assert.equal(range.start.getMonth(), 0);
  assert.equal(range.start.getDate(), 1);
  assert.equal(range.end.getFullYear(), 2025);
  assert.equal(range.end.getMonth(), 11);
  assert.equal(range.end.getDate(), 31);
});

test("joriy yil BUGUN bilan tugaydi — kelasi kunlar fakt emas", () => {
  const range = getStatisticsPeriodRange("year");
  const now = new Date();

  assert.equal(range.start.getMonth(), 0);
  assert.equal(range.start.getDate(), 1);
  assert.equal(range.end.getDate(), now.getDate());
  assert.equal(range.end.getMonth(), now.getMonth());
  assert.ok(range.isCurrent);
});

test("noma'lum davr AVVALGIDEK haftalikka tushadi", () => {
  // Eski mijoz (bot, monitor, o'quvchi paneli) `period` yubormaydi.
  assert.equal(getStatisticsPeriodRange("yillik").period, "week");
  assert.equal(getStatisticsPeriodRange().period, "week");
});

test("chegara so'rovdan kelsa ham CHEKLANADI", () => {
  const { resolveTopLimit, MAX_TOP_LIMIT } = require("../src/services/statistics.service");

  assert.equal(resolveTopLimit(undefined), TOP_LIMIT, "berilmasa — sukut");
  assert.equal(resolveTopLimit("3"), 3);
  // ⚠️ Butun maktab kartaning javobiga tiqilmaydi: ro'yxat uchun bo'lim bor
  assert.equal(resolveTopLimit("100000"), MAX_TOP_LIMIT);
  assert.equal(resolveTopLimit("-1"), TOP_LIMIT, "ma'nosiz qiymat — sukut");
  assert.equal(resolveTopLimit("abc"), TOP_LIMIT);
});

/* ────────────────── ORALIQNING KUN KALITLARI ────────────────── */

test("yorliq uchun KUN KALITI qaytadi — oxiri KEYINGI kunga surilmaydi", () => {
  // ⚠️ `end` — INSTANT va u 23:59:59 da turadi: brauzer uni +5 soatga
  // surib, yorliqda KEYINGI kunni ko'rsatardi ("26-oktabr — 30-oktabr",
  // holbuki hafta 29-da tugaydi). Kun kaliti soatsiz, ya'ni surilmaydi.
  const range = getStatisticsPeriodRange("week", "2026-10-28");

  assert.match(range.startDay, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(range.endDay, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(range.startDay, "2026-10-26", "dushanba");

  // Kun kaliti oraliqning O'Z kunini bildiradi, soat bilan emas
  assert.equal(range.endDay.slice(0, 10), range.endDay);
  assert.equal(range.end.getHours(), 23, "instant avvalgidek 23:59 da qoladi");
});

test("o'tgan hafta — to'liq dushanba–yakshanba", () => {
  const range = getStatisticsPeriodRange("week", "2026-10-21");

  assert.equal(range.startDay, "2026-10-19");
  assert.equal(range.endDay, "2026-10-25");
  assert.equal(range.isCurrent, false);
});

test("oylik va yillik davrda ham kun kalitlari to'g'ri", () => {
  const month = getStatisticsPeriodRange("month", "2026-02-10");
  assert.equal(month.startDay, "2026-02-01");
  assert.equal(month.endDay, "2026-02-28", "kabisa bo'lmagan yil");

  const year = getStatisticsPeriodRange("year", "2025-07-07");
  assert.equal(year.startDay, "2025-01-01");
  assert.equal(year.endDay, "2025-12-31");
});
