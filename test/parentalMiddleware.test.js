const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * OTA-ONA NAZORATI — MARSHRUT DARVOZALARI (TZ §12 qabul mezonlari).
 *
 *   - o'quvchi ilovasidan (`student` seansi) yoki tokensiz [T] amal → 403
 *   - parental token boshqa seansda (boshqa `jti`) ishlamaydi
 *   - muddati o'tgan token ishlamaydi
 *   - oddiy access token parental token o'rnida ishlamaydi (va aksincha)
 */

process.env.JWT_SECRET = "test-secret-for-parental";
process.env.PARENTAL_TOKEN_TTL_MIN = "15";

// Filial bazasi — xotiradagi sozlama qatori (PIN versiyasi tekshiruvi uchun)
const PIN_AT = new Date("2026-09-28T09:00:00.000Z");
let settingsRow = { pinHash: "h".repeat(64), pinUpdatedAt: PIN_AT };
const prismaPath = require.resolve("../src/config/prisma");
require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: { parentalSettings: { findUnique: async () => settingsRow } },
};

const jwt = require("jsonwebtoken");
const {
  generateToken,
  verifyToken,
  generateParentalToken,
  verifyParentalToken,
} = require("../src/utils/jwt");
const {
  requireStudentAccount,
  requireDeviceId,
  rejectParentChannel,
  requireParentChannel,
  requireParentalToken,
} = require("../src/middleware/parental.middleware");

const USER = "u".repeat(24);
const BRANCH = "b".repeat(24);
const JTI = "a".repeat(32);

/** Soxta so'rov — `protect` dan keyingi holat. */
const reqOf = ({ channel = "parent", jti = JTI, token, role = "student", user = USER } = {}) => ({
  user: { id: user, role },
  branch: { id: BRANCH },
  tokenJti: jti,
  sessionChannel: channel,
  headers: token ? { "x-parental-token": token } : {},
});

/** Middleware'ni chaqiradi (sinxron ham, asinxron ham): `null` — o'tdi, aks holda xato. */
function run(middleware, req) {
  return new Promise((resolve) => {
    try {
      const result = middleware(req, {}, (error) => resolve(error ?? null));
      // asyncHandler `next(error)` bilan qaytaradi; sinxron middleware esa tashlaydi
      if (result && typeof result.then === "function") result.catch(resolve);
    } catch (error) {
      resolve(error);
    }
  });
}

const validToken = (pinVersion = PIN_AT.getTime()) =>
  generateParentalToken({ userId: USER, jti: JTI, branchId: BRANCH, pinVersion }).token;

/* ───────────────────────── Parental token ───────────────────────── */

test("[T]: to'g'ri token, o'sha seans, ota-ona ilovasi — o'tadi va req.parental to'ladi", async () => {
  const req = reqOf({ token: validToken() });
  assert.equal(await run(requireParentalToken, req), null);
  assert.equal(req.parental.jti, JTI);
  assert.ok(req.parental.expiresAt > new Date());
});

test("[T]: tokensiz — 403 parental_token_required", async () => {
  const error = await run(requireParentalToken, reqOf());
  assert.equal(error.statusCode, 403);
  assert.equal(error.details.reason, "parental_token_required");
});

test("[T]: o'quvchi ilovasidan (student seansi) — token bo'lsa ham 403", async () => {
  const error = await run(requireParentalToken, reqOf({ channel: "student", token: validToken() }));
  assert.equal(error.statusCode, 403);
  assert.equal(error.details.reason, "parent_channel_required");

  // Kanali noma'lum eski token ham
  const legacy = await run(requireParentalToken, reqOf({ channel: null, token: validToken() }));
  assert.equal(legacy.details.reason, "parent_channel_required");
});

test("[T]: boshqa seans (boshqa jti) — 403 parental_token_invalid", async () => {
  const error = await run(requireParentalToken, reqOf({ jti: "b".repeat(32), token: validToken() }));
  assert.equal(error.statusCode, 403);
  assert.equal(error.details.reason, "parental_token_invalid");

  // `jti` siz eski access token bilan ham bog'lanmaydi
  const noJti = await run(requireParentalToken, reqOf({ jti: null, token: validToken() }));
  assert.equal(noJti.details.reason, "parental_token_invalid");
});

test("[T]: boshqa foydalanuvchi yoki boshqa filial — 403", async () => {
  const otherUser = await run(requireParentalToken, reqOf({ user: "x".repeat(24), token: validToken() }));
  assert.equal(otherUser.details.reason, "parental_token_invalid");

  const otherBranch = generateParentalToken({
    userId: USER,
    jti: JTI,
    branchId: "c".repeat(24),
    pinVersion: PIN_AT.getTime(),
  });
  const error = await run(requireParentalToken, reqOf({ token: otherBranch.token }));
  assert.equal(error.details.reason, "parental_token_invalid");
});

