const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * TOPSHIRIQ PUSH — xabar matni va "kimga boradi" qoidasi.
 *
 * `push.service` HAQIQIY kodi ishlaydi; platforma bazasi xotiradagi soxta,
 * Firebase esa yuborilgan xabarlarni yozib oluvchi soxta bilan almashtiriladi.
 */

/* ───────────────────────── Soxta muhit ───────────────────────── */

process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 = Buffer.from(
  JSON.stringify({ project_id: "test-project" }),
).toString("base64");

const db = { devices: [], sessions: [] };
const sent = [];
// Shu tokenlar Firebase'da "ro'yxatdan chiqqan" deb javob oladi
const deadTokens = new Set();
// Shu tokenlar "buzuq token" deb javob oladi (ilova o'chirilgani EMAS)
const invalidTokens = new Set();
// `true` bo'lsa Firebase butunlay yiqiladi (tarmoq/kvota)
let firebaseDown = false;

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

/** Prisma `where` ning shu yerda ishlatiladigan qismi. */
function matches(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond && !cond.in.includes(value)) return false;
      if ("not" in cond && value === cond.not) return false;
      if ("lt" in cond && !(value < cond.lt)) return false;
      return true;
    }
    return value === cond;
  });
}

fakeModule("../src/config/platformPrisma", {
  pushDevice: {
    findMany: async ({ where } = {}) =>
      db.devices.filter((d) => matches(d, where)).map((d) => ({ ...d })),
    count: async ({ where } = {}) => db.devices.filter((d) => matches(d, where)).length,
    deleteMany: async ({ where }) => {
      const before = db.devices.length;
      db.devices = db.devices.filter((d) => !matches(d, where));
      return { count: before - db.devices.length };
    },
  },
  userSession: {
    findMany: async ({ where }) => db.sessions.filter((s) => matches(s, where)),
    updateMany: async ({ where, data }) => {
      const rows = db.sessions.filter((s) => matches(s, where));
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    },
  },
});

fakeModule("firebase-admin/app", {
  getApps: () => [],
  cert: (json) => json,
  initializeApp: () => ({ name: "study-track-push" }),
});

fakeModule("firebase-admin/messaging", {
  getMessaging: () => ({
    sendEachForMulticast: async (message) => {
      if (firebaseDown) throw new Error("ECONNRESET");
      sent.push(message);
      const responses = message.tokens.map((token) => {
        if (deadTokens.has(token)) {
          return {
            success: false,
            error: { code: "messaging/registration-token-not-registered", message: "gone" },
          };
        }
        if (invalidTokens.has(token)) {
          return {
            success: false,
            error: { code: "messaging/invalid-registration-token", message: "bad" },
          };
        }
        return { success: true };
      });
      return {
        responses,
        successCount: responses.filter((r) => r.success).length,
        failureCount: responses.filter((r) => !r.success).length,
      };
    },
  }),
});

const pushService = require("../src/services/push.service");
const { TASK_PUSH_EVENTS, buildTaskPush } = require("../src/helpers/taskPush.helpers");

/* ───────────────────────── Yordamchilar ───────────────────────── */

const ALI = "a".repeat(24);
const VALI = "v".repeat(24);
const FUTURE = new Date(Date.now() + 86400000);

const TASK = {
  id: "t".repeat(24),
  title: "Hisobotni topshirish",
  status: "pending",
  assignee: ALI,
  // 2026-05-21 14:30 Toshkent
  dueDate: new Date("2026-05-21T09:30:00Z"),
};

function reset() {
  db.devices = [];
  db.sessions = [];
  sent.length = 0;
  deadTokens.clear();
  invalidTokens.clear();
  firebaseDown = false;
}

const HOUR = 3600 * 1000;

/** Tirik seans — oxirgi so'rov `seenAgoMs` oldin. */
const liveSession = (jti, seenAgoMs = 3 * HOUR) => ({
  jti,
  endReason: "active",
  expiresAt: FUTURE,
  lastSeenAt: new Date(Date.now() - seenAgoMs),
});

const sessionOf = (jti) => db.sessions.find((s) => s.jti === jti);

/* ───────────────────────── Xabar matni ───────────────────────── */

test("yangi topshiriq — sarlavha va muddat yagona sana formatida", () => {
  const push = buildTaskPush(TASK_PUSH_EVENTS.CREATED, TASK, { branchId: "b1" });

  assert.equal(push.title, "Yangi topshiriq");
  assert.equal(push.body, "Hisobotni topshirish\nMuddat: 21-may, 2026 14:30");
  assert.equal(push.channelId, "tasks");
  assert.deepEqual(push.data, {
    type: "task",
    event: "created",
    taskId: TASK.id,
    status: "pending",
    branchId: "b1",
  });
});

