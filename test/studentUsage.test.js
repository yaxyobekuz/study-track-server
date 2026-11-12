const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * TIZIMDAN FOYDALANAYOTGAN O'QUVCHILAR — bosh sahifadagi karta.
 *
 * `activityDashboard.service` haqiqiy kodi, baza soxta. Qabul mezonlari:
 *
 *   - o'quvchi IKKI yo'ldan sanaladi (o'z hisobi va ota-onasining boti),
 *     lekin JAMI ikkalasining yig'indisi EMAS — bitta bola ikkala yo'ldan
 *     ko'rinsa ham bir marta sanaladi;
 *   - davr "oxirgi kun" bo'yicha hal qilinadi: 8 kun oldin kirgan bola
 *     30 kunlik raqamda bor, 7 kunlikda yo'q;
 *   - O'QIMAYOTGAN aktyor (xodim, ketgan bola) sanoqdan chiqadi va
 *     maxraj ham AYNI ro'yxatdan olinadi — surat maxrajdan oshmaydi;
 *   - chiquvchi (`bot.out.*`) va xodim (`bot.staff.*`) hodisalari
 *     so'rovning O'ZIDA chiqarib tashlanadi;
 *   - davr chegaralari "YYYY-MM-DD" satri bo'lib uzatiladi (xom SQL da
 *     `Date` obyekti +5 soatga suriladi — `dayKey` izohi);
 *   - botga bog'langan hisoblar sanog'i FAQAT o'qiyotgan o'quvchilarniki.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const DAY = 24 * 3600 * 1000;

/** Toshkent kalendari bo'yicha bugungi kun — servis bilan AYNI qoida. */
const todayUtc = () => {
  const now = new Date();
  const tashkent = new Date(
    now.getTime() + now.getTimezoneOffset() * 60000 + 5 * 3600000,
  );
  return new Date(
    Date.UTC(tashkent.getFullYear(), tashkent.getMonth(), tashkent.getDate()),
  );
};
const key = (date) => date.toISOString().slice(0, 10);

const S1 = "a".repeat(24);
const S2 = "b".repeat(24);
const S3 = "c".repeat(24);

/* ── Soxta baza ─────────────────────────────────────────────────────── */

const state = {
  // `$queryRaw` chaqiruvi: { sql, values }
  calls: [],
  // So'rov qaytaradigan qatorlar: { sid, last_web, last_bot }
  rows: [],
  firstEvent: null,
  enrollments: [],
  students: [],
  tgUsers: [],
};

const prisma = {
  $queryRaw: (strings, ...values) => {
    state.calls.push({ sql: strings.join("?"), values });
    return Promise.resolve(state.rows);
  },
  user: {
    findMany: () => Promise.resolve(state.students),
  },
  activityEvent: {
    findFirst: () => Promise.resolve(state.firstEvent),
  },
  studentEnrollment: {
    findMany: () => Promise.resolve(state.enrollments),
  },
  tgUser: {
    findMany: () => Promise.resolve(state.tgUsers),
  },
};

fakeModule("../src/config/prisma", prisma);

const activity = require("../src/services/activityDashboard.service");

/* ═══════════════════════ SANOQ VA SHAKL ═══════════════════════ */

/** Soxta bazani sukut holatiga qaytaradi. */
const reset = () => {
  const today = todayUtc();
  state.calls = [];
  state.rows = [];
  state.firstEvent = { occurredAt: new Date(Date.now() - 200 * DAY) };
  // Uchala bola ham o'qiyapti (davr + arxivlanmagan ro'yxat)
  state.students = [{ id: S1 }, { id: S2 }, { id: S3 }];
  state.enrollments = [{ studentId: S1 }, { studentId: S2 }, { studentId: S3 }];
  state.tgUsers = [];
  return today;
};

test("bir bola ikkala yo'ldan ko'rinsa ham JAMIDA bir marta sanaladi", async () => {
  const today = reset();
  // S1 bugun ham vebda, ham botda; S2 bugun faqat botda
  state.rows = [
    { sid: S1, last_web: key(today), last_bot: key(today) },
    { sid: S2, last_web: null, last_bot: key(today) },
  ];

  const out = await activity.getStudentUsage();

  assert.equal(out.today.active, 2, "web + bot = 3 EMAS: bitta bola ikkalasida");
  assert.equal(out.today.web, 1);
  assert.equal(out.today.bot, 2);
  assert.equal(out.total, 3, "maxraj — o'qiyotgan o'quvchilar ro'yxati");
});

