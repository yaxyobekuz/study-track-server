/**
 * O'qish davrlari va KIRISH PRORATSIYASI — sof hisob, DB'siz.
 *
 * ═════════════════════════════════════════════
 * QOIDA (bitta jumlada)
 *
 *   Proratsiya koeffitsiyenti FAQAT KIRISH KUNIDAN kelib chiqadi.
 *   Oyning 1-kunini BIRORTA davr qamragan bo'lsa — to'liq oy.
 *   Aks holda oy ICHIDA boshlangan ENG ERTA davr kirish kunini beradi.
 *
 * `endDate` faqat hisob-faktura BOR-YO'QLIGINI hal qiladi, SUMMASINI emas:
 * "o'quvchi oyda 1 kun o'qisa ham to'liq oy" qoidasi chiqishda kuchda qoladi.
 * 3-sentabrda ketgan o'quvchi sentabrni TO'LIQ to'laydi.
 * ═════════════════════════════════════════════
 *
 * ⚠️ BU JADVALGA "ENG KECH BOSHLANGANI YUTADI" NAQSHINI KO'CHIRMANG.
 * `tariffResolution.service.js` va `studentFinanceStatus.service.js` da
 * `orderBy: { startMonth: "desc" }` + birinchisini olish naqshi bor — u
 * BU YERDA XATO natija beradi. Misol: davrlar [2-sen, 3-sen] va [20-sen, ...].
 * "Eng kech" 20-sentabrni oladi → 11/30. To'g'ri javob esa 29/30 (eng erta
 * kirish). Shuning uchun resolver BARCHA davrlarni oladi.
 *
 * `endDate` INKLYUZIV — oxirgi o'qigan kun. [.., 09-30] va [10-01, ..]
 * kesishmaydi, ya'ni ertasiga qayta yozilish mumkin.
 */

const {
  Decimal,
  AMOUNT_SCALE,
  floorToUnit,
} = require("./money.helpers");
const {
  daysInMonth,
  monthKeyOfDate,
  dayOfMonthOfDate,
  parseDayDate,
  parseOptionalDayDate,
} = require("./month.helpers");
const { BadRequestError, InternalServerError } = require("../utils/errors");

/** Ochiq davrning tugash sanasi sifatida ishlatiladigan sentinel. */
const OPEN_END_DATE = new Date(Date.UTC(9999, 11, 31));

/** Davr nima uchun shunday hal qilindi — auditda va UI da ko'rsatiladi. */
const REASONS = {
  NO_PERIODS: "no_periods", // qator umuman yo'q → O'QIMAYDI
  COVERS_MONTH_START: "covers_month_start", // oy boshida allaqachon o'qiyotgan edi
  ENTERED_MID_MONTH: "entered_mid_month", // oy ichida keldi → proratsiya
  NOT_ENROLLED: "not_enrolled", // bu oyda umuman o'qimagan
};

/**
 * O'quvchi berilgan oyda hisob-faktura oladimi va qanday ulushda.
 *
 * BARCHA davrlar uzatiladi — filtrlanmagan, tartibi ahamiyatsiz.
 *
 * ⚠️ DAVR YO'Q = O'QIMAYDI. O'quvchi yaratilganda unga o'sha sanadan
 * boshlanadigan davr AVTOMAT ochiladi, shuning uchun "davri yo'q" holati
 * normal ish jarayonida umuman uchramaydi — u faqat ma'lumot to'liq
 * emasligini bildiradi va bunday o'quvchiga hisob-faktura yozilmaydi.
 *
 * ⚠️ Bo'sh massiv "bu oyni qamragan davr yo'q" degani EMAS, "o'quvchida
 * BITTA HAM davr yo'q" degani. Chaqiruvchi davrlarni oy oralig'i bo'yicha
 * filtrlab yubormasligi SHART: aks holda "shu oyda davri yo'q" holati
 * "umuman davri yo'q" bilan chalkashib ketardi.
 *
 * @param {Array<{startDate: Date, endDate: Date|null}>} periods
 * @param {number} monthKey - YYYYMM
 * @returns {{
 *   enrolled: boolean,
 *   isProrated: boolean,
 *   billableDays: number,
 *   monthDays: number,
 *   entryDay: number|null,
 *   reason: string
 * }}
 */