test("rad etildi — sabab, yangi muddat va jarima ko'rsatiladi", () => {
  const push = buildTaskPush(
    TASK_PUSH_EVENTS.REJECTED,
    { ...TASK, status: "pending_rejected" },
    { reason: "Fayl yo'q", deadlineChanged: true, penaltyPoints: 2 },
  );

  assert.equal(push.title, "Topshiriq rad etildi");
  assert.equal(
    push.body,
    "Hisobotni topshirish\nYangi muddat: 21-may, 2026 14:30\nSabab: Fayl yo'q\nJarima: 2 ball",
  );
  assert.equal(push.data.status, "pending_rejected");
});

test("to'xtatildi va yakunlandi — muddat qayta ko'rsatilmaydi", () => {
  const stopped = buildTaskPush(TASK_PUSH_EVENTS.STOPPED, TASK, { reason: "Kerak emas" });
  assert.equal(stopped.title, "Topshiriq to'xtatildi");
  assert.equal(stopped.body, "Hisobotni topshirish\nSabab: Kerak emas");

  const completed = buildTaskPush(TASK_PUSH_EVENTS.COMPLETED, TASK, { reason: "Zo'r" });
  assert.equal(completed.title, "Topshiriq muvaffaqiyatli yakunlandi");
  assert.equal(completed.body, "Hisobotni topshirish\nIzoh: Zo'r");
});

test("noma'lum hodisa jim o'tib ketmaydi", () => {
  assert.throws(() => buildTaskPush("extended", TASK));
});

/* ───────────────────────── Kimga boradi ───────────────────────── */

test("faqat ijrochining TIRIK seansli qurilmalariga boradi", async () => {
  reset();
  db.sessions = [
    liveSession("live"),
    { ...liveSession("revoked"), endReason: "revoked" },
    { ...liveSession("expired"), expiresAt: new Date(Date.now() - 1000) },
    // 5 kun so'rov kelmagan — `auth.middleware` baribir 401 qaytaradi
    liveSession("idle", 5 * 24 * HOUR),
  ];
  db.devices = [
    { token: "ali-live", userId: ALI, jti: "live" },
    { token: "ali-revoked", userId: ALI, jti: "revoked" },
    { token: "ali-expired", userId: ALI, jti: "expired" },
    { token: "ali-idle", userId: ALI, jti: "idle" },
    // `jti` siz eski token — auth.middleware kabi o'tkaziladi
    { token: "ali-legacy", userId: ALI, jti: null },
    { token: "vali-live", userId: VALI, jti: "live" },
  ];

  const result = await pushService.sendToUsers(
    [ALI],
    buildTaskPush(TASK_PUSH_EVENTS.CREATED, TASK, { branchId: "b1" }),
  );

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].tokens.sort(), ["ali-legacy", "ali-live"]);
  assert.equal(sent[0].android.notification.channelId, "tasks");
  assert.equal(result.sent, 2);
});

test("ro'yxatdan chiqqan token bazadan o'chiriladi, qolganlari saqlanadi", async () => {
  reset();
  db.devices = [
    { token: "old-phone", userId: ALI, jti: null },
    { token: "new-phone", userId: ALI, jti: null },
  ];
  deadTokens.add("old-phone");

  const result = await pushService.sendToUsers([ALI], {
    title: "t",
    body: "b",
    data: { count: 3, empty: null },
  });

  assert.deepEqual(result, { sent: 1, failed: 1, removed: 1, closed: 0 });
  assert.deepEqual(db.devices.map((d) => d.token), ["new-phone"]);
  // FCM `data` faqat string qabul qiladi, null kalit tashlab yuboriladi
  assert.deepEqual(sent[0].data, { count: "3" });
});

test("qurilmasi yo'q odamga Firebase chaqirilmaydi", async () => {
  reset();
  const result = await pushService.sendToUsers([VALI], { title: "t", body: "b" });

  assert.equal(result.skipped, "no_devices");
  assert.equal(sent.length, 0);
});

/* ───────────────────────── Ilova o'chirilgan seans ───────────────────────── */

test("token yangilangan: bitta seansda 2 token, eskisi not-registered — seans TIRIK qoladi", async () => {
  reset();
  db.sessions = [liveSession("s1")];
  db.devices = [
    { token: "old-token", userId: ALI, jti: "s1" },
    { token: "new-token", userId: ALI, jti: "s1" },
  ];
  deadTokens.add("old-token");

  const result = await pushService.sendToUsers([ALI], { title: "t", body: "b" });

  assert.equal(result.removed, 1);
  assert.equal(result.closed, 0);
  assert.equal(sessionOf("s1").endReason, "active");
  assert.deepEqual(db.devices.map((d) => d.token), ["new-token"]);
});

