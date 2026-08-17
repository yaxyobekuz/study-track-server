/**
 * Chegirmalarni bir oylik summaga qo'llash.
 *
 * O'quvchida bir vaqtda bir nechta chegirma bo'lishi mumkin (aka-uka +
 * a'lochi). Ularni qanday birlashtirish — biznes qarori, va u AYNAN shu
 * yerda, bitta joyda turadi.
 *
 * IKKI XOSSA — kelajakda kimdir "tuzataman" deb buzmasligi uchun:
 *
 *   1. Foizlar QO'SHILADI, ko'paytirilmaydi. 20% + 20% = 40% chegirma,
 *      36% emas. Ketma-ket ko'paytirish (0.8 × 0.8) tartibga bog'liq
 *      bo'lmasa ham, ota-onaga tushuntirib bo'lmaydi: "ikkalasi 20% dan,
 *      lekin jami 36%" — bu javob maktabda ishlamaydi.
 *
 *   2. Foizlar fixed'dan OLDIN qo'llanadi. Teskarisi bo'lsa, qat'iy
 *      summali chegirmaning o'zi ham foizga qisqarib ketardi.
 *
 * Natijada hisob tartibga bog'liq emas va determinlashgan: qatorlar qanday
 * kelishidan qat'i nazar bir xil summa chiqadi.
 *
 * YAXLITLASH BIR MARTA — foizdan keyin. Har bir chegirmani alohida
 * yaxlitlash tiyinlar bo'yicha siljish beradi.
 *
 * `nominalAmount` vs `appliedAmount`: 400 000 so'mlik oyga 500 000 so'mlik
 * qat'iy chegirma berilsa (tarif narxi tushgan), summa manfiy bo'lmaydi —
 * lekin farq JIM qolmasligi kerak, shuning uchun ikkalasi ham snapshot'ga
 * yoziladi.
 */

const {
  Decimal,
  AMOUNT_SCALE,
  applyPercent,
  sumAmounts,
} = require("./money.helpers");
const { BadRequestError } = require("../utils/errors");

const TYPES = ["percent", "fixed"];
const MAX_PERCENT = 100;

/** Foydalanuvchiga ko'rsatiladigan yorliqlar. */
const TYPE_LABELS = {
  percent: "Foiz",
  fixed: "Qat'iy summa",
};

/**
 * Chegirma turini tekshiradi.
 * @param {string} value
 * @returns {"percent"|"fixed"}
 */
function parseDiscountType(value) {
  const type = String(value || "").trim();
  if (!TYPES.includes(type)) {
    throw new BadRequestError(
      `Chegirma turi noto'g'ri. Mumkin: ${TYPES.map((t) => TYPE_LABELS[t]).join(", ")}`,
    );
  }
  return type;
}

/**
 * Chegirma qiymatini tekshiradi — foiz uchun 0..100, qat'iy summa uchun
 * oddiy pul cheklovi (`parseAmount` bilan bir xil qoidalar).
 *
 * @param {string|number} value
 * @param {"percent"|"fixed"} type
 * @returns {Prisma.Decimal}
 */
function parseDiscountValue(value, type) {
  if (value == null || value === "") {
    throw new BadRequestError("Chegirma miqdori kiritilmagan");
  }

  let amount;
  try {
    amount = new Decimal(value);
  } catch {
    throw new BadRequestError("Chegirma miqdori noto'g'ri formatda");
  }

  if (!amount.isFinite() || amount.isNegative()) {
    throw new BadRequestError("Chegirma miqdori manfiy bo'lishi mumkin emas");
  }
  if (amount.decimalPlaces() > AMOUNT_SCALE) {
    throw new BadRequestError(
      `Chegirma miqdori ${AMOUNT_SCALE} xonagacha kasr bo'lishi kerak`,
    );
  }
  if (type === "percent" && amount.greaterThan(MAX_PERCENT)) {
    throw new BadRequestError("Foizli chegirma 100 dan oshmasligi kerak");
  }
  if (amount.isZero()) {
    throw new BadRequestError("Chegirma miqdori noldan katta bo'lishi kerak");
  }

  return amount;
}

/**
 * Chegirmalarni bazaviy summaga qo'llaydi.
 *
 * @param {Prisma.Decimal} baseAmount - tarif narxi (chegirmagacha)
 * @param {Array<{id: string, name: string, type: "percent"|"fixed", value: Prisma.Decimal|string}>} discounts
 * @param {{maxPercent?: number}} [options] - FinanceSettings.maxDiscountPercent
 * @returns {{
 *   baseAmount: Prisma.Decimal,
 *   discountAmount: Prisma.Decimal,
 *   finalAmount: Prisma.Decimal,
 *   percentTotal: Prisma.Decimal,
 *   percentCapped: boolean,
 *   snapshot: Array<object>
 * }}
 */
