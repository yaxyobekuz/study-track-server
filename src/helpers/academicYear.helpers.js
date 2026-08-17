/**
 * Akademik davr — MAKTAB BO'YICHA GLOBAL qoida: o'quv yili qaysi oydan
 * boshlanadi (1..12) va necha oy davom etadi (9 yoki 11). Katalog ham,
 * o'quvchiga biriktiriladigan narsa ham emas.
 *
 * Bu yerdan chiqadigan yagona savol: "YYYYMM akademik oymi va qaysi o'quv
 * yiliga tegishli?"
 *
 * Dekabr→yanvar o'tishi maxsus shart bilan emas, modul arifmetikasi bilan hal
 * qilinadi: oy raqami davr boshidan olingan 0..11 OFFSET'ga aylantiriladi.
 * Offset < davomiylik bo'lsa — akademik oy. Sentabr boshli 9 oylik davr uchun
 * dekabr → 3, yanvar → 4, may → 8 (oxirgi akademik oy).
 *
 * Sof funksiyalar: sozlama tashqaridan uzatiladi, DB'ga murojaat yo'q
 * (month.helpers.js uslubi).
 */

const { BadRequestError } = require("../utils/errors");

// Talab: faqat 9 yoki 11 oylik davr
const ACADEMIC_MONTH_COUNTS = [9, 11];

const monthOf = (monthKey) => monthKey % 100;
const yearOf = (monthKey) => Math.trunc(monthKey / 100);

/**
 * Sozlamani tekshiradi. Service qatlamida saqlashdan oldin chaqiriladi.
 * @param {{academicStartMonth: number, academicMonthCount: number}} settings
 */
function assertAcademicSettings({ academicStartMonth, academicMonthCount }) {
  if (
    !Number.isInteger(academicStartMonth) ||
    academicStartMonth < 1 ||
    academicStartMonth > 12
  ) {
    throw new BadRequestError("O'quv yili boshlanish oyi 1 dan 12 gacha bo'lishi kerak");
  }

  if (!ACADEMIC_MONTH_COUNTS.includes(academicMonthCount)) {
    throw new BadRequestError(
      `O'quv yili davomiyligi ${ACADEMIC_MONTH_COUNTS.join(" yoki ")} oy bo'lishi kerak`,
    );
  }
}

/**
 * Oyning o'quv yili boshidan hisoblangan o'rni (0..11).
 * (M - S + 12) % 12 — dekabrdan yanvarga o'tish shu yerda "bepul" hal bo'ladi.
 *
 * @param {number} monthKey - YYYYMM
 * @param {{academicStartMonth: number}} settings
 * @returns {number} 0..11
 */
function academicOffset(monthKey, { academicStartMonth }) {
  return (monthOf(monthKey) - academicStartMonth + 12) % 12;
}

/**
 * Oy akademik davrga kiradimi?
 * @param {number} monthKey - YYYYMM
 * @param {{academicStartMonth: number, academicMonthCount: number}} settings
 * @returns {boolean}
 */
function isAcademicMonth(monthKey, settings) {
  return academicOffset(monthKey, settings) < settings.academicMonthCount;
}

/**
 * Oy qaysi o'quv yiliga tegishli — davr BOSHLANGAN kalendar yil.
 * Sentabr boshli davrda 2027-yanvar → 2026, chunki u 2026/2027 yilining ichida.
 *
 * Akademik bo'lmagan oy uchun ham mazmunli qiymat qaytaradi (yozgi tanaffus —
 * o'sha yilning "dumi"), shunda hisobotlar bo'shliqqa tushib qolmaydi.
 *
 * @param {number} monthKey - YYYYMM
 * @param {{academicStartMonth: number}} settings
 * @returns {number} kalendar yil
 */
function academicYearOf(monthKey, settings) {
  return yearOf(monthKey) - (monthOf(monthKey) < settings.academicStartMonth ? 1 : 0);
}

/**
 * Oyning to'liq akademik tavsifi — hisob-fakturaga snapshot sifatida yoziladi.
 *
 * @param {number} monthKey - YYYYMM
 * @param {{academicStartMonth: number, academicMonthCount: number}} settings
 * @returns {{isAcademicMonth: boolean, academicYear: number, academicYearLabel: string, academicIndex: number|null, academicMonthCount: number}}
 */
function describeAcademicMonth(monthKey, settings) {
  const offset = academicOffset(monthKey, settings);
  const inside = offset < settings.academicMonthCount;
  const academicYear = academicYearOf(monthKey, settings);

  return {
    isAcademicMonth: inside,
    academicYear,
    academicYearLabel: `${academicYear}/${academicYear + 1}`,
    // 1..N ("9 oydan 3-si"). Akademik bo'lmagan oyda null.
    academicIndex: inside ? offset + 1 : null,
    academicMonthCount: settings.academicMonthCount,
  };
}