test("ilova o'chirilgan: seansning yagona tokeni not-registered — seans `app_removed`", async () => {
  reset();
  db.sessions = [liveSession("s1"), liveSession("s2")];
  db.devices = [
    { token: "removed-app", userId: ALI, jti: "s1" },
    { token: "other-phone", userId: ALI, jti: "s2" },
  ];
  deadTokens.add("removed-app");

  const result = await pushService.sendToUsers([ALI], { title: "t", body: "b" });

  assert.equal(result.closed, 1);
  assert.equal(sessionOf("s1").endReason, "app_removed");
  assert.ok(sessionOf("s1").endedAt instanceof Date);
  assert.equal(sessionOf("s2").endReason, "active", "boshqa telefonga tegilmaydi");
});

test("invalid-registration-token: qator o'chadi, seans TIRIK qoladi", async () => {
  reset();
  db.sessions = [liveSession("s1")];
  db.devices = [{ token: "garbled", userId: ALI, jti: "s1" }];
  invalidTokens.add("garbled");

  const result = await pushService.sendToUsers([ALI], { title: "t", body: "b" });

  assert.equal(result.removed, 1);
  assert.equal(result.closed, 0);
  assert.equal(db.devices.length, 0);
  assert.equal(sessionOf("s1").endReason, "active");
});

test("oxirgi soatda so'rov kelgan seans not-registered bo'lsa ham YOPILMAYDI", async () => {
  reset();
  // Token yangilangan-u, yangisi serverga yetib bormagan: ilova ishlab turibdi
  db.sessions = [liveSession("s1", 10 * 60 * 1000)];
  db.devices = [{ token: "stale", userId: ALI, jti: "s1" }];
  deadTokens.add("stale");

  const result = await pushService.sendToUsers([ALI], { title: "t", body: "b" });

  assert.equal(result.removed, 1);
  assert.equal(result.closed, 0);
  assert.equal(sessionOf("s1").endReason, "active");
});

test("jti siz eski token not-registered — qator o'chadi, hech qanday seans yopilmaydi", async () => {
  reset();
  db.sessions = [liveSession("s1")];
  db.devices = [{ token: "legacy", userId: ALI, jti: null }];
  deadTokens.add("legacy");

  const result = await pushService.sendToUsers([ALI], { title: "t", body: "b" });

  assert.equal(result.removed, 1);
  assert.equal(result.closed, 0);
  assert.equal(sessionOf("s1").endReason, "active");
});

test("Firebase yiqilsa sendToUsers ham, probeDevices ham xato tashlamaydi", async () => {
  reset();
  db.sessions = [liveSession("s1")];
  db.devices = [{ token: "t1", userId: ALI, jti: "s1" }];
  firebaseDown = true;

  const sendResult = await pushService.sendToUsers([ALI], { title: "t", body: "b" });
  assert.deepEqual(sendResult, { sent: 0, failed: 0, removed: 0, closed: 0 });

  const probeResult = await pushService.probeDevices();
  assert.equal(probeResult.sent, 0);
  assert.equal(probeResult.closed, 0);
  assert.equal(sessionOf("s1").endReason, "active");
  assert.equal(db.devices.length, 1, "tarmoq xatosida token o'chirilmaydi");
});

/* ───────────────────────── Ovozsiz tekshiruv (ping) ───────────────────────── */

test("probeDevices: faqat tirik seansli qurilmalarga OVOZSIZ ping, o'likni yopadi", async () => {
  reset();
  db.sessions = [
    liveSession("alive"),
    liveSession("uninstalled"),
    { ...liveSession("logged-out"), endReason: "logout" },
  ];
  db.devices = [
    { token: "p-alive", userId: ALI, jti: "alive" },
    { token: "p-uninstalled", userId: VALI, jti: "uninstalled" },
    { token: "p-logged-out", userId: VALI, jti: "logged-out" },
  ];
  deadTokens.add("p-uninstalled");

  const result = await pushService.probeDevices();

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].tokens.sort(), ["p-alive", "p-uninstalled"]);
  // Foydalanuvchiga hech narsa ko'rinmaydi: `notification` bloki yo'q
  assert.equal(sent[0].notification, undefined);
  assert.equal(sent[0].android.notification, undefined);
  assert.deepEqual(sent[0].data, { type: "ping" });
  assert.equal(sent[0].apns.headers["apns-push-type"], "background");

  assert.equal(result.probed, 2);
  assert.equal(result.removed, 1);
  assert.equal(result.closed, 1);
  assert.equal(sessionOf("uninstalled").endReason, "app_removed");
  assert.equal(sessionOf("alive").endReason, "active");
});

test("forgetSessions: bir nechta seansning qurilmalari bitta so'rovda o'chadi", async () => {
  reset();
  db.devices = [
    { token: "a", userId: ALI, jti: "s1" },
    { token: "b", userId: ALI, jti: "s2" },
    { token: "c", userId: ALI, jti: "s3" },
  ];

  const result = await pushService.forgetSessions(["s1", "s2", null, "s1"]);

  assert.equal(result.removed, 2);
  assert.deepEqual(db.devices.map((d) => d.token), ["c"]);
  assert.deepEqual(await pushService.forgetSessions([]), { removed: 0 });
});
