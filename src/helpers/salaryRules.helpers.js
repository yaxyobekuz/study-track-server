/**
 * XODIM OYLIGI — USTAMA QOIDALARI (sof matematika, DB'siz).
 *
 * Ustama qoidalari: [{ label, type: 'fixed' | 'percent', value }].
 *   fixed   — qat'iy summa qo'shiladi
 *   percent — FIKSA maoshdan foiz qo'shiladi (ustamali oylikdan EMAS)
 *
 * ⚠️ Foizlar QO'SHILADI (kompaund emas): 10% + 5% = fiksa'ning 15% i.
 *    Chunki har qoida mustaqil, ketma-ket bir-birining ustiga chiqmaydi.
 */

const { Decimal, formatAmount } = require("./money.helpers");
const { BadRequestError } = require("../utils/errors");

const ALLOWANCE_TYPES = ["fixed", "percent"];

/**
 * Kiritilgan ustamalar ro'yxatini tekshiradi va tozalaydi.
 * @param {Array} list
 * @returns {Array<{label:string, type:string, value:number}>}
 */
const normalizeAllowances = (list) => {
  if (list == null) return [];
  if (!Array.isArray(list)) {
    throw new BadRequestError("Ustama qoidalari ro'yxat bo'lishi kerak");
  }

  return list.map((item, index) => {
    const label = String(item?.label ?? "").trim();
    const type = String(item?.type ?? "").trim();
    if (!ALLOWANCE_TYPES.includes(type)) {
      throw new BadRequestError(
        `${index + 1}-qoida: tur "fixed" yoki "percent" bo'lishi kerak`,
      );
    }

    const value = Number(item?.value);
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestError(`${index + 1}-qoida: qiymat noldan katta bo'lishi kerak`);
    }
    if (type === "percent" && value > 1000) {
      throw new BadRequestError(`${index + 1}-qoida: foiz juda katta`);
    }

    return { label: label || (type === "percent" ? "Ustama" : "Qo'shimcha"), type, value };
  });
};

/**
 * Ustamalar summasini FIKSA maoshdan hisoblaydi.
 * @param {Decimal|string|number} fixedAmount - fiksa maosh
 * @param {Array} allowances - normalizeAllowances natijasi
 * @returns {{ total: Decimal, breakdown: Array }}
 */
const computeAllowances = (fixedAmount, allowances = []) => {
  const fixed = new Decimal(fixedAmount || 0);
  let total = new Decimal(0);
  const breakdown = [];

  for (const rule of allowances) {
    let amount;
    if (rule.type === "percent") {
      amount = fixed.times(rule.value).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    } else {
      amount = new Decimal(rule.value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }
    total = total.plus(amount);
    breakdown.push({
      label: rule.label,
      type: rule.type,
      value: rule.value,
      amount: formatAmount(amount),
    });
  }

  return { total, breakdown };
};

module.exports = {
  ALLOWANCE_TYPES,
  normalizeAllowances,
  computeAllowances,
};