function applyDiscounts(baseAmount, discounts = [], options = {}) {
  const { maxPercent = MAX_PERCENT } = options;
  const base = baseAmount instanceof Decimal ? baseAmount : new Decimal(baseAmount);

  if (discounts.length === 0 || base.lessThanOrEqualTo(0)) {
    return {
      baseAmount: base,
      discountAmount: new Decimal(0),
      finalAmount: base,
      percentTotal: new Decimal(0),
      percentCapped: false,
      snapshot: [],
    };
  }

  const cap = new Decimal(Math.min(maxPercent, MAX_PERCENT));

  const rawPercent = sumAmounts(
    discounts.filter((d) => d.type === "percent").map((d) => d.value),
  );
  const percentTotal = Decimal.min(rawPercent, cap);
  const percentCapped = rawPercent.greaterThan(cap);

  // 1-qadam: foiz (bir marta yaxlitlash)
  const afterPercent = percentTotal.isZero() ? base : applyPercent(base, percentTotal);

  // 2-qadam: qat'iy summalar, so'ng nolga qisqartirish
  const fixedTotal = sumAmounts(
    discounts.filter((d) => d.type === "fixed").map((d) => d.value),
  );
  const finalAmount = Decimal.max(new Decimal(0), afterPercent.minus(fixedTotal));

  // discountAmount — HAKAM. Snapshot ulushlari shundan taqsimlanadi,
  // teskarisi emas: aks holda ulushlar yig'indisi jamiga teng bo'lmasdi.
  const discountAmount = base.minus(finalAmount);

  return {
    baseAmount: base,
    discountAmount,
    finalAmount,
    percentTotal,
    percentCapped,
    snapshot: buildSnapshot(base, discounts, discountAmount),
  };
}

/**
 * Har bir chegirmaning ulushi.
 *
 * AYIRMA USULI: ulushlar ketma-ket hisoblanadi va OXIRGISIGA qoldiq
 * beriladi, shuning uchun `Σ appliedAmount === discountAmount`
 * KONSTRUKSIYA BO'YICHA to'g'ri. Har birini alohida yaxlitlash
 * 333333.33 ga uchta 33.33% da 3 tiyin farq berardi.
 *
 * `nominalAmount` — chegirmaning "so'ralgan" summasi; `appliedAmount` —
 * haqiqatda berilgani. Cheklov (maxPercent) yoki nolga qisqarish sodir
 * bo'lsa ikkalasi farq qiladi va support buni tushuntira oladi.
 */
function buildSnapshot(base, discounts, discountAmount) {
  const rows = discounts.map((d) => {
    const value = d.value instanceof Decimal ? d.value : new Decimal(d.value);
    return {
      discountId: d.id ?? null,
      name: d.name ?? "",
      type: d.type,
      value: value.toFixed(AMOUNT_SCALE),
      // Foiz — bazadan, qat'iy summa — o'zi
      nominalAmount:
        d.type === "percent"
          ? base.times(value).div(100).toDecimalPlaces(AMOUNT_SCALE, Decimal.ROUND_HALF_UP)
          : value,
    };
  });

  // Taqsimot bazasi: foizlilar percentTotal ichida, qat'iylar esa
  // foizdan keyingi summadan yeydi — nominal yig'indisi jamidan katta
  // bo'lishi mumkin (cheklov yoki nolga qisqarish), shuning uchun
  // proporsional taqsimlaymiz.
  const nominalTotal = sumAmounts(rows.map((r) => r.nominalAmount));

  let remaining = discountAmount;
  const out = rows.map((row, index) => {
    const isLast = index === rows.length - 1;

    let applied;
    if (isLast) {
      applied = remaining; // qoldiq — yig'indi aynan to'g'ri chiqadi
    } else if (nominalTotal.isZero()) {
      applied = new Decimal(0);
    } else {
      applied = discountAmount
        .times(row.nominalAmount)
        .div(nominalTotal)
        .toDecimalPlaces(AMOUNT_SCALE, Decimal.ROUND_HALF_UP);
      // Qoldiqdan oshib ketmasin (yaxlitlash yuqoriga ketgan holat)
      applied = Decimal.min(applied, remaining);
      remaining = remaining.minus(applied);
    }

    return {
      ...row,
      nominalAmount: row.nominalAmount.toFixed(AMOUNT_SCALE),
      appliedAmount: applied.toFixed(AMOUNT_SCALE),
    };
  });

  return out;
}

module.exports = {
  TYPES,
  TYPE_LABELS,
  MAX_PERCENT,
  parseDiscountType,
  parseDiscountValue,
  applyDiscounts,
};
