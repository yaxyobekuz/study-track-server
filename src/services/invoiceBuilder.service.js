/**
 * Hisob-faktura summasini yig'ishning YAGONA joyi.
 *
 * NIMA UCHUN ALOHIDA FAYL: hisob-faktura ikki xil yo'l bilan yaratiladi —
 * oylik pass (`invoiceGeneration.service.js`) va qo'lda qayta shakllantirish
 * (`invoice.service.js` → `regenerateInvoice`). Ilgari ikkalasi summani
 * MUSTAQIL hisoblardi va bu tinch turgan mina edi: proratsiya faqat
 * birinchisiga qo'shilsa, kech qo'shilgan chegirmani qayta shakllantirish
 * o'quvchining hisobini ikki baravar oshirib yuborardi (240 000 → 540 000).
 *
 * Shuning uchun summa mantig'i shu yerda, ikkalasi ham shuni chaqiradi.
 *
 * ── HISOB TARTIBI (o'zgartirilmasin) ──────────
 *
 *   1. baseAmount     — tarif narxi (to'liq oy, chegirmasiz)
 *   2. proratedAmount — floor(base × billableDays / monthDays, roundingUnit)
 *   3. discountAmount — chegirmalar AYNAN proratedAmount ga qo'llanadi
 *   4. amount         — proratedAmount − discountAmount   ← MUHRLANADI
 *
 * 3-qadamda chegirma to'liq narxga qo'llanib, keyin natija proratsiya
 * qilinsa, `discountSnapshot` dagi ulushlar yig'indisi `discountAmount` ga
 * teng bo'lmay qolardi (discount.helpers.js dagi qoldiq taqsimoti buziladi).
 *
 * ⚠️ QAT'IY SUMMALI CHEGIRMA PRORATSIYA QILINMAYDI — biznes qarori.
 * Oqibati: katta qat'iy chegirmasi bor o'quvchi oy oxirida kelsa, o'sha oy
 * 0 so'm bo'lib "to'langan" deb yopilishi mumkin. Bu jim qolmasligi uchun
 * chaqiruvchi `wipedByDiscount` bayrog'ini sanab boradi.
 */

const { parseAmount, Decimal } = require("../helpers/money.helpers");
const { applyDiscounts } = require("../helpers/discount.helpers");
const {
  resolveEnrollmentForMonth,
  prorateAmount,
} = require("../helpers/enrollment.helpers");
const { REASONS } = require("./tariffResolution.service");

/**
 * Bir oylik summani hisoblaydi — narx, proratsiya, chegirma.
 *
 * @param {object} params
 * @param {string|Prisma.Decimal} params.baseAmount - tarif narxi
 * @param {Array<object>} params.discounts - o'quvchining shu oydagi chegirmalari
 * @param {Array<{startDate: Date, endDate: Date|null}>} params.periods - BARCHA o'qish davrlari
 * @param {number} params.month - YYYYMM
 * @param {object} params.settings - FinanceSettings
 * @returns {{
 *   enrollment: object,
 *   baseAmount: Prisma.Decimal,
 *   proratedAmount: Prisma.Decimal,
 *   discountAmount: Prisma.Decimal,
 *   amount: Prisma.Decimal,
 *   snapshot: object[],
 *   isProrated: boolean,
 *   wipedByDiscount: boolean
 * }}
 */
const computeMonthlyAmount = ({ baseAmount, discounts, periods, month, settings }) => {
  const base = parseAmount(baseAmount, "Oylik summa");
  const enrollment = resolveEnrollmentForMonth(periods, month);

  // O'quvchi bu oyda o'qimagan bo'lsa hisoblanadigan summa YO'Q.
  // `prorateAmount` 0 kunni kod xatosi deb qabul qiladi (va shunday bo'lishi
  // kerak), shuning uchun bu holat undan OLDIN to'xtatiladi — aks holda
  // maktabdan ketgan o'quvchi moliya sahifasini ochganda server yiqilardi.
  if (!enrollment.enrolled) {
    const zero = new Decimal(0);
    return {
      enrollment,
      baseAmount: base,
      proratedAmount: zero,
      discountAmount: zero,
      amount: zero,
      snapshot: [],
      isProrated: false,
      roundingUnit: 0,
      wipedByDiscount: false,
    };
  }

  const prorated = settings.prorationEnabled
    ? prorateAmount(base, enrollment.billableDays, enrollment.monthDays, {
        roundingUnit: settings.roundingUnit,
      })
    : { proratedAmount: base, isProrated: false, roundingUnit: 0 };

  // Chegirma proratsiya qilingan summaga qo'llanadi — to'liq narxga emas
  const discounted = applyDiscounts(prorated.proratedAmount, discounts ?? []);

  return {
    enrollment,
    baseAmount: base,
    proratedAmount: prorated.proratedAmount,
    discountAmount: discounted.discountAmount,
    amount: discounted.finalAmount,
    snapshot: discounted.snapshot,
    isProrated: prorated.isProrated,
    roundingUnit: prorated.roundingUnit,
    // Proratsiya qilingan oy chegirma bilan butunlay nolga tushdimi
    wipedByDiscount:
      prorated.isProrated &&
      discounted.finalAmount.isZero() &&
      prorated.proratedAmount.greaterThan(0),
  };
};