test("davr OXIRGI KUN bo'yicha hal qilinadi", async () => {
  const today = reset();
  const daysAgo = (n) => key(new Date(today.getTime() - n * DAY));

  state.rows = [
    { sid: S1, last_web: null, last_bot: daysAgo(0) },  // bugun
    { sid: S2, last_web: null, last_bot: daysAgo(3) },  // 7 kun ichida
    { sid: S3, last_web: daysAgo(20), last_bot: null }, // faqat 30 kun ichida
  ];

  const out = await activity.getStudentUsage();

  assert.equal(out.today.active, 1);
  assert.equal(out.week.active, 2, "7 kunlik oyna — bugun va 3 kun oldin");
  assert.equal(out.month.active, 3);
  assert.equal(out.month.web, 1);
  assert.equal(out.month.bot, 2);
});

test("O'QIMAYOTGAN aktyor sanalmaydi — surat maxrajdan oshmaydi", async () => {
  const today = reset();
  const STAFF = "f".repeat(24);
  const LEFT = "e".repeat(24);

  // S3 — ro'yxatda bor-u, davri yopilgan (`studyingStudentIds` qaytarmaydi)
  state.enrollments = [{ studentId: S1 }, { studentId: S2 }];

  state.rows = [
    { sid: S1, last_web: key(today), last_bot: null },
    { sid: S3, last_web: key(today), last_bot: null }, // ketgan bola
    { sid: LEFT, last_web: null, last_bot: key(today) }, // ro'yxatda yo'q
    { sid: STAFF, last_web: key(today), last_bot: null }, // xodim
  ];

  const out = await activity.getStudentUsage();

  assert.equal(out.total, 2, "maxraj — faqat o'qiyotganlar");
  assert.equal(out.today.active, 1, "xodim ham, ketgan bola ham sanalmaydi");
  assert.ok(out.today.active <= out.total, "surat maxrajdan oshmaydi");
});

test("davr uzunligi QO'SHILMAYDIGAN nom bilan qaytadi", async () => {
  reset();
  const out = await activity.getStudentUsage();

  // ⚠️ `weekDays` / `monthDays`: umumiy ko'rinishda birlashtiruvchi
  // "week"/"month" bo'laklarini DAVR deb tanib, qo'shmaydi — aks holda
  // ikki filialda "7 kun" "14 kun" bo'lib qolardi.
  assert.equal(out.weekDays, 7);
  assert.equal(out.monthDays, 30);
  assert.equal(out.weekDays, activity.USAGE_WEEK_DAYS);
  assert.equal(out.monthDays, activity.USAGE_MONTH_DAYS);
  // Foiz YO'Q: uni panel jami va maxrajdan chiqaradi (qo'shilgan sonlar
  // bilan mos bo'lishi uchun).
  assert.equal(out.today.rate, undefined);
});

test("so'rov chiquvchi va xodim hodisalarini O'ZIDA chiqarib tashlaydi", async () => {
  reset();
  await activity.getStudentUsage();

  const call = state.calls.at(-1);
  assert.ok(call, "xom so'rov yuborilgan");
  assert.ok(call.values.includes("bot.out.%"), "chiquvchi hodisalar chiqariladi");
  assert.ok(call.values.includes("bot.staff.%"), "xodim hodisalari chiqariladi");
  assert.match(call.sql, /NOT LIKE/);
  // Aktyor KANAL bo'yicha aniqlanmaydi (`X-Client` yuborilmasa kanal
  // `admin` bo'lib qoladi) — kanal faqat "veb yoki bot" kesimi uchun.
  assert.match(call.sql, /COALESCE\(ae\.student_id, ae\.user_id\)/);
});

test("davr chegaralari SATR bo'lib uzatiladi (Date EMAS)", async () => {
  const today = reset();
  await activity.getStudentUsage();
  const { values } = state.calls.at(-1);

  for (const value of values) {
    assert.equal(typeof value, "string", "xom SQL ga Date yuborilmaydi");
  }
  assert.ok(values.includes(key(today)), "bugungi kun");
  assert.ok(values.includes(key(new Date(today.getTime() - 29 * DAY))), "30 kunlik chegara");
});

test("tarix yaqinda yig'ila boshlagan bo'lsa EKRAN BUNI AYTADI", async () => {
  reset();
  state.firstEvent = { occurredAt: new Date(Date.now() - 3 * DAY) };
  const fresh = await activity.getStudentUsage();
  assert.equal(fresh.collecting, true, "30 kunlik raqam to'liq emas");
  assert.ok(fresh.sinceLabel, "qachondan beri — yorliq bilan");

  state.firstEvent = { occurredAt: new Date(Date.now() - 200 * DAY) };
  const old = await activity.getStudentUsage();
  assert.equal(old.collecting, false);

  state.firstEvent = null;
  const empty = await activity.getStudentUsage();
  assert.equal(empty.collecting, true, "birorta hodisa yo'q — ham yig'ilmoqda");
  assert.equal(empty.since, null);
});

