/**
 * OTA-ONA NAZORATI — PIN HASH'I VA ILOVA KALITI (sof funksiyalar).
 *
 * ⚠️ ALGORITM — MOBIL ILOVA BILAN SHARTNOMA. PIN hash'i policy'da bolaning
 * telefoniga boradi va telefon bloklangan ilovani ochishda PIN'ni INTERNETSIZ
 * o'zi tekshiradi. Shuning uchun Android (`javax.crypto`) va iOS
 * (`CommonCrypto`) da aynan takrorlanadigan standart tanlangan:
 *
 *     hash = PBKDF2-HMAC-SHA256(pin utf8, salt bytes, iterations, 32 bayt) → hex
 *
 * bcrypt EMAS — uni mobil tomonda qo'llash noqulay. Test vektori
 * (`test/parentalPin.helpers.test.js`) mobil jamoaga beriladi: uchala tomon
 * aynan bir natija berishi shart.
 *
 * ⚠️ PIN'NING O'ZI HECH QAYERDA SAQLANMAYDI va log'ga tushmaydi — faqat hash,
 * salt va iteratsiya soni.
 */

const crypto = require("crypto");
const { promisify } = require("util");

const pbkdf2 = promisify(crypto.pbkdf2);

/** PIN — faqat to'rtta raqam. */
const PIN_PATTERN = /^\d{4}$/;

/** Salt — 16 bayt (32 hex), hash — 32 bayt (64 hex): ustun kengliklari shu. */
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const DIGEST = "sha256";

/** Policy'dagi `pin.algo` — mobil ilova shu qiymatni tekshiradi. */
const PIN_ALGO = "pbkdf2-sha256";

const HEX_64 = /^[a-f0-9]{64}$/;
const HEX_32 = /^[a-f0-9]{32}$/;

/**
 * @param {unknown} pin
 * @returns {boolean}
 */
const isValidPin = (pin) => typeof pin === "string" && PIN_PATTERN.test(pin);

/**
 * PIN hash'ini hisoblaydi.
 *
 * ⚠️ ASINXRON (`crypto.pbkdf2`, `pbkdf2Sync` EMAS): 100 000 iteratsiya
 * ~50 ms CPU — sinxron chaqiruv shu vaqt davomida butun serverni (hamma
 * filialni) to'xtatib qo'yardi.
 *
 * @param {string} pin - `isValidPin` dan o'tgan
 * @param {{ salt?: string, iterations: number }} options - `salt` hex; berilmasa yangisi
 * @returns {Promise<{ hash: string, salt: string, iterations: number }>}
 */
async function hashPin(pin, { salt, iterations }) {
  const saltHex = salt || crypto.randomBytes(SALT_BYTES).toString("hex");
  const derived = await pbkdf2(
    Buffer.from(pin, "utf8"),
    Buffer.from(saltHex, "hex"),
    iterations,
    HASH_BYTES,
    DIGEST,
  );
  return { hash: derived.toString("hex"), salt: saltHex, iterations };
}

/**
 * PIN'ni saqlangan hash bilan solishtiradi.
 *
 * ⚠️ `crypto.timingSafeEqual` — oddiy `===` qaysi baytda farq chiqqanini
 * vaqt orqali oshkor qiladi.
 *
 * ⚠️ Buzuq qator (hash/salt shakli noto'g'ri) — `false`, xato EMAS: PIN
 * tekshiruvi 500 bilan yiqilsa, ota-ona "server buzildi" deb o'ylab, xatoni
 * hech kim ko'rmasdi; `false` esa urinish sifatida sanaladi va bloklaydi.
 *
 * @param {string} pin
 * @param {{ pinHash: string|null, pinSalt: string|null, pinIterations: number }} stored
 * @returns {Promise<boolean>}
 */
async function verifyPin(pin, { pinHash, pinSalt, pinIterations }) {
  if (!isValidPin(pin)) return false;
  if (!HEX_64.test(pinHash || "") || !HEX_32.test(pinSalt || "")) return false;
  if (!Number.isInteger(pinIterations) || pinIterations < 1) return false;

  const { hash } = await hashPin(pin, { salt: pinSalt, iterations: pinIterations });
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(pinHash, "hex"));
}

/**
 * ILOVA KALITINING HASH'I — API'dagi `appId`.
 *
 * iOS tokeni uzun base64 (2 KB gacha): uni yagona indeks va URL'da ishlatib
 * bo'lmaydi. sha256(appKey) → 64 hex, deterministik — qurilma ham o'zi
 * hisoblay oladi.
 *
 * @param {string} appKey
 * @returns {string}
 */
const appKeyHash = (appKey) =>
  crypto.createHash("sha256").update(String(appKey), "utf8").digest("hex");

/** `appId` shakli — 64 kichik hex belgi. */
const isAppId = (value) => typeof value === "string" && HEX_64.test(value);

/**
 * PIN VERSIYASI — parental token shunga bog'lanadi (`pv`): PIN almashsa
 * eski tokenlar yaroqsiz bo'ladi. `pinUpdatedAt` ning ms qiymati.
 *
 * @param {{ pinUpdatedAt?: Date|string|null }|null} settings
 * @returns {number} - PIN hali yo'q bo'lsa 0
 */
const pinVersionOf = (settings) =>
  settings?.pinUpdatedAt ? new Date(settings.pinUpdatedAt).getTime() : 0;

/* ─────────────────────── Urinishlar cheklovi ─────────────────────── */

/** Shuncha ketma-ket xatodan keyin PIN bloklanadi. */
const PIN_MAX_ATTEMPTS = 5;

/** Blok muddatlari: 5-xato → 1 daq, 6 → 5, 7 → 15, 8 va undan keyin → 60. */
const PIN_LOCK_STEPS_MIN = Object.freeze([1, 5, 15, 60]);

/** Shu xatodan boshlab ota-onaga `wrong_pin` ogohlantirishi ketadi. */
const PIN_ALERT_FROM = 3;

/**
 * N-xatodan keyingi blok muddati (ms) yoki `null` (hali bloklanmaydi).
 *
 * ⚠️ BLOKDAN KEYIN HAR XATO YANA BLOKLAYDI (keyingi, uzunroq pog'ona):
 * aks holda har 1 daqiqada yana 5 ta urinish qolib, 10 000 ta PIN bir necha
 * soatda terib chiqilardi.
 *
 * @param {number} failedAttempts - shu xatoni HAM qo'shgan holda
 * @returns {number|null}
 */
function lockDurationMs(failedAttempts) {
  if (failedAttempts < PIN_MAX_ATTEMPTS) return null;
  const step = Math.min(failedAttempts - PIN_MAX_ATTEMPTS, PIN_LOCK_STEPS_MIN.length - 1);
  return PIN_LOCK_STEPS_MIN[step] * 60 * 1000;
}

module.exports = {
  PIN_PATTERN,
  PIN_ALGO,
  PIN_MAX_ATTEMPTS,
  PIN_LOCK_STEPS_MIN,
  PIN_ALERT_FROM,
  isValidPin,
  hashPin,
  verifyPin,
  appKeyHash,
  isAppId,
  pinVersionOf,
  lockDurationMs,
};