/**
 * `monthlyInvoice.create` uchun tayyor qator quradi.
 *
 * Yaratib bo'lmasa `{ skip: "notEnrolled" | "noTariff" | "noPrice" }`
 * qaytaradi — chaqiruvchi buni sanoqchiga yozadi. Xato OTILMAYDI: bitta
 * o'quvchining konfiguratsiya muammosi butun oylik passni to'xtatmasligi
 * kerak.
 *
 * @param {object} params
 * @returns {{row: object|null, skip: string|null, computed: object|null}}
 */
const buildInvoiceRow = ({
  student,
  month,
  settings,
  resolved,
  discounts,
  periods,
  source = "cron",
  actorId = null,
  studentSnapshot,
}) => {
  const enrollment = resolveEnrollmentForMonth(periods, month);

  // O'qish davri hisob-fakturaning BOR-YO'QLIGINI hal qiladi — narxdan oldin
  if (!enrollment.enrolled) return { row: null, skip: "notEnrolled", computed: null };

  if (!resolved || resolved.reason === REASONS.NO_ASSIGNMENT) {
    // Yangi kelgan o'quvchining tarifi hali biriktirilmagan bo'lsa — bu
    // statistika emas, SIGNAL: proratsiya aynan shu oyni ushlash uchun bor.
    return {
      row: null,
      skip: enrollment.isProrated ? "noTariffNewlyEnrolled" : "noTariff",
      computed: null,
    };
  }

  if (resolved.reason === REASONS.NO_PRICE) {
    return { row: null, skip: "noPrice", computed: null };
  }

  const item = resolved.items[0];
  const computed = computeMonthlyAmount({
    baseAmount: resolved.total,
    discounts,
    periods,
    month,
    settings,
  });

  // Nol summali hisob-faktura darhol "to'langan" bo'ladi — qamrov to'liq
  // qoladi, uydirma qarz yaralmaydi.
  const isZero = computed.amount.isZero();

  return {
    skip: null,
    computed,
    row: {
      studentId: student.id,
      month,
      tariffId: item.tariff.id,
      tariffVersionId: item.version.id,
      tariffName: item.tariff.name,
      // Yo'nalish nomi ham MUHRLANADI. Bo'sh bo'lishi mumkin: tarifga
      // yo'nalish biriktirilmagan. Hisobot bunday qatorni tarif nomi
      // bilan guruhlaydi.
      directionName: item.tariff.direction?.name ?? "",
      baseAmount: computed.baseAmount,
      // Proratsiya bo'lmasa null — "kun koordinatasi qo'llanmagan" degani
      billableDays: computed.isProrated ? enrollment.billableDays : null,
      monthDays: computed.isProrated ? enrollment.monthDays : null,
      roundingUnit: computed.isProrated ? computed.roundingUnit || null : null,
      proratedAmount: computed.proratedAmount,
      discountAmount: computed.discountAmount,
      discountSnapshot: computed.snapshot.length ? computed.snapshot : null,
      amount: computed.amount,
      paidAmount: 0,
      status: isZero ? "paid" : "unpaid",
      paidAt: isZero ? new Date() : null,
      source,
      studentSnapshot,
      createdBy: actorId,
    },
  };
};

/** Proratsiya farqini bitta joydan hisoblash (hisobot ustunlari uchun). */
const prorationGap = (baseAmount, proratedAmount) =>
  new Decimal(baseAmount).minus(proratedAmount);

module.exports = {
  computeMonthlyAmount,
  buildInvoiceRow,
  prorationGap,
};