/* ═══════════ BOTGA BOG'LANGAN HISOBLAR — FAQAT O'QIYOTGANLAR ═══════════ */

test("ketgan o'quvchining ota-onasi bot sanog'iga KIRMAYDI", async () => {
  state.students = [{ id: S1 }, { id: S2 }, { id: S3 }];
  state.enrollments = [
    // S1 — ochiq davr, S2 — bugunni qamragan yopiq davr, S3 — YO'Q
    { studentId: S1 },
    { studentId: S2 },
  ];
  state.tgUsers = [
    { telegramId: "tg-1", student: S1 },
    { telegramId: "tg-2", student: S1 }, // ikkinchi ota-ona — ikki hisob
    { telegramId: "tg-3", student: S2 },
    { telegramId: "tg-4", student: S3 }, // ketgan bolaning ota-onasi
    { telegramId: "tg-5", student: null }, // bog'lanmagan qator
  ];

  const ids = await activity.linkedTelegramIds();

  assert.deepEqual(ids, ["tg-1", "tg-2", "tg-3"]);
  assert.ok(!ids.includes("tg-4"), "o'qimayotgan bolanikisi sanalmaydi");
  assert.ok(!ids.includes("tg-5"), "bo'sh bog'lanish sanalmaydi");
  assert.equal(ids.length, 3, "bitta bolada ikkita hisob — ikkalasi ham hisob");
});

test("arxivlangan o'quvchi ro'yxatdan chiqsa, hisobi ham chiqadi", async () => {
  state.students = [{ id: S1 }]; // S2 arxivlangan → `findMany` qaytarmaydi
  state.enrollments = [{ studentId: S1 }, { studentId: S2 }];
  state.tgUsers = [
    { telegramId: "tg-1", student: S1 },
    { telegramId: "tg-3", student: S2 },
  ];

  const ids = await activity.linkedTelegramIds();
  assert.deepEqual(ids, ["tg-1"]);
});

/* ═══════════ UMUMIY KO'RINISHDA BIRLASHTIRISH ═══════════ */

const merge = require("../src/helpers/aggregateMerge.helpers");

const BRANCH_A = { id: "1".repeat(24), code: "main", name: "Bosh filial" };
const BRANCH_B = { id: "2".repeat(24), code: "aihub", name: "AI Hub" };

/**
 * ⚠️ Javobning SHAKLI birlashtiruvchi bilan birga loyihalangan: sanoqchi
 * qo'shiladi, davr uzunligi esa tegilmaydi. Shakl o'zgarsa (masalan
 * `weekDays` → `days`), "7 kun" ikki filialda "14 kun" bo'lib qolardi va
 * buni ekranda sezish qiyin — shuning uchun qoida test bilan qotirilgan.
 */
test("umumiy ko'rinish: sonlar qo'shiladi, davr uzunligi tegilmaydi", () => {
  const payload = (students, todayActive) => ({
    success: true,
    data: {
      total: students,
      weekDays: 7,
      monthDays: 30,
      today: { active: todayActive, web: 1, bot: todayActive },
      week: { active: todayActive * 2, web: 2, bot: todayActive * 2 },
      month: { active: todayActive * 3, web: 3, bot: todayActive * 3 },
      date: "2026-11-12",
      dateLabel: "12-noyabr, 2026",
      collecting: false,
      since: null,
      sinceLabel: null,
    },
  });

  const out = merge.mergeObject([
    { branch: BRANCH_A, body: payload(300, 20) },
    { branch: BRANCH_B, body: payload(161, 9) },
  ]);

  assert.equal(out.data.total, 461, "o'quvchi bitta filialda — qo'shiladi");
  assert.equal(out.data.today.active, 29);
  assert.equal(out.data.week.active, 58);
  assert.equal(out.data.weekDays, 7, "7 + 7 = 14 EMAS");
  assert.equal(out.data.monthDays, 30);
  assert.equal(out.data.date, "2026-11-12", "sana qo'shilmaydi");

  // Karta ostidagi filiallar kesimi (`BranchSplit`) shu yo'ldan o'qiydi
  const meta = merge.notesToMeta(out.notes);
  assert.deepEqual(meta.byBranch.values["data.today.active"], [20, 9]);
});
