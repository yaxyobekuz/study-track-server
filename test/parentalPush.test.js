const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * OTA-ONA NAZORATI — PUSH QAYSI TELEFONGA BORADI.
 *
 * Ota-ona ilovasi va bolaning o'quvchi ilovasi — BITTA `userId`. Ularni
 * faqat seans kanali ajratadi: jim `parental_policy` faqat bola
 * telefoniga, `parental_alert` / `parental_request` faqat ota-ona
 * telefoniga (TZ §12 qabul mezonlari).
 *
 * `push.service` HAQIQIY kodi ishlaydi; platforma bazasi va Firebase —
 * xotiradagi soxtalar (`taskPush.test.js` bilan bir xil yondashuv).
 */

process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 = Buffer.from(
  JSON.stringify({ project_id: "test-project" }),
).toString("base64");

const db = { devices: [], sessions: [] };
const sent = [];

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

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
    updateMany: async () => ({ count: 0 }),
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
      const responses = message.tokens.map(() => ({ success: true }));
      return { responses, successCount: responses.length, failureCount: 0 };
    },
  }),
});

const pushService = require("../src/services/push.service");
const parentalPush = require("../src/helpers/parentalPush.helpers");

/* ───────────────────────── Yordamchilar ───────────────────────── */

const STUDENT = "s".repeat(24);
const OTHER = "o".repeat(24);
const FUTURE = new Date(Date.now() + 86400000);

const session = (jti, channel, extra = {}) => ({
  jti,
  channel,
  endReason: "active",
  expiresAt: FUTURE,
  lastSeenAt: new Date(Date.now() - 60 * 1000),
  ...extra,
});

function seed() {
  sent.length = 0;
  db.sessions = [
    session("child", "student"),
    session("parent", "parent"),
    session("parent-closed", "parent", { endReason: "logout" }),
    session("child-2", "student"),
    session("other-child", "student"),
  ];
  db.devices = [
    { token: "child-phone", userId: STUDENT, jti: "child" },
    { token: "child-tablet", userId: STUDENT, jti: "child-2" },
    { token: "parent-phone", userId: STUDENT, jti: "parent" },
    { token: "parent-old-phone", userId: STUDENT, jti: "parent-closed" },
    // Kanali noma'lum (eski token) — kanal filtri bilan HECH QAYERGA bormaydi
    { token: "legacy-phone", userId: STUDENT, jti: null },
    // Seansi topilmagan — kanali noma'lum
    { token: "orphan-phone", userId: STUDENT, jti: "missing" },
    { token: "other-phone", userId: OTHER, jti: "other-child" },
  ];
}

const tokensSent = () => sent.flatMap((m) => m.tokens).sort();

/* ───────────────────────── Marshrut ───────────────────────── */

test("jim policy push — FAQAT bolaning tirik 'student' seansli qurilmalariga", async () => {
  seed();
  const result = await pushService.sendToUsers(
    [STUDENT],
    parentalPush.policyChanged({ version: 17, branchId: "b1" }),
  );

  assert.deepEqual(tokensSent(), ["child-phone", "child-tablet"]);
  assert.equal(result.sent, 2);
});

test("ota-onaga ogohlantirish — FAQAT tirik 'parent' seansli qurilmaga", async () => {
  seed();
  await pushService.sendToUsers(
    [STUDENT],
    parentalPush.alert({ event: "permission_revoked", name: "Aziz", deviceId: "d1", branchId: "b1" }),
  );
  assert.deepEqual(tokensSent(), ["parent-phone"]);

  seed();
  await pushService.sendToUsers(
    [STUDENT],
    parentalPush.unlockRequested({ requestId: "r1", minutes: 30, name: "Aziz" }),
  );
  assert.deepEqual(tokensSent(), ["parent-phone"]);
});

test("ruxsat berildi — bolaning telefoniga, ko'rinadigan xabar", async () => {
  seed();
  await pushService.sendToUsers(
    [STUDENT],
    parentalPush.unlockGranted({
      requestId: "r1",
      appId: "a".repeat(64),
      appKey: "com.instagram.android",
      appName: "Instagram",
      minutes: 30,
      until: new Date("2026-09-28T10:00:00Z"),
      branchId: "b1",
    }),
  );

  assert.deepEqual(tokensSent(), ["child-phone", "child-tablet"]);
  const [message] = sent;
  assert.equal(message.notification.title, "Ruxsat berildi");
  assert.equal(message.notification.body, "«Instagram» 30 daqiqaga ochildi");
  assert.deepEqual(message.data, {
    type: "parental_unlock",
    requestId: "r1",
    appId: "a".repeat(64),
    appKey: "com.instagram.android",
    minutes: "30",
    until: "2026-09-28T10:00:00.000Z",
    branchId: "b1",
  });
});