/**
 * O'quv yilining birinchi va oxirgi oyi.
 *
 * `?academicYear=2026` filtrini `month: { gte, lte }` ga aylantirish uchun —
 * shunda MonthlyInvoice'dagi mavjud [month, status] indeksi ishlaydi va
 * academicYear uchun alohida indeks kerak bo'lmaydi.
 *
 * @param {number} academicYear - davr boshlangan kalendar yil
 * @param {{academicStartMonth: number, academicMonthCount: number}} settings
 * @returns {{startMonth: number, endMonth: number}}
 */
function academicYearBounds(academicYear, settings) {
  const { academicStartMonth, academicMonthCount } = settings;
  const startMonth = academicYear * 100 + academicStartMonth;

  // Oxirgi akademik oy — boshlanishdan (count - 1) oy keyin
  const endOffset = academicStartMonth + academicMonthCount - 1;
  const endYear = academicYear + (endOffset > 12 ? 1 : 0);
  const endMonth = endOffset > 12 ? endOffset - 12 : endOffset;

  return { startMonth, endMonth: endYear * 100 + endMonth };
}

/**
 * O'quv yilining barcha oylari, tartib raqami bilan (UI kalendari uchun).
 *
 * @param {number} academicYear
 * @param {{academicStartMonth: number, academicMonthCount: number}} settings
 * @returns {Array<{month: number, academicIndex: number}>}
 */
function academicYearMonths(academicYear, settings) {
  const { academicStartMonth, academicMonthCount } = settings;
  const months = [];

  for (let i = 0; i < academicMonthCount; i += 1) {
    const offset = academicStartMonth + i;
    const year = academicYear + (offset > 12 ? 1 : 0);
    const month = offset > 12 ? offset - 12 : offset;
    months.push({ month: year * 100 + month, academicIndex: i + 1 });
  }

  return months;
}

/**
 * O'quv yilining TO'LANADIGAN oylari — ta'til oylari chiqarib tashlangan.
 *
 * IKKI XIL RAQAM, ikkalasi ham kerak:
 *   - `academicIndex` — KALENDAR o'rni (sentabrdan sanaganda nechanchi oy).
 *     Ta'tildan qat'i nazar o'zgarmaydi va hisob-fakturada shu bo'yicha
 *     muhrlangan.
 *   - `billableIndex` — ota-ona ko'radigan raqam ("8 oydan 5-si").
 *     Faqat to'lanadigan oylar sanaladi.
 *
 * Yanvar ta'til bo'lsa: fevral → academicIndex 6, billableIndex 5.
 *
 * Sof funksiya: ta'til to'plami PARAMETR sifatida uzatiladi (`settings`
 * bugun uzatilganidek), DB'ga murojaat service qatlamida qoladi.
 *
 * @param {number} academicYear - davr boshlangan kalendar yil
 * @param {{academicStartMonth: number, academicMonthCount: number}} settings
 * @param {Set<number>|number[]} [vacationMonths] - YYYYMM to'plami
 * @returns {{
 *   months: Array<{month: number, academicIndex: number, billableIndex: number|null, isVacation: boolean}>,
 *   billableMonthCount: number
 * }}
 */
function billableMonthsOfYear(academicYear, settings, vacationMonths = []) {
  const vacationSet =
    vacationMonths instanceof Set ? vacationMonths : new Set(vacationMonths);

  let billableIndex = 0;
  const months = academicYearMonths(academicYear, settings).map((entry) => {
    const isVacation = vacationSet.has(entry.month);
    if (!isVacation) billableIndex += 1;

    return {
      month: entry.month,
      academicIndex: entry.academicIndex,
      billableIndex: isVacation ? null : billableIndex,
      isVacation,
    };
  });

  return { months, billableMonthCount: billableIndex };
}

/**
 * Bitta oyning to'lanadigan davr ichidagi o'rni — hisob-fakturaga
 * snapshot sifatida yoziladi.
 *
 * Ta'til oyi uchun `billableIndex: null` qaytadi; chaqiruvchi bunday oyda
 * hisob-faktura umuman yaratmaydi.
 *
 * @param {number} monthKey - YYYYMM
 * @param {{academicStartMonth: number, academicMonthCount: number}} settings
 * @param {Set<number>|number[]} [vacationMonths]
 * @returns {{billableIndex: number|null, billableMonthCount: number, isVacation: boolean}}
 */
function describeBillableMonth(monthKey, settings, vacationMonths = []) {
  const academicYear = academicYearOf(monthKey, settings);
  const { months, billableMonthCount } = billableMonthsOfYear(
    academicYear,
    settings,
    vacationMonths,
  );
  const entry = months.find((m) => m.month === monthKey);

  return {
    billableIndex: entry?.billableIndex ?? null,
    billableMonthCount,
    isVacation: entry?.isVacation ?? false,
  };
}

module.exports = {
  ACADEMIC_MONTH_COUNTS,
  assertAcademicSettings,
  academicOffset,
  isAcademicMonth,
  academicYearOf,
  describeAcademicMonth,
  academicYearBounds,
  academicYearMonths,
  billableMonthsOfYear,
  describeBillableMonth,
};