function resolveEnrollmentForMonth(periods, monthKey) {
  const monthDays = daysInMonth(monthKey);

  const full = (reason) => ({
    enrolled: true,
    isProrated: false,
    billableDays: monthDays,
    monthDays,
    entryDay: null,
    reason,
  });

  const none = (reason) => ({
    enrolled: false,
    isProrated: false,
    billableDays: 0,
    monthDays,
    entryDay: null,
    reason,
  });

  // Qator yo'q → o'qimaydi (hisob-faktura yozilmaydi)
  if (!periods || periods.length === 0) return none(REASONS.NO_PERIODS);

  let earliestEntryDay = null;

  for (const period of periods) {
    const startKey = monthKeyOfDate(period.startDate);
    const endKey = period.endDate ? monthKeyOfDate(period.endDate) : null;

    // Davr shu oydan keyin boshlangan yoki shu oydan oldin tugagan
    if (startKey > monthKey) continue;
    if (endKey != null && endKey < monthKey) continue;

    // Davr oyning 1-kunini qamragan → to'liq oy, boshqa davrlarni ko'rish shart emas
    if (startKey < monthKey) return full(REASONS.COVERS_MONTH_START);

    // Davr AYNAN shu oyda boshlangan — eng ertasini olamiz
    const day = dayOfMonthOfDate(period.startDate);
    if (earliestEntryDay == null || day < earliestEntryDay) earliestEntryDay = day;
  }

  if (earliestEntryDay == null) return none(REASONS.NOT_ENROLLED);

  // 1-kunda kelgan bo'lsa proratsiya yo'q — to'liq oy
  if (earliestEntryDay <= 1) return full(REASONS.COVERS_MONTH_START);

  return {
    enrolled: true,
    isProrated: true,
    billableDays: monthDays - earliestEntryDay + 1,
    monthDays,
    entryDay: earliestEntryDay,
    reason: REASONS.ENTERED_MID_MONTH,
  };
}

/**
 * Tarif narxini kirish kuniga proratsiya qiladi va PASTGA yaxlitlaydi.
 *
 * AMALLAR TARTIBI MUHIM: `times()` aniq, `div()` esa yagona yaxlitlash
 * nuqtasi. `base.div(monthDays).times(billableDays)` YOZMANG — 600000/28
 * cheksiz kasr bo'lib qisqaradi va floor chegarasida butun bir birlik
 * (1000 so'm) yo'qolishi mumkin.
 *
 * @param {Prisma.Decimal} baseAmount - to'liq tarif narxi (>= 0)
 * @param {number} billableDays - 1..monthDays
 * @param {number} monthDays - 28..31
 * @param {{roundingUnit?: number}} [options]
 * @returns {{
 *   proratedAmount: Prisma.Decimal,
 *   isProrated: boolean,
 *   roundingUnit: number,
 *   roundedOff: Prisma.Decimal
 * }}
 * @throws {InternalServerError} - kun chegaralari buzilgan (kod xatosi)
 */
function prorateAmount(baseAmount, billableDays, monthDays, options = {}) {
  const { roundingUnit = 1000 } = options;
  const base = baseAmount instanceof Decimal ? baseAmount : new Decimal(baseAmount);

  // Foydalanuvchi xatosi emas — kod xatosi. Aks holda buzuq qiymat
  // `createMany` o'rtasida chiqib, paket yarim yozilgan holda qolardi.
  if (
    !Number.isInteger(monthDays) ||
    !Number.isInteger(billableDays) ||
    monthDays < 28 ||
    monthDays > 31 ||
    billableDays < 1 ||
    billableDays > monthDays
  ) {
    throw new InternalServerError(
      `Proratsiya kunlari noto'g'ri: ${billableDays}/${monthDays}`,
    );
  }

  if (billableDays === monthDays) {
    return {
      proratedAmount: base,
      isProrated: false,
      roundingUnit,
      roundedOff: new Decimal(0),
    };
  }

  const raw = base.times(billableDays).div(monthDays);

  // Yaxlitlash faqat baza birlikdan KATTA bo'lganda. Aks holda 600 so'mlik
  // tarif 20/30 da 400 → floor1000 → 0 bo'lib, haqiqiy majburiyat jimgina
  // "to'langan" ga aylanardi.
  const applyRounding =
    Number.isInteger(roundingUnit) && roundingUnit > 1 && base.greaterThan(roundingUnit);

  const rounded = applyRounding
    ? floorToUnit(raw, roundingUnit)
    : raw.toDecimalPlaces(AMOUNT_SCALE, Decimal.ROUND_DOWN);

  // Himoya qavati: invariant shartsiz bajarilsin
  const proratedAmount = Decimal.max(new Decimal(0), Decimal.min(rounded, base));

  return {
    proratedAmount,
    isProrated: true,
    roundingUnit: applyRounding ? roundingUnit : 0,
    roundedOff: raw.toDecimalPlaces(AMOUNT_SCALE, Decimal.ROUND_DOWN).minus(proratedAmount),
  };
}

