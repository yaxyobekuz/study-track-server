const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * SEANS SIYOSATI — o'quvchi ko'p qurilmada, xodim avvalgidek.
 *
 * `openSession` va `dedupeLiveSessions` HAQIQIY kodi ishlaydi, faqat
 * platforma bazasi xotiradagi soxta bilan almashtiriladi: qoida "qaysi
 * seans yopildi" degan natija bilan tekshirilishi kerak, ichki funksiya
 * chaqiruvlari bilan emas.
 */

/* ───────────────────────── Xotiradagi baza ───────────────────────── */

/** Prisma `where` ning shu yerda ishlatiladigan qismi. */
function matches(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond && !cond.in.includes(value)) return false;
      if ("not" in cond && value === cond.not) return false;
      if ("gt" in cond && !(value > cond.gt)) return false;
      if ("gte" in cond && !(value >= cond.gte)) return false;
      if ("lte" in cond && !(value <= cond.lte)) return false;
      return true;
    }
    return value === cond;
  });
}

const db = { sessions: [], alerts: [] };
let seq = 0;

const fakePlatformPrisma = {
  userSession: {
    findMany: async ({ where } = {}) =>
      db.sessions.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    findFirst: async ({ where } = {}) => db.sessions.find((row) => matches(row, where)) ?? null,
    count: async ({ where } = {}) => db.sessions.filter((row) => matches(row, where)).length,
    create: async ({ data }) => {
      const now = new Date(Date.now() + seq++);
      const row = {
        endReason: "active",
        deviceId: null,
        multiDevice: false,
        createdAt: now,
        lastSeenAt: now,
        ...data,
      };
      db.sessions.push(row);
      return { ...row };
    },
    updateMany: async ({ where, data }) => {
      const rows = db.sessions.filter((row) => matches(row, where));
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    },
  },
  loginAttempt: { count: async () => 0 },
  securityAlert: {
    upsert: async ({ create }) => {
      db.alerts.push(create);
      return create;
    },
  },
  branch: { findMany: async () => [] },
};

const platformPath = require.resolve("../src/config/platformPrisma");
require.cache[platformPath] = {
  id: platformPath,
  filename: platformPath,
  loaded: true,
  exports: fakePlatformPrisma,
};

const security = require("../src/services/security.service");
const { clientDeviceId, clientInfo } = require("../src/helpers/request.helpers");

/* ───────────────────────── Yordamchilar ───────────────────────── */

const BRANCH = "b".repeat(24);
const STUDENT = { id: "s".repeat(24), username: "ali", role: "student" };
const TEACHER = { id: "t".repeat(24), username: "vali", role: "teacher" };

const PHONE_A = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const PHONE_B = "f0e1d2c3b4a5968778695a4b3c2d1e0f";

const ANDROID = "Chrome · Android";

const reset = () => {
  db.sessions = [];
  db.alerts = [];
};

let jtiSeq = 0;
const login = (user, client) =>
  security.openSession({
    user,
    branchId: BRANCH,
    jti: `jti${jtiSeq++}`,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    client: { ip: "10.0.0.5", ...client },
  });

const liveIds = (userId) =>
  db.sessions
    .filter((row) => row.userId === userId && row.endReason === "active")
    .map((row) => row.id);

/* ───────────────────────── O'quvchi ───────────────────────── */

test("o'quvchi: ikkinchi telefondan kirish birinchisini YOPMAYDI (bir xil yorliq)", async () => {
  reset();
  const first = await login(STUDENT, { channel: "student", device: ANDROID, deviceId: PHONE_A });
  const second = await login(STUDENT, { channel: "student", device: ANDROID, deviceId: PHONE_B });

  assert.deepEqual(liveIds(STUDENT.id).sort(), [first.id, second.id].sort());
  assert.equal(first.multiDevice, true);
});

test("o'quvchi: identifikatorsiz eski mijoz ham hech kimni yopmaydi", async () => {
  reset();
  const first = await login(STUDENT, { channel: "student", device: ANDROID });
  const second = await login(STUDENT, { channel: "student", device: ANDROID });

  assert.equal(liveIds(STUDENT.id).length, 2);
  assert.ok(liveIds(STUDENT.id).includes(first.id) && liveIds(STUDENT.id).includes(second.id));
});

test("o'quvchi: AYNI brauzerdan qayta kirish faqat o'zining eski seansini yangilaydi", async () => {
  reset();
  const phoneA = await login(STUDENT, { channel: "student", device: ANDROID, deviceId: PHONE_A });
  const phoneB = await login(STUDENT, { channel: "student", device: ANDROID, deviceId: PHONE_B });
  const phoneAagain = await login(STUDENT, { channel: "student", device: ANDROID, deviceId: PHONE_A });

  assert.deepEqual(liveIds(STUDENT.id).sort(), [phoneB.id, phoneAagain.id].sort());
  assert.equal(db.sessions.find((row) => row.id === phoneA.id).endReason, "superseded");
});

