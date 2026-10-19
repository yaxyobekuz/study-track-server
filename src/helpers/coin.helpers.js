/**
 * TANGA OQIMINING YO'NALISHI — YAGONA MANBA.
 *
 * `CoinTransaction.amount` bazada HAR DOIM MUSBAT yotadi, yo'nalishni esa
 * TUR belgilaydi: do'kon xaridi ham (`market_purchase`), qo'lda berilgan
 * tanga ham (`manual_give`) musbat son bo'lib saqlanadi. Yagona istisno —
 * `branch_transfer`: u ikki yo'nalishli va summasi ISHORALI (manba filialda
 * manfiy, maqsadda musbat — `finance.md` §12).
 *
 * Shuning uchun "bu o'quvchi shu haftada qancha tanga topdi" degan savolga
 * oddiy `_sum: { amount }` bilan javob berib bo'lmaydi: do'kon xaridi va
 * premium obuna ham qo'shilib, raqam ikki barobar chiqib ketardi. Tasnif
 * SHU YERDA, bitta joyda turadi.
 *
 * ⚠️ O'quvchi panelidagi `transactionTypes.data.js` — AYNI tasnifning
 * ko'rsatish uchun mo'ljallangan nusxasi (tranzaksiya qatorini "+/−" bilan
 * bo'yash uchun). HISOB esa faqat shu yerda: yangi tur qo'shilsa ikkalasi
 * ham ko'rib chiqiladi.
 */

/**
 * TOPILGAN TANGA — o'quvchiga maktab tomonidan BERILGAN tangalar.
 *
 * ⚠️ `market_refund` ataylab yo'q: u sarflangan tanganing qaytimi, topilgan
 * tanga emas. Sarflash davr hisobiga umuman kirmagani uchun (pastga qarang)
 * qaytimni kirim deb sanash "buyurtma berdim — bekor qildim" bilan haftalik
 * raqamni ko'tarish yo'lini ochib qo'yardi.
 */
const COIN_EARNING_TYPES = Object.freeze([
  "daily",
  "weekly_school_bonus",
  "weekly_class_bonus",
  "holiday_bonus",
  "manual_give",
  "season_absolute_reward",
  "season_class_top_reward",
]);

/**
 * BERILGAN TANGANI QAYTARIB OLISH — topilganidan AYIRILADI.
 *
 * "Hammadan 10 tanga olindi" — bu sarflash emas, berilgan tangani orqaga
 * qaytarish. Shuning uchun davr hisobida u kirimni kamaytiradi va natija
 * manfiy ham bo'lishi mumkin (ekranda shunday ko'rinadi — yashirilmaydi).
 */
const COIN_EARNING_REVERSAL_TYPES = Object.freeze(["manual_take"]);

/**
 * DAVR HISOBIGA KIRMAYDIGAN TURLAR — SARFLASH, QAYTIM va O'TKAZMA.
 *
 * Ataylab RO'YXAT bilan: shunda `CoinTransactionType` ga yangi tur
 * qo'shilsa test yiqiladi (`test/coin.helpers.test.js`) va qaror qabul
 * qilinadi. "Qolgani hisoblanmaydi" deb qoldirilsa, yangi mukofot turi
 * jimgina haftalik ustunga tushmay qolardi.
 *
 * Filiallararo o'tkazma `getCoinStats` dagi "tarqatilgan tanga" hisobida
 * ham shu sababdan chiqarib tashlangan: u topilgan tanga emas, o'quvchi
 * bilan ko'chgan qoldiq (`finance.md` §12).
 */
const COIN_IGNORED_TYPES = Object.freeze([
  "market_purchase",
  "market_refund",
  "premium_purchase",
  "fine_reduction_purchase",
  "branch_transfer",
]);

/** DAVR HISOBIGA KIRADIGAN TURLAR (SQL filtri uchun). */
const COIN_PERIOD_TYPES = Object.freeze([
  ...COIN_EARNING_TYPES,
  ...COIN_EARNING_REVERSAL_TYPES,
]);

const EARNING_SET = new Set(COIN_EARNING_TYPES);
const REVERSAL_SET = new Set(COIN_EARNING_REVERSAL_TYPES);

/**
 * Tur bo'yicha davr hisobiga qo'shiladigan ulush.
 *
 * @param {string} type - `CoinTransactionType`
 * @param {number|null} amount - bazadagi (musbat) summa
 * @returns {number} kirim uchun `+amount`, qaytarib olish uchun `-amount`,
 *   qolgan turlar uchun `0`
 */
const earnedDelta = (type, amount) => {
  const value = Number(amount) || 0;
  if (EARNING_SET.has(type)) return value;
  if (REVERSAL_SET.has(type)) return -value;
  return 0;
};

module.exports = {
  COIN_EARNING_TYPES,
  COIN_EARNING_REVERSAL_TYPES,
  COIN_IGNORED_TYPES,
  COIN_PERIOD_TYPES,
  earnedDelta,
};
