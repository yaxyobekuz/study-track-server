const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * TANGA OQIMINING YO'NALISHI.
 *
 * Qabul mezonlari:
 *   - `CoinTransactionType` ning HAR BIR qiymati tasniflangan (kirim /
 *     qaytarib olish / hisobga kirmaydi) — yangi tur jimgina tushib
 *     qolmaydi
 *   - do'kon xaridi, premium va jarima kamaytirish haftalik hisobga
 *     KIRMAYDI (summa bazada musbat yotadi, ya'ni oddiy `_sum` ularni ham
 *     kirim deb sanardi)
 *   - qo'lda olib qo'yilgan tanga topilganidan AYIRILADI
 */

process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db?schema=public";

const {
  COIN_EARNING_TYPES,
  COIN_EARNING_REVERSAL_TYPES,
  COIN_IGNORED_TYPES,
  COIN_PERIOD_TYPES,
  earnedDelta,
} = require("../src/helpers/coin.helpers");
const { $Enums } = require("../src/generated/prisma");

const ALL_TYPES = Object.keys($Enums.CoinTransactionType);

test("tasnif TO'LIQ: sxemadagi har bir tur aynan bitta guruhda", () => {
  const groups = [
    COIN_EARNING_TYPES,
    COIN_EARNING_REVERSAL_TYPES,
    COIN_IGNORED_TYPES,
  ];
  const classified = groups.flat();

  // Takror yo'q — bir tur ikki guruhda bo'lsa hisob ikki marta qo'llanardi
  assert.equal(new Set(classified).size, classified.length);

  // Sxemada bor-u, tasniflanmagan tur yo'q (yangi tur qo'shilsa shu yiqiladi)
  assert.deepEqual(
    ALL_TYPES.filter((type) => !classified.includes(type)),
    [],
  );

  // Tasnifda bor-u, sxemada yo'q tur ham yo'q (olib tashlangan enum qiymati)
  assert.deepEqual(
    classified.filter((type) => !ALL_TYPES.includes(type)),
    [],
  );
});

test("SQL filtri — faqat kirim va qaytarib olish turlari", () => {
  assert.deepEqual(
    [...COIN_PERIOD_TYPES].sort(),
    [...COIN_EARNING_TYPES, ...COIN_EARNING_REVERSAL_TYPES].sort(),
  );
  for (const type of COIN_IGNORED_TYPES) {
    assert.equal(COIN_PERIOD_TYPES.includes(type), false, type);
  }
});

test("kirim turlari — summa musbat qo'shiladi", () => {
  assert.equal(earnedDelta("daily", 120), 120);
  assert.equal(earnedDelta("weekly_school_bonus", 100), 100);
  assert.equal(earnedDelta("weekly_class_bonus", 20), 20);
  assert.equal(earnedDelta("manual_give", 50), 50);
  assert.equal(earnedDelta("season_absolute_reward", 1000), 1000);
});

test("qo'lda olib qo'yilgan tanga — AYIRILADI (summa bazada musbat)", () => {
  assert.equal(earnedDelta("manual_take", 50), -50);
});

test("sarflash, qaytim va filiallararo o'tkazma — hisobga kirmaydi", () => {
  assert.equal(earnedDelta("market_purchase", 300), 0);
  assert.equal(earnedDelta("market_refund", 300), 0);
  assert.equal(earnedDelta("premium_purchase", 500), 0);
  assert.equal(earnedDelta("fine_reduction_purchase", 80), 0);
  // ⚠️ Ikki yo'nalishli tur: summasi manfiy ham bo'ladi, baribir 0
  assert.equal(earnedDelta("branch_transfer", -400), 0);
  assert.equal(earnedDelta("branch_transfer", 400), 0);
});

test("bo'sh summa yiqitmaydi", () => {
  assert.equal(earnedDelta("daily", null), 0);
  assert.equal(earnedDelta("daily", undefined), 0);
  assert.equal(earnedDelta("noma'lum_tur", 10), 0);
});
