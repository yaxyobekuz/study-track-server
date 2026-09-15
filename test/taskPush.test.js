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

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const inList = (value, cond) =>
  cond && typeof cond === "object" && "in" in cond ? cond.in.includes(value) : value === cond;

fakeModule("../src/config/platformPrisma", {
  pushDevice: {
    findMany: async ({ where }) =>
      db.devices.filter((d) => inList(d.userId, where.userId)).map((d) => ({ ...d })),
    deleteMany: async ({ where }) => {
      const before = db.devices.length;
      db.devices = db.devices.filter((d) => !inList(d.token, where.token));
      return { count: before - db.devices.length };
    },
  },
  userSession: {
    findMany: async ({ where }) => db.sessions.filter((s) => inList(s.jti, where.jti)),
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
      sent.push(message);
      const responses = message.tokens.map((token) =>
        deadTokens.has(token)
          ? {
              success: false,
              error: { code: "messaging/registration-token-not-registered", message: "gone" },
            }
          : { success: true },
      );
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
}

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
    { jti: "live", endReason: "active", expiresAt: FUTURE },
    { jti: "revoked", endReason: "revoked", expiresAt: FUTURE },
    { jti: "expired", endReason: "active", expiresAt: new Date(Date.now() - 1000) },
  ];
  db.devices = [
    { token: "ali-live", userId: ALI, jti: "live" },
    { token: "ali-revoked", userId: ALI, jti: "revoked" },
    { token: "ali-expired", userId: ALI, jti: "expired" },
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

  assert.deepEqual(result, { sent: 1, failed: 1, removed: 1 });
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