test("o'quvchi: turli telefonlar admin panelga 'bir vaqtda bir nechta seans' bo'lib boradi", async () => {
  reset();
  await login(STUDENT, { channel: "student", device: ANDROID, deviceId: PHONE_A });
  await login(STUDENT, { channel: "student", device: ANDROID, deviceId: PHONE_B });

  const concurrent = db.alerts.filter((alert) => alert.type === "concurrent_session");
  assert.equal(concurrent.length, 1);
  assert.match(concurrent[0].detail, /#A1B2C3/);
  assert.match(concurrent[0].detail, /#F0E1D2/);
});

test("o'quvchi: joriy etish kuni — identifikatorsiz eski seans bilan soxta ogohlantirish yo'q", async () => {
  reset();
  await login(STUDENT, { channel: "student", device: ANDROID });
  await login(STUDENT, { channel: "student", device: ANDROID, deviceId: PHONE_A });

  assert.equal(db.alerts.filter((a) => a.type === "concurrent_session").length, 0);
  assert.equal(liveIds(STUDENT.id).length, 2, "baribir hech narsa yopilmaydi");
});

/* ───────────────────────── Xodim (o'zgarmagan) ───────────────────────── */

test("o'qituvchi: bir turdagi qurilmadan yangi kirish eskisini yopadi (avvalgidek)", async () => {
  reset();
  const first = await login(TEACHER, { channel: "teacher", device: ANDROID, deviceId: PHONE_A });
  const second = await login(TEACHER, { channel: "teacher", device: ANDROID, deviceId: PHONE_B });

  assert.deepEqual(liveIds(TEACHER.id), [second.id]);
  assert.equal(db.sessions.find((row) => row.id === first.id).endReason, "superseded");
  assert.equal(second.multiDevice, false);
});

test("o'qituvchi: boshqa turdagi qurilma yopilmaydi (avvalgidek)", async () => {
  reset();
  await login(TEACHER, { channel: "teacher", device: ANDROID });
  await login(TEACHER, { channel: "teacher", device: "Chrome · Windows" });

  assert.equal(liveIds(TEACHER.id).length, 2);
});

test("qo'shimcha 'student' roli xodimni cheklovdan chiqarmaydi", () => {
  assert.equal(security.allowsMultiDevice({ role: "teacher", extraRoles: ["student"] }), false);
  assert.equal(security.allowsMultiDevice({ role: "student" }), true);
  assert.equal(security.allowsMultiDevice(null), false);
});

/* ───────────────────────── Kechki supurgi ───────────────────────── */

test("supurgi: o'quvchining ikki telefoni tegilmaydi, xodimning takrori yopiladi", async () => {
  reset();
  const future = new Date(Date.now() + 3600 * 1000);
  const base = { branchId: BRANCH, endReason: "active", expiresAt: future, ip: "10.0.0.5" };

  db.sessions.push(
    { ...base, id: "s1", userId: STUDENT.id, channel: "student", device: ANDROID, deviceId: PHONE_A, multiDevice: true, createdAt: new Date(3) },
    { ...base, id: "s2", userId: STUDENT.id, channel: "student", device: ANDROID, deviceId: PHONE_B, multiDevice: true, createdAt: new Date(2) },
    { ...base, id: "s3", userId: STUDENT.id, channel: "student", device: ANDROID, deviceId: null, multiDevice: true, createdAt: new Date(1) },
    { ...base, id: "t1", userId: TEACHER.id, channel: "teacher", device: ANDROID, multiDevice: false, createdAt: new Date(2) },
    { ...base, id: "t2", userId: TEACHER.id, channel: "teacher", device: ANDROID, multiDevice: false, createdAt: new Date(1) },
  );
  // Supurgi `createdAt desc` bo'yicha o'qiydi — soxta baza tartiblamaydi
  db.sessions.sort((a, b) => b.createdAt - a.createdAt);

  const closed = await security.dedupeLiveSessions();

  assert.equal(closed, 1);
  assert.equal(db.sessions.find((row) => row.id === "t2").endReason, "superseded");
  assert.deepEqual(liveIds(STUDENT.id).sort(), ["s1", "s2", "s3"]);
});

/* ───────────────────────── Sof yordamchilar ───────────────────────── */

test("countOrigins: identifikator bo'yicha sanaydi, eski seansni yutib yuboradi", () => {
  const a = { channel: "student", device: ANDROID, deviceId: PHONE_A };
  const b = { channel: "student", device: ANDROID, deviceId: PHONE_B };
  const legacySameLabel = { channel: "student", device: ANDROID };
  const legacyOther = { channel: "student", device: "Safari · iOS" };

  assert.equal(security.countOrigins([a, b]), 2);
  assert.equal(security.countOrigins([a, legacySameLabel]), 1);
  assert.equal(security.countOrigins([legacySameLabel, legacyOther]), 2);
  assert.equal(security.countOrigins([a, a]), 1);
  assert.equal(security.countOrigins([]), 0);
});

test("sameBrowser: identifikator bir tomonda yo'q bo'lsa — hech qachon teng emas", () => {
  const withId = { channel: "student", device: ANDROID, deviceId: PHONE_A };
  assert.equal(security.sameBrowser(withId, { ...withId }), true);
  assert.equal(security.sameBrowser(withId, { channel: "student", device: ANDROID }), false);
  assert.equal(security.sameBrowser({}, {}), false);
  assert.equal(security.sameBrowser(withId, { ...withId, channel: "teacher" }), false);
});

test("deviceTagOf: qisqa belgi, to'liq identifikator emas", () => {
  assert.equal(security.deviceTagOf(PHONE_A), "#A1B2C3");
  assert.equal(security.deviceTagOf(null), null);
});

test("clientDeviceId: faqat to'g'ri shakldagi sarlavha qabul qilinadi", () => {
  const req = (value) => ({ headers: { "x-device-id": value } });

  assert.equal(clientDeviceId(req(PHONE_A)), PHONE_A);
  assert.equal(clientDeviceId(req("qisqa")), null);
  assert.equal(clientDeviceId(req("x".repeat(65))), null);
  assert.equal(clientDeviceId(req("abc'; DROP TABLE--xxxxxxxx")), null);
  assert.equal(clientDeviceId({ headers: {} }), null);
  assert.equal(clientInfo(req(PHONE_A)).deviceId, PHONE_A);
});
