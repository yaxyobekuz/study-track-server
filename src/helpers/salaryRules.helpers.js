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

/**
 * OYLIKDAN USHLAB QOLISH — YALPI oylikdan (fiksa + soat + ustamalar).
 *
 * Qoidalar (biznes qarori):
 *   · percent — YALPIDAN foiz; bir nechta foiz QO'SHILADI (kompaund emas:
 *     10% + 5% = yalpining 15%), ustama foizlari bilan bir xil qoida;
 *   · fixed   — qat'iy summa;
 *   · hours   — dars soati × xodimning SOAT NARXI (toifa yoki qo'lda).
 *     Narx yo'q (faqat fiksa) xodimdan USHLANMAYDI — `noRate: true` bilan
 *     qaytadi: fiksadan "soat narxi" o'ylab topilsa, bu yangi siyosat bo'lardi;
 *   · jami ushlab qolish YALPIDAN OSHMAYDI — oylik manfiy bo'lolmaydi.
 *     Chegaraga urilgan qator `capped: true` bilan qaytadi: jim qolsa,
 *     "10% yozgan edim, nega 3% ushlandi" degan savolga javob bo'lmasdi.
 *
 * ⚠️ Chegara YARATILISH TARTIBIDA qo'llanadi (chaqiruvchi `createdAt asc`
 * beradi): avval yozilgan ushlab qolish avval to'liq olinadi.
 *
 * @param {Decimal|string|number} gross - yalpi oylik
 * @param {Array<{id: string, reason: string, type: string, value: *}>} items
 * @param {object} [options]
 * @param {Decimal|string|number} [options.perHourRate] - `hours` uchun soat narxi
 * @returns {{ total: Decimal, breakdown: Array<{id, reason, type, value, amount, capped, rate?, noRate?}> }}
 */
const computeDeductions = (gross, items = [], { perHourRate = 0 } = {}) => {
  const base = Decimal.max(new Decimal(gross || 0), 0);
  const rate = Decimal.max(new Decimal(perHourRate || 0), 0);
  let remaining = base;
  let total = new Decimal(0);
  const breakdown = [];

  for (const item of items) {
    const value = new Decimal(item.value);
    const raw = (
      item.type === "percent"
        ? base.times(value).div(100)
        : item.type === "hours"
          ? rate.times(value)
          : value
    ).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const applied = Decimal.min(raw, remaining);

    remaining = remaining.minus(applied);
    total = total.plus(applied);
    breakdown.push({
      id: item.id,
      reason: item.reason,
      type: item.type,
      value: Number(value),
      amount: formatAmount(applied),
      // Shu ushlab qolishdan KEYIN qolgan oylik — oynada "qoldi" qatori.
      // Panelda qayta hisoblanmasligi uchun shu yerda (tartib va chegara
      // aynan shu tsiklda).
      remainingAfter: formatAmount(remaining),
      capped: applied.lessThan(raw),
      ...(item.type === "hours"
        ? { rate: formatAmount(rate), noRate: rate.isZero() }
        : {}),
    });
  }

  return { total, breakdown };
};

/**
 * TYUTOR QO'SHIMCHA OYLIGI — bitta biriktirilgan guruh (sinf) uchun.
 *
 *   summa = groupAmount + perStudentAmount × o'quvchilar soni
 *
 * ⚠️ FORMULA FAQAT SHU YERDA. Oylik dvigateli ham (muhrlash), tyutor kartasi
 * ham (jonli ko'rinish) shuni chaqiradi — aks holda kartada bir raqam,
 * vedomostda boshqa raqam chiqardi.
 *
 * Foizli ustamalar bazasiga KIRMAYDI: u fiksa + soatdan hisoblanadi
 * (`payrollEngine`), tyutor summasi esa ustiga qo'shiladi.
 *
 * @param {{perStudentAmount: *, groupAmount: *}} group
 * @param {number} studentCount
 * @returns {Decimal}
 */
const computeTutorGroupAmount = (group, studentCount) =>
  new Decimal(group.groupAmount || 0)
    .plus(new Decimal(group.perStudentAmount || 0).times(Math.max(0, Number(studentCount) || 0)))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

module.exports = {
  ALLOWANCE_TYPES,
  normalizeAllowances,
  computeAllowances,
  computeDeductions,
  computeTutorGroupAmount,
};
