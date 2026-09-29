const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * QURILMA NAZORATINING SOF QARORI.
 *
 * `devicePolicy.helpers` — bazasiz, sof funksiyalar. Aynan shu fayl
 * "telefonda nima ochiladi" degan savolga javob beradi, shuning uchun
 * test qamrovi ham eng muhim qoidalarga qaratilgan:
 *
 *   · eng TOR qamrov yutadi va siyosatlar QO'SHILMAYDI;
 *   · oyna bo'lmasa cheklov YO'Q (bo'sh ro'yxat qulf emas);
 *   · favqulodda/majburiy ilova HECH QACHON bloklanmaydi;
 *   · `always` ilova umumiy kunlik limitni yemaydi;
 *   · vaqtinchalik ochish `endsAt` bo'yicha o'zi tugaydi;
 *   · modul o'chirilganda bo'sh chekov qaytadi.
 */

const {
  resolveAssignment,
  windowState,
  activeUnlocks,
  buildDeviceProfile,
  evaluateApp,
  deviceHealth,
  parseClock,
  formatClock,
  tashkentWeekday,
  tashkentMinuteOfDay,
  MAX_UNLOCK_HOURS,
} = require("../src/helpers/devicePolicy.helpers");

const id = (ch) => ch.repeat(24);
const STUDENT = id("a");
const CLASS_A = id("b");
const CLASS_B = id("c");
const P_SCHOOL = id("1");
const P_CLASS = id("2");
const P_STUDENT = id("3");

const SETTINGS = { enabled: true, offlinePolicy: "keepLast", syncIntervalMinutes: 30 };

const app = (over = {}) => ({
  id: id("f"),
  name: "YouTube",
  androidPackage: "com.google.android.youtube",
  iosBundleId: "com.google.ios.youtube",
  isEssential: false,
  ...over,
});

/* ─────────────────────── QAMROV ─────────────────────── */

test("eng tor qamrov yutadi: o'quvchi > sinf > maktab", () => {
  const assignments = [
    { id: "1", policyId: P_SCHOOL, scope: "school", isActive: true, createdAt: "2026-01-01" },
    { id: "2", policyId: P_CLASS, scope: "class", classId: CLASS_A, isActive: true, createdAt: "2026-01-02" },
    { id: "3", policyId: P_STUDENT, scope: "student", studentId: STUDENT, isActive: true, createdAt: "2026-01-03" },
  ];

  const res = resolveAssignment({ assignments, studentId: STUDENT, classIds: [CLASS_A] });
  assert.equal(res.policyId, P_STUDENT);
  assert.match(res.reason, /shaxsan/i);
});

test("KECHROQ yaratilgan MAKTAB qoidasi shaxsiy istisnoni bekor qilmaydi", () => {
  // ⚠️ Aynan shu holat uchun "eng kech boshlangani yutadi" naqshi
  // ko'chirilmagan: maktab qoidasini bugun tahrirlash kechagi shaxsiy
  // istisnoni jimgina o'chirib yuborardi.
  const assignments = [
    { id: "1", policyId: P_STUDENT, scope: "student", studentId: STUDENT, isActive: true, createdAt: "2026-01-01" },
    { id: "2", policyId: P_SCHOOL, scope: "school", isActive: true, createdAt: "2026-09-27" },
  ];

  assert.equal(
    resolveAssignment({ assignments, studentId: STUDENT, classIds: [] }).policyId,
    P_STUDENT,
  );
});

test("ikki sinfda bo'lsa priority hal qiladi", () => {
  const assignments = [
    { id: "1", policyId: P_CLASS, scope: "class", classId: CLASS_A, priority: 0, isActive: true, createdAt: "2026-01-01" },
    { id: "2", policyId: P_STUDENT, scope: "class", classId: CLASS_B, priority: 5, isActive: true, createdAt: "2026-01-01" },
  ];

  assert.equal(
    resolveAssignment({ assignments, studentId: STUDENT, classIds: [CLASS_A, CLASS_B] }).policyId,
    P_STUDENT,
  );
});