/**
 * `overlappingPeriodWhere` ning KUN versiyasi.
 *
 * `endDate` inklyuziv bo'lgani uchun tekshiruv ham inklyuziv: [.., 09-30] va
 * [09-30, ..] KESISHADI, [.., 09-30] va [10-01, ..] esa yo'q.
 *
 * @param {Date} startDate
 * @param {Date|null} endDate
 * @returns {object} Prisma `where` bo'lagi
 */
function overlappingDateRangeWhere(startDate, endDate) {
  return {
    startDate: { lte: endDate ?? OPEN_END_DATE },
    OR: [{ endDate: null }, { endDate: { gte: startDate } }],
  };
}

/**
 * Davr sanalarini tekshiradi (`parsePeriod` ning kun versiyasi).
 *
 * @param {string} startValue - "YYYY-MM-DD"
 * @param {string|null} endValue
 * @returns {{startDate: Date, endDate: Date|null}}
 * @throws {BadRequestError}
 */
function parseEnrollmentPeriod(startValue, endValue) {
  const startDate = parseDayDate(startValue, "Boshlanish sanasi");
  const endDate = parseOptionalDayDate(endValue, "Tugash sanasi");

  if (endDate != null && endDate < startDate) {
    throw new BadRequestError(
      "Tugash sanasi boshlanish sanasidan oldin bo'lishi mumkin emas",
    );
  }

  return { startDate, endDate };
}

/**
 * Davr berilgan oyni qamraydimi (UI va hisobotlar uchun).
 * @param {{startDate: Date, endDate: Date|null}} period
 * @param {number} monthKey
 * @returns {boolean}
 */
function periodCoversMonth(period, monthKey) {
  const startKey = monthKeyOfDate(period.startDate);
  const endKey = period.endDate ? monthKeyOfDate(period.endDate) : null;

  return startKey <= monthKey && (endKey == null || endKey >= monthKey);
}

/**
 * O'quvchi hozir o'qiyaptimi — oxirgi davrda `endDate` yo'q bo'lsa ha.
 * Davr umuman bo'lmasa — O'QIMAYDI.
 *
 * @param {Array<{startDate: Date, endDate: Date|null}>} periods
 * @returns {{isStudying: boolean, since: Date|null, until: Date|null, hasPeriods: boolean}}
 */
function describeEnrollment(periods = []) {
  if (periods.length === 0) {
    return { isStudying: false, since: null, until: null, hasPeriods: false };
  }

  const sorted = [...periods].sort((a, b) => a.startDate - b.startDate);
  const open = sorted.find((p) => p.endDate == null);

  if (open) {
    return { isStudying: true, since: open.startDate, until: null, hasPeriods: true };
  }

  const last = sorted[sorted.length - 1];
  return {
    isStudying: false,
    since: last.startDate,
    until: last.endDate,
    hasPeriods: true,
  };
}

module.exports = {
  OPEN_END_DATE,
  REASONS,
  resolveEnrollmentForMonth,
  prorateAmount,
  overlappingDateRangeWhere,
  parseEnrollmentPeriod,
  periodCoversMonth,
  describeEnrollment,
};