test("kanalsiz yuborish — hamma tirik qurilmaga, OTA-ONA TELEFONIDAN TASHQARI", async () => {
  // Maktab push'lari (qurilma nazorati, baholar tahlili) bolaga atalgan —
  // ota-onaning ekranida "Telefoningizga yangi qoida qo'llandi" chiqmasin
  seed();
  await pushService.sendToUsers([STUDENT], { title: "t", body: "b", data: { type: "device_policy" } });
  assert.deepEqual(tokensSent(), ["child-phone", "child-tablet", "legacy-phone", "orphan-phone"]);
});

test("ovozsiz tekshiruv (ping) — ota-ona ilovasiga HAM (o'chirilgan ilova aniqlansin)", async () => {
  seed();
  const result = await pushService.probeDevices();
  assert.ok(tokensSent().includes("parent-phone"));
  assert.ok(!tokensSent().includes("parent-old-phone"), "yopilgan seans — yo'q");
  assert.equal(result.probed, 6);
});

test("rad javobi — bolaning telefoniga, ko'rinadigan xabar", async () => {
  seed();
  await pushService.sendToUsers(
    [STUDENT],
    parentalPush.unlockDenied({
      requestId: "r1",
      appId: "a".repeat(64),
      appKey: "com.instagram.android",
      appName: "Instagram",
      branchId: "b1",
    }),
  );
  assert.deepEqual(tokensSent(), ["child-phone", "child-tablet"]);
  assert.equal(sent[0].notification.body, "Ota-onangiz «Instagram» uchun ruxsat bermadi");
  assert.equal(sent[0].data.type, "parental_unlock_denied");
});

/* ───────────────────────── Jim xabar shakli ───────────────────────── */

test("jim xabar: notification YO'Q, Android high, APNs background + content-available", async () => {
  seed();
  await pushService.sendToUsers(
    [STUDENT],
    parentalPush.policyChanged({ version: 17, branchId: "b1" }),
  );

  const [message] = sent;
  assert.equal(message.notification, undefined);
  assert.deepEqual(message.data, { type: "parental_policy", version: "17", branchId: "b1" });
  assert.deepEqual(message.android, { priority: "high" });
  assert.deepEqual(message.apns.headers, {
    "apns-push-type": "background",
    "apns-priority": "5",
  });
  assert.equal(message.apns.payload.aps.contentAvailable, true);
});

test("ko'rinadigan xabar: notification + Android kanali 'parental'", async () => {
  seed();
  await pushService.sendToUsers(
    [STUDENT],
    parentalPush.alert({ event: "offline", name: "Aziz", deviceId: "d1", branchId: "b1" }),
  );

  const [message] = sent;
  assert.deepEqual(message.notification, {
    title: "Telefon aloqaga chiqmadi",
    body: "Aziz telefoni 24 soatdan beri aloqaga chiqmadi",
  });
  assert.equal(message.android.notification.channelId, "parental");
  assert.deepEqual(message.data, {
    type: "parental_alert",
    event: "offline",
    deviceId: "d1",
    branchId: "b1",
  });
});

/* ───────────────────────── Matnlar ───────────────────────── */

test("ogohlantirish matnlari — ism bo'lmasa 'Farzandingiz', noma'lum hodisa jim o'tmaydi", () => {
  const revoked = parentalPush.alert({ event: "permission_revoked" });
  assert.equal(revoked.body, "Farzandingiz telefonida ota-ona nazorati o'chirildi");

  const wrong = parentalPush.alert({ event: "wrong_pin", name: "Aziz", attempts: 4 });
  assert.equal(wrong.body, "Aziz: PIN ketma-ket 4 marta noto'g'ri kiritildi");

  for (const event of Object.values(parentalPush.PARENTAL_ALERT_EVENTS)) {
    const push = parentalPush.alert({ event, name: "Aziz" });
    assert.ok(push.title && push.body, event);
    assert.deepEqual(push.channels, ["parent"]);
  }

  assert.throws(() => parentalPush.alert({ event: "something_else" }));
});

test("ruxsat so'rovi matni — ilova nomi bilan va butun telefon uchun", () => {
  const app = parentalPush.unlockRequested({
    requestId: "r1",
    appKey: "com.zhiliaoapp.musically",
    appName: "TikTok",
    minutes: 15,
    name: "Aziz",
  });
  assert.equal(app.body, "Aziz «TikTok» uchun 15 daqiqa so'rayapti");

  const all = parentalPush.unlockRequested({ requestId: "r2", minutes: 60, name: "Aziz" });
  assert.equal(all.body, "Aziz telefonni 60 daqiqaga ochishni so'rayapti");
  assert.equal(all.data.appKey, undefined);
});
