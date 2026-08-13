/**
 * Pul bilan ishlash — moliya domenida float MUTLAQO ishlatilmaydi.
 *
 * Saqlash: Postgres NUMERIC(14,2) → Prisma `Decimal` (decimal.js).
 * Chiqarish: har doim 2 xonali STRING ("450000.00").
 *
 * Ikkita jim xatolik shu fayl bilan oldi olinadi:
 *
 *  1. `d1 + d2` — Decimal'lar uchun string konkatenatsiya ("450000600000"),
 *     xato ham bermaydi. Shuning uchun arifmetika faqat `.plus()/.minus()/
 *     .times()/.div()` orqali, va yig'indi `sumAmounts()` orqali.
 *  2. decimal.js da `toJSON = valueOf`, ya'ni res.json() Decimal'ni string
 *     qiladi — lekin `450000.00` ni `"450000"` ga aylantiradi. Global JSON
 *     replacer qo'yish (42 ta service'ga ko'rinmas ta'sir) o'rniga har bir
 *     javob shu yerdagi `formatAmount()` dan o'tadi.
 */

const { Prisma } = require("../generated/prisma");
const { BadRequestError } = require("../utils/errors");

const { Decimal } = Prisma;

// Decimal(14,2) — 999 999 999 999.99 gacha.
const MAX_AMOUNT = new Decimal("999999999999.99");
const AMOUNT_SCALE = 2;

/**
 * Summani Decimal'ga keltiradi va tekshiradi.
 * Number ham qabul qilinadi (frontend eski kodi uchun), lekin string afzal.
 *
 * @param {string|number|Prisma.Decimal} value
 * @param {string} label - xato xabaridagi maydon nomi
 * @returns {Prisma.Decimal}
 * @throws {BadRequestError}
 */
function parseAmount(value, label = "Summa") {
  if (value == null || value === "") {
    throw new BadRequestError(`${label} kiritilmagan`);
  }

  let amount;
  try {
    amount = new Decimal(value);
  } catch {
    throw new BadRequestError(`${label} noto'g'ri formatda`);
  }

  if (!amount.isFinite()) {
    throw new BadRequestError(`${label} noto'g'ri formatda`);
  }
  if (amount.isNegative()) {
    throw new BadRequestError(`${label} manfiy bo'lishi mumkin emas`);
  }
  if (amount.decimalPlaces() > AMOUNT_SCALE) {
    throw new BadRequestError(
      `${label} ${AMOUNT_SCALE} xonagacha kasr bo'lishi kerak`,
    );
  }
  if (amount.greaterThan(MAX_AMOUNT)) {
    throw new BadRequestError(`${label} juda katta`);
  }

  // Nol qonuniy: grant / stipendiya tarifi.
  return amount;
}

/**
 * API javobi uchun: Decimal → "450000.00".
 * @param {Prisma.Decimal|string|number|null|undefined} value
 * @returns {string|null}
 */
function formatAmount(value) {
  if (value == null) return null;
  const amount = value instanceof Decimal ? value : new Decimal(value);
  return amount.toFixed(AMOUNT_SCALE);
}

/**
 * Decimal'lar yig'indisi. `reduce((a, b) => a + b)` — jim xatolik, shuning
 * uchun yig'indi doim shu funksiya orqali.
 *
 * @param {Array<Prisma.Decimal|string|number>} values
 * @returns {Prisma.Decimal}
 */
function sumAmounts(values = []) {
  return values.reduce(
    (acc, value) => acc.plus(value instanceof Decimal ? value : new Decimal(value)),
    new Decimal(0),
  );
}

/**
 * Foizli chegirma (kelajakdagi chegirma/stipendiya uchun — yaxlitlash
 * qoidasi bitta joyda turishi kerak).
 *
 * @param {Prisma.Decimal} amount
 * @param {string|number} percent - 0..100
 * @returns {Prisma.Decimal}
 */
function applyPercent(amount, percent) {
  const pct = new Decimal(percent);
  return amount
    .minus(amount.times(pct).div(100))
    .toDecimalPlaces(AMOUNT_SCALE, Decimal.ROUND_HALF_UP);
}

module.exports = {
  Decimal,
  MAX_AMOUNT,
  AMOUNT_SCALE,
  parseAmount,
  formatAmount,
  sumAmounts,
  applyPercent,
};
