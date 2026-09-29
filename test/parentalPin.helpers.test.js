const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * OTA-ONA NAZORATI — PIN HASH'I (mobil ilova bilan shartnoma).
 *
 * ⚠️ TEST VEKTORI TZ'DAN (§12): backend, Android va iOS aynan shu natijani
 * berishi shart — policy'dagi hash'ni telefon INTERNETSIZ tekshiradi.
 */

const pin = require("../src/helpers/parentalPin.helpers");

const VECTOR = {
  pin: "1234",
  salt: "000102030405060708090a0b0c0d0e0f",
  iterations: 100000,
  hash: "869e6c8350c5beb0acc399fbaac3b60d220433896b26a647734d0d8f1586e1fa",
};

test("PIN: TZ test vektori — PBKDF2-HMAC-SHA256, 100000, 32 bayt", async () => {
  const result = await pin.hashPin(VECTOR.pin, {
    salt: VECTOR.salt,
    iterations: VECTOR.iterations,
  });
  assert.equal(result.hash, VECTOR.hash);
  assert.equal(result.salt, VECTOR.salt);
  assert.equal(result.iterations, VECTOR.iterations);
});

test("PIN: yangi hash — tasodifiy 16 baytlik salt (32 hex), 64 hex natija", async () => {
  const a = await pin.hashPin("0000", { iterations: 1000 });
  const b = await pin.hashPin("0000", { iterations: 1000 });
  assert.match(a.salt, /^[a-f0-9]{32}$/);
  assert.match(a.hash, /^[a-f0-9]{64}$/);
  assert.notEqual(a.salt, b.salt, "har PIN o'z salti bilan");
  assert.notEqual(a.hash, b.hash);
});

test("PIN: tekshiruv — to'g'ri/noto'g'ri PIN va saqlangan iteratsiya", async () => {
  const stored = {
    pinHash: VECTOR.hash,
    pinSalt: VECTOR.salt,
    pinIterations: VECTOR.iterations,
  };
  assert.equal(await pin.verifyPin("1234", stored), true);
  assert.equal(await pin.verifyPin("1235", stored), false);
  // Iteratsiya QATORDAN olinadi — env o'zgarsa ham eski PIN tekshiriladi
  assert.equal(await pin.verifyPin("1234", { ...stored, pinIterations: 99999 }), false);
});

test("PIN: buzuq qator yoki yaroqsiz kiritish — xato emas, `false`", async () => {
  const stored = { pinHash: VECTOR.hash, pinSalt: VECTOR.salt, pinIterations: 100000 };
  assert.equal(await pin.verifyPin("12345", stored), false);
  assert.equal(await pin.verifyPin(1234, stored), false);
  assert.equal(await pin.verifyPin("1234", { ...stored, pinHash: null }), false);
  assert.equal(await pin.verifyPin("1234", { ...stored, pinSalt: "zz" }), false);
  assert.equal(await pin.verifyPin("1234", { ...stored, pinIterations: 0 }), false);
});

test("PIN: shakl — faqat to'rtta raqam", () => {
  assert.equal(pin.isValidPin("0000"), true);
  assert.equal(pin.isValidPin("9876"), true);
  for (const bad of ["123", "12345", "12a4", " 1234", "1234\n", "", null, 1234, "١٢٣٤"]) {
    assert.equal(pin.isValidPin(bad), false, `rad etilishi kerak: ${JSON.stringify(bad)}`);
  }
});

test("urinishlar: 5-xato → 1 daq, keyin 5, 15, 60 va undan keyin ham 60", () => {
  const min = (n) => pin.lockDurationMs(n) / 60000;
  assert.equal(pin.lockDurationMs(1), null);
  assert.equal(pin.lockDurationMs(4), null);
  assert.equal(min(5), 1);
  assert.equal(min(6), 5);
  assert.equal(min(7), 15);
  assert.equal(min(8), 60);
  assert.equal(min(30), 60);
});

test("appId: sha256(appKey) — 64 hex, deterministik", () => {
  const id = pin.appKeyHash("com.instagram.android");
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(id, pin.appKeyHash("com.instagram.android"));
  assert.notEqual(id, pin.appKeyHash("com.instagram.androiD"));
  assert.equal(pin.isAppId(id), true);
  assert.equal(pin.isAppId(id.toUpperCase()), false);
  assert.equal(pin.isAppId("abc"), false);
});
