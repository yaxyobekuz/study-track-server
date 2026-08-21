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
 *
 * ── IKKI CLIENT, IKKI DECIMAL KLASSI ─────────
 *
 * Filiallashtirishdan keyin ikkita generatsiya qilingan Prisma client bor
 * (filial va platforma) va HAR BIRI o'z `runtime/library.js` nusxasini olib
 * yuradi. Ya'ni `platformDecimal instanceof Decimal` → `false`, garchi
 * qiymat butunlay to'g'ri bo'lsa ham.
 *
 * O'QISH xavfsiz: `new Decimal(foreignDecimal)` ishlaydi (ichki shakl bir xil)
 * va `toDecimal()` shuni aniq qilib turadi.
 *
 * ⚠️ YOZISH: bu yerdan chiqqan `Decimal` ni to'g'ridan-to'g'ri PLATFORMA
 * modeliga (`TariffVersion.monthlyAmount`, `Discount.value`) BERMANG — avval
 * `formatAmount()` bilan STRING'ga aylantiring. Prisma string'ni ikkala
 * tomonda ham qabul qiladi.
 */

const { Prisma } = require("../generated/prisma");
const { BadRequestError, InternalServerError } = require("../utils/errors");

const { Decimal } = Prisma;

/**
 * Har qanday summani SHU client'ning Decimal'iga keltiradi.
 *
 * `x instanceof Decimal ? x : new Decimal(x)` naqshining nomlangan shakli —
 * boshqa client'dan kelgan Decimal ham to'g'ri o'tishi uchun (yuqoridagi
 * izohga qarang).
 *
 * @param {Prisma.Decimal|string|number} value
 * @returns {Prisma.Decimal}
 */
function toDecimal(value) {
  return value instanceof Decimal ? value : new Decimal(value);
}

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
  return toDecimal(value).toFixed(AMOUNT_SCALE);
}

/**
 * Decimal'lar yig'indisi. `reduce((a, b) => a + b)` — jim xatolik, shuning
 * uchun yig'indi doim shu funksiya orqali.
 *
 * @param {Array<Prisma.Decimal|string|number>} values
 * @returns {Prisma.Decimal}
 */
function sumAmounts(values = []) {
  return values.reduce((acc, value) => acc.plus(toDecimal(value)), new Decimal(0));
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

/**
 * Summani birlikkacha PASTGA yaxlitlaydi (proratsiya uchun).
 *
 * ATAYLAB PASTGA: 367 712 → 367 000. Farq maktab zarariga ketadi — bu
 * biznes qarori, texnik emas. Proratsiya o'quvchi hayotida BIR MARTA
 * (kirishda) ishlagani uchun maksimal yo'qotish har kirish uchun
 * (unit − 1) so'm, har oy uchun EMAS.
 *
 * `unit <= 1` bo'lsa yaxlitlash yo'q — faqat 2 xonaga qisqartiriladi.
 *
 * @param {Prisma.Decimal} amount
 * @param {number} unit - masalan 1000
 * @returns {Prisma.Decimal}
 */
function floorToUnit(amount, unit) {
  const exact = amount.toDecimalPlaces(AMOUNT_SCALE, Decimal.ROUND_DOWN);
  if (!Number.isInteger(unit) || unit <= 1) return exact;

  return exact.div(unit).floor().times(unit);
}

/**
 * Ishorali summa — harakatlar daftari (`AccountEntry.amount`) uchun: + kirim, − chiqim.
 *
 * `parseAmount` manfiyni rad etadi, shuning uchun daftarga yozadigan kod
 * yo money helper'ini butunlay chetlab o'tardi (float qaytib keladigan
 * birinchi joy), yo uni noqulay o'rab ishlatardi.
 *
 * @param {string|number|Prisma.Decimal} value
 * @param {string} label
 * @returns {Prisma.Decimal}
 * @throws {BadRequestError}
 */
function parseSignedAmount(value, label = "Summa") {
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
  if (amount.decimalPlaces() > AMOUNT_SCALE) {
    throw new BadRequestError(
      `${label} ${AMOUNT_SCALE} xonagacha kasr bo'lishi kerak`,
    );
  }
  if (amount.abs().greaterThan(MAX_AMOUNT)) {
    throw new BadRequestError(`${label} juda katta`);
  }

  return amount;
}

/**
 * Daftardagi ishora — KELISHUV emas, INVARIANT.
 *
 * `payment` musbat, `payment_void` manfiy bo'lishi tipdan kelib chiqadi;
 * teskarisi yozilsa hisob qoldig'i jimgina buziladi va buni faqat
 * financeReconcile job kechqurun topardi. Shuning uchun yozish paytida
 * tekshiriladi.
 *
 * `adjustment` — yagona istisno: sanoq farqi ikkala tomonga ham bo'lishi mumkin.
 */
const ENTRY_SIGNS = {
  payment: 1,
  payment_void: -1,
  transfer_in: 1,
  transfer_out: -1,
  refund: -1,
  refund_void: 1,
  adjustment: 0, // ± ikkalasi ham qonuniy
};

/**
 * @param {string} type - AccountEntryType
 * @param {Prisma.Decimal} amount - ishorali
 * @throws {InternalServerError} - bu foydalanuvchi xatosi emas, kod xatosi
 */
function assertSignMatchesType(type, amount) {
  const expected = ENTRY_SIGNS[type];

  if (expected === undefined) {
    throw new InternalServerError(`Daftar yozuvi turi noma'lum: ${type}`);
  }
  if (amount.isZero()) {
    throw new InternalServerError("Daftar yozuvi summasi nol bo'lishi mumkin emas");
  }
  if (expected === 0) return;

  const actual = amount.isNegative() ? -1 : 1;
  if (actual !== expected) {
    throw new InternalServerError(
      `Daftar yozuvi ishorasi turiga mos emas: ${type} → ${amount.toFixed(AMOUNT_SCALE)}`,
    );
  }
}

module.exports = {
  Decimal,
  toDecimal,
  MAX_AMOUNT,
  AMOUNT_SCALE,
  ENTRY_SIGNS,
  parseAmount,
  parseSignedAmount,
  formatAmount,
  sumAmounts,
  applyPercent,
  floorToUnit,
  assertSignMatchesType,
};