test("[T]: muddati o'tgan token — 403", async () => {
  // Haqiqiy token, soat esa 16 daqiqa oldinga suriladi
  const token = validToken();
  const decoded = jwt.decode(token);
  assert.ok(decoded.exp - decoded.iat === 15 * 60, "umr — 15 daqiqa");

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 16 * 60 * 1000;
    const error = await run(requireParentalToken, reqOf({ token }));
    assert.equal(error.details.reason, "parental_token_invalid");
  } finally {
    Date.now = realNow;
  }
});

test("access token ↔ parental token bir-birining o'rnida ishlamaydi", async () => {
  const access = generateToken(USER, BRANCH, JTI);
  assert.equal(verifyParentalToken(access), null);

  const error = await run(requireParentalToken, reqOf({ token: access }));
  assert.equal(error.details.reason, "parental_token_invalid");

  // Parental token Bearer sifatida ham o'tmaydi (boshqa kalit)
  assert.equal(verifyToken(validToken()), null);

  // Kalitni bilmasdan qalbakilashtirilgan token rad
  const forged = jwt.sign({ purpose: "parental", sub: USER, jti: JTI, br: BRANCH }, "wrong-key");
  assert.equal(verifyParentalToken(forged), null);
});

test("[T]: PIN almashgan yoki tiklangan — eski token darhol 403", async () => {
  const token = validToken();
  assert.equal(await run(requireParentalToken, reqOf({ token })), null);

  settingsRow = { pinHash: "h".repeat(64), pinUpdatedAt: new Date(PIN_AT.getTime() + 60000) };
  try {
    const error = await run(requireParentalToken, reqOf({ token }));
    assert.equal(error.details.reason, "parental_token_invalid");

    // Yangi PIN bilan olingan token o'tadi
    const fresh = validToken(PIN_AT.getTime() + 60000);
    assert.equal(await run(requireParentalToken, reqOf({ token: fresh })), null);

    // PIN umuman yo'q bo'lsa (o'chirilgan qator) — hech qaysi token o'tmaydi
    settingsRow = null;
    const none = await run(requireParentalToken, reqOf({ token: fresh }));
    assert.equal(none.details.reason, "parental_token_invalid");
  } finally {
    settingsRow = { pinHash: "h".repeat(64), pinUpdatedAt: PIN_AT };
  }
});

/* ───────────────────────── Kanal va hisob ───────────────────────── */

test("PIN amallari faqat ota-ona ilovasidan; qurilma yo'llari faqat undan TASHQARI", async () => {
  assert.equal(await run(requireParentChannel, reqOf({ channel: "parent" })), null);
  assert.equal(
    (await run(requireParentChannel, reqOf({ channel: "student" }))).details.reason,
    "parent_channel_required",
  );

  assert.equal(await run(rejectParentChannel, reqOf({ channel: "student" })), null);
  // Eski/sarlavhasiz o'quvchi ilovasi (`admin` yoki `null`) — o'tadi
  assert.equal(await run(rejectParentChannel, reqOf({ channel: "admin" })), null);
  assert.equal(await run(rejectParentChannel, reqOf({ channel: null })), null);
  assert.equal(
    (await run(rejectParentChannel, reqOf({ channel: "parent" }))).details.reason,
    "child_channel_required",
  );
});

test("faqat o'quvchi hisobi — asosiy rol bo'yicha", async () => {
  assert.equal(await run(requireStudentAccount, reqOf({ role: "student" })), null);
  const error = await run(requireStudentAccount, reqOf({ role: "teacher" }));
  assert.equal(error.statusCode, 403);
  assert.equal(error.details.reason, "student_account_required");
});

test("X-Device-Id majburiy va shakli tekshiriladi", async () => {
  const ok = { headers: { "x-device-id": "a1b2c3d4e5f6a7b8c9d0" } };
  assert.equal(await run(requireDeviceId, ok), null);
  assert.equal(ok.parentalDeviceId, "a1b2c3d4e5f6a7b8c9d0");

  for (const headers of [{}, { "x-device-id": "short" }, { "x-device-id": "bad id with spaces!!" }]) {
    const error = await run(requireDeviceId, { headers });
    assert.equal(error.statusCode, 400);
    assert.equal(error.details.reason, "device_id_required");
  }
});