test("faol bo'lmagan biriktirish hisobga olinmaydi", () => {
  const assignments = [
    { id: "1", policyId: P_SCHOOL, scope: "school", isActive: false, createdAt: "2026-01-01" },
  ];
  const res = resolveAssignment({ assignments, studentId: STUDENT, classIds: [] });
  assert.equal(res.policyId, null);
  assert.match(res.reason, /yo'q/i);
});

/* ─────────────────────── VAQT OYNALARI ─────────────────────── */

test("oyna bo'lmasa cheklov yo'q — bo'sh ro'yxat qulf EMAS", () => {
  assert.equal(windowState([], 1, 600).open, true);
});

test("oyna ichida ochiq, tashqarisida yopiq; endMinute eksklyuziv", () => {
  const windows = [{ weekday: 1, startMinute: 480, endMinute: 720 }];

  assert.equal(windowState(windows, 1, 480).open, true, "08:00 — ochiq");
  assert.equal(windowState(windows, 1, 719).open, true, "11:59 — ochiq");
  assert.equal(windowState(windows, 1, 720).open, false, "12:00 — yopiq (eksklyuziv)");
  assert.equal(windowState(windows, 2, 600).open, false, "boshqa kun — yopiq");
});

test("keyingi oyna topiladi (bugun bo'lmasa keyingi kundan)", () => {
  const windows = [
    { weekday: 1, startMinute: 480, endMinute: 720 },
    { weekday: 3, startMinute: 600, endMinute: 660 },
  ];

  assert.deepEqual(windowState(windows, 1, 200).next.startMinute, 480);
  assert.equal(windowState(windows, 1, 800).next.weekday, 3);
});

test("soat matni ikki tomonga to'g'ri o'giriladi", () => {
  assert.equal(parseClock("08:30"), 510);
  assert.equal(parseClock("24:00"), 1440);
  assert.equal(parseClock("25:00"), null);
  assert.equal(parseClock("nonsense"), null);
  assert.equal(formatClock(510), "08:30");
  assert.equal(formatClock(0), "00:00");
});

test("Toshkent devor-soati UTC dan +5 soat", () => {
  const instant = new Date("2026-09-27T19:30:00.000Z"); // Toshkentda 28-sentabr 00:30
  assert.equal(tashkentMinuteOfDay(instant), 30);
  assert.equal(tashkentWeekday(instant), 1, "dushanba");
});

/* ─────────────────────── OCHISH ─────────────────────── */

test("muddati o'tgan ochish status 'active' bo'lsa ham qo'llanmaydi", () => {
  // ⚠️ Supurgi kechikkan bo'lsa ham telefon ochiq qolib ketmasligi kerak.
  const now = new Date("2026-09-27T10:00:00.000Z");
  const unlocks = [
    {
      kind: "full",
      status: "active",
      startsAt: "2026-09-27T06:00:00.000Z",
      endsAt: "2026-09-27T09:00:00.000Z",
    },
  ];
  assert.equal(activeUnlocks(unlocks, now).full, null);
});

test("app turidagi ochishlarning daqiqasi QO'SHILADI", () => {
  const now = new Date("2026-09-27T10:00:00.000Z");
  const later = "2026-09-27T12:00:00.000Z";
  const unlocks = [
    { kind: "app", appId: "x", extraMinutes: 30, status: "active", startsAt: now, endsAt: later },
    { kind: "app", appId: "x", extraMinutes: 15, status: "active", startsAt: now, endsAt: later },
  ];
  assert.equal(activeUnlocks(unlocks, now).extraByAppId.get("x"), 45);
});

test("full ochishlardan eng KECH tugaydigani qoladi (qo'shilmaydi)", () => {
  const now = new Date("2026-09-27T10:00:00.000Z");
  const unlocks = [
    { kind: "full", status: "active", startsAt: now, endsAt: "2026-09-27T11:00:00.000Z" },
    { kind: "full", status: "active", startsAt: now, endsAt: "2026-09-27T14:00:00.000Z" },
  ];
  assert.equal(
    new Date(activeUnlocks(unlocks, now).full.endsAt).toISOString(),
    "2026-09-27T14:00:00.000Z",
  );
});

test("boshqa qurilmaga berilgan ochish bu qurilmaga qo'llanmaydi", () => {
  const now = new Date("2026-09-27T10:00:00.000Z");
  const unlocks = [
    {
      kind: "full",
      status: "active",
      deviceId: "device-1",
      startsAt: now,
      endsAt: "2026-09-27T14:00:00.000Z",
    },
  ];
  assert.equal(activeUnlocks(unlocks, now, "device-2").full, null);
  assert.ok(activeUnlocks(unlocks, now, "device-1").full);
});

test("ochish chegarasi 24 soat", () => {
  assert.equal(MAX_UNLOCK_HOURS, 24);
});

/* ─────────────────────── PROFIL ─────────────────────── */

const buildPolicy = (over = {}) => ({
  id: id("9"),
  name: "Dars vaqti",
  version: 3,
  defaultMode: "block",
  dailyLimitMinutes: null,
  offlinePolicy: "keepLast",
  windows: [],
  apps: [],
  ...over,
});

test("modul o'chirilganda bo'sh chekov qaytadi", () => {
  const profile = buildDeviceProfile({
    policy: buildPolicy(),
    settings: { ...SETTINGS, enabled: false },
  });

  assert.equal(profile.enforced, false);
  assert.equal(profile.defaultMode, "allow");
  assert.match(profile.reason, /o'chirilgan/i);
  // ⚠️ Favqulodda qo'ng'iroq bayrog'i BU HOLATDA HAM bor.
  assert.equal(profile.emergencyCalls, true);
});

test("siyosat biriktirilmagan bo'lsa ham cheklov yo'q", () => {
  const profile = buildDeviceProfile({ policy: null, settings: SETTINGS });
  assert.equal(profile.enforced, false);
  assert.equal(profile.version, 0);
});

test("majburiy (essential) ilovani siyosat bloklay olmaydi", () => {
  const dialer = app({
    id: id("d"),
    name: "Telefon",
    androidPackage: "com.android.dialer",
    isEssential: true,
  });

  const profile = buildDeviceProfile({
    policy: buildPolicy({ apps: [{ mode: "blocked", dailyMinutes: null, app: dialer }] }),
    settings: SETTINGS,
  });

  const entry = profile.apps.find((a) => a.identifier === "com.android.dialer");
  assert.equal(entry.mode, "always", "rejim majburan ko'tariladi");
  assert.equal(evaluateApp(profile, "com.android.dialer").allowed, true);
});

test("katalogda belgilanmagan raqam teruvchi ham zaxira ro'yxat bilan ochiq", () => {
  // ⚠️ Admin `isEssential` ni unutgan holat: oq ro'yxat uni bloklardi va
  // bola yordam so'ray olmasdi.
  const dialer = app({
    id: id("e"),
    name: "Dialer",
    androidPackage: "com.google.android.dialer",
    iosBundleId: null,
    isEssential: false,
  });

  const profile = buildDeviceProfile({
    policy: buildPolicy({ apps: [{ mode: "blocked", dailyMinutes: null, app: dialer }] }),
    settings: SETTINGS,
  });

  assert.equal(evaluateApp(profile, "com.google.android.dialer").allowed, true);
});

test("oq ro'yxat: ro'yxatda yo'q ilova bloklanadi, qora ro'yxatda — ochiq", () => {
  const blockList = buildDeviceProfile({
    policy: buildPolicy({ defaultMode: "block" }),
    settings: SETTINGS,
  });
  assert.equal(evaluateApp(blockList, "com.some.game").allowed, false);

  const allowList = buildDeviceProfile({
    policy: buildPolicy({ defaultMode: "allow" }),
    settings: SETTINGS,
  });
  assert.equal(evaluateApp(allowList, "com.some.game").allowed, true);
});

test("`always` ilova umumiy kunlik limitni YEMAYDI", () => {
  // ⚠️ Ota-onaga qo'ng'iroq qilish kunlik limitni yeb qo'ymasligi kerak.
  const messenger = app({ id: id("m"), name: "MBSI", androidPackage: "uz.mbsi.app" });
  const game = app({ id: id("g"), name: "O'yin", androidPackage: "com.game" });

  const profile = buildDeviceProfile({
    policy: buildPolicy({
      dailyLimitMinutes: 60,
      apps: [
        { mode: "always", dailyMinutes: null, app: messenger },
        { mode: "allowed", dailyMinutes: null, app: game },
      ],
    }),
    settings: SETTINGS,
    usageByKey: new Map([
      ["uz.mbsi.app", { minutes: 120 }],
      ["com.game", { minutes: 20 }],
    ]),
  });

  assert.equal(profile.dailyUsedMinutes, 20, "faqat `always` bo'lmagan vaqt sanaladi");
  assert.equal(profile.remainingMinutes, 40);
});

test("katalogda yo'q ilovaning vaqti ham umumiy limitga kiradi", () => {
  // Aks holda oq ro'yxatdagi bo'shliq limitni chetlab o'tish yo'li bo'lardi.
  const profile = buildDeviceProfile({
    policy: buildPolicy({ dailyLimitMinutes: 60 }),
    settings: SETTINGS,
    usageByKey: new Map([["com.unknown.app", { minutes: 45 }]]),
  });

  assert.equal(profile.dailyUsedMinutes, 45);
  assert.equal(profile.remainingMinutes, 15);
});

test("chegaralangan ilovaning qolgan vaqti va tugashi", () => {
  const yt = app();
  const policy = buildPolicy({ apps: [{ mode: "limited", dailyMinutes: 60, app: yt }] });

  const fresh = buildDeviceProfile({ policy, settings: SETTINGS });
  assert.equal(fresh.apps[0].remainingMinutes, 60);
  assert.equal(evaluateApp(fresh, yt.androidPackage).allowed, true);

  const spent = buildDeviceProfile({
    policy,
    settings: SETTINGS,
    usageByKey: new Map([[yt.androidPackage, { minutes: 75 }]]),
  });
  assert.equal(spent.apps[0].remainingMinutes, 0);
  assert.equal(evaluateApp(spent, yt.androidPackage).allowed, false);
  assert.match(evaluateApp(spent, yt.androidPackage).reason, /vaqt tugagan/i);
});

test("vaqtinchalik ochish ilova qoidalarini USTIDAN yozadi, lekin ularni o'chirmaydi", () => {
  const yt = app();
  const now = new Date("2026-09-27T10:00:00.000Z");

  const profile = buildDeviceProfile({
    policy: buildPolicy({ apps: [{ mode: "blocked", dailyMinutes: null, app: yt }] }),
    settings: SETTINGS,
    now,
    unlocks: [
      {
        kind: "full",
        status: "active",
        startsAt: now,
        endsAt: "2026-09-27T12:00:00.000Z",
        reason: "Tug'ilgan kun",
      },
    ],
  });

  assert.ok(profile.unlock, "ochish profilda ko'rinadi");
  assert.equal(evaluateApp(profile, yt.androidPackage).allowed, true);
  // ⚠️ Asosiy qoida JOYIDA qoladi — ochish tugagach qurilma unga qaytadi.
  assert.equal(profile.apps[0].mode, "blocked");
});

test("qo'shimcha daqiqa chegaraga qo'shiladi", () => {
  const yt = app();
  const now = new Date("2026-09-27T10:00:00.000Z");

  const profile = buildDeviceProfile({
    policy: buildPolicy({ apps: [{ mode: "limited", dailyMinutes: 30, app: yt }] }),
    settings: SETTINGS,
    now,
    usageByKey: new Map([[yt.androidPackage, { minutes: 30 }]]),
    unlocks: [
      {
        kind: "app",
        appId: yt.id,
        extraMinutes: 20,
        status: "active",
        startsAt: now,
        endsAt: "2026-09-27T12:00:00.000Z",
      },
    ],
  });

  assert.equal(profile.apps[0].dailyMinutes, 50);
  assert.equal(profile.apps[0].remainingMinutes, 20);
});

test("platformasiga identifikatori yo'q ilova profilga kirmaydi", () => {
  const androidOnly = app({ iosBundleId: null });

  const ios = buildDeviceProfile({
    policy: buildPolicy({ apps: [{ mode: "allowed", dailyMinutes: null, app: androidOnly }] }),
    settings: SETTINGS,
    platform: "ios",
  });

  assert.equal(ios.apps.length, 0);
});

test("oyna yopiq bo'lsa `allowed` ilova ham ochilmaydi, `always` ochiladi", () => {
  const yt = app();
  const mbsi = app({ id: id("8"), name: "MBSI", androidPackage: "uz.mbsi.app", iosBundleId: null });
  // Dushanba 10:00 (Toshkent) = 05:00 UTC
  const now = new Date("2026-09-28T05:00:00.000Z");

  const profile = buildDeviceProfile({
    policy: buildPolicy({
      windows: [{ weekday: 1, startMinute: 900, endMinute: 1200 }], // 15:00–20:00
      apps: [
        { mode: "allowed", dailyMinutes: null, app: yt },
        { mode: "always", dailyMinutes: null, app: mbsi },
      ],
    }),
    settings: SETTINGS,
    now,
  });

  assert.equal(profile.windowOpen, false);
  assert.equal(evaluateApp(profile, yt.androidPackage).allowed, false);
  assert.match(evaluateApp(profile, yt.androidPackage).reason, /vaqti emas/i);
  assert.equal(evaluateApp(profile, "uz.mbsi.app").allowed, true);
});

/* ─────────────────────── QURILMA HOLATI ─────────────────────── */

test("qurilma holati: himoyasiz, oflayn va to'xtatilgan AJRATILADI", () => {
  const now = Date.now();

  assert.equal(deviceHealth({ status: "active", enforcing: true, lastSeenAt: new Date(now) }, 120).key, "healthy");
  assert.equal(deviceHealth({ status: "active", enforcing: false, lastSeenAt: new Date(now) }, 120).key, "degraded");
  assert.equal(
    deviceHealth({ status: "active", enforcing: true, lastSeenAt: new Date(now - 5 * 3600000) }, 120).key,
    "offline",
  );
  assert.equal(deviceHealth({ status: "paused", enforcing: true, lastSeenAt: new Date(now) }, 120).key, "paused");
  assert.equal(deviceHealth({ status: "active", enforcing: true, lastSeenAt: null }, 120).key, "pending");
  assert.equal(deviceHealth({ status: "removed" }, 120).key, "removed");
});
