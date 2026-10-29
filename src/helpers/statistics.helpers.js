const { getNowInUzbekistan } = require("./date.helpers");

/**
 * Yil ichidagi hafta raqamini qaytaradi (1-52)
 * @param {Date} date - Sana
 * @returns {number} Hafta raqami (1-52)
 */
const getWeekNumber = (date) => {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return weekNo;
};

/**
 * Joriy haftaning chegaralarini qaytaradi (dushanba - bugun)
 * @returns {{weekStart: Date, weekEnd: Date, weekNumber: number, year: number}}
 */
const getCurrentWeekRange = () => {
  const today = getNowInUzbekistan();
  const dayOfWeek = today.getDay(); // 0=yakshanba, 1=dushanba, ..., 6=shanba

  // Dushanba = hafta boshi
  // Agar bugun yakshanba (0) bo'lsa, 6 kun orqaga
  // Aks holda dayOfWeek - 1 kun orqaga
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const monday = new Date(today);
  monday.setDate(today.getDate() - daysFromMonday);
  monday.setHours(0, 0, 0, 0);

  // Bugun = hafta oxiri (faqat o'tgan kunlar)
  const todayEnd = new Date(today);
  todayEnd.setHours(23, 59, 59, 999);

  return {
    weekStart: monday,
    weekEnd: todayEnd,
    weekNumber: getWeekNumber(monday),
    year: monday.getFullYear(),
  };
};

/**
 * Berilgan sana tegishli haftaning chegaralarini qaytaradi (dushanba - shanba).
 * Tarix (o'tgan haftalar) uchun ishlatiladi — getCurrentWeekRange bilan bir xil
 * dushanba-asosli mantiq, faqat weekEnd bu yerda shanba (to'liq hafta).
 * @param {Date|string} date
 * @returns {{weekStart: Date, weekEnd: Date, weekNumber: number, year: number}}
 */
const getWeekRangeForDate = (date) => {
  const d = new Date(date);
  const dayOfWeek = d.getDay(); // 0=yakshanba ... 6=shanba
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const monday = new Date(d);
  monday.setDate(d.getDate() - daysFromMonday);
  monday.setHours(0, 0, 0, 0);

  const saturday = new Date(monday);
  saturday.setDate(monday.getDate() + 5);
  saturday.setHours(23, 59, 59, 999);

  return {
    weekStart: monday,
    weekEnd: saturday,
    weekNumber: getWeekNumber(monday),
    year: monday.getFullYear(),
  };
};

/* ─────────────────────────── REYTING DAVRLARI ─────────────────────────── */

/**
 * Reyting davrlari — "kunlik / haftalik / oylik".
 *
 * ⚠️ KALENDAR DAVR, "oxirgi N kun" EMAS (`helpers/gradeAnalysis.js` dagi
 * `GRADE_ANALYSIS_PERIODS` dan farqi aynan shu). Reyting "BU hafta kim
 * oldinda" degan savolga javob beradi: dushanba kuni u noldan boshlanishi
 * kerak, oyning 1-kuni ham shunday. "Oxirgi 7 kun" bo'lsa, dushanba kuni
 * ro'yxatda o'tgan haftaning ballari turardi va "yangi hafta" degan
 * tushuncha yo'qolardi.
 *
 * ⚠️ UCHALASI HAM BUGUN BILAN TUGAYDI (`getCurrentWeekRange` bilan AYNI
 * qoida): kelasi kunlar hali fakt emas.
 */
const STATISTICS_PERIODS = Object.freeze({
  day: Object.freeze({ key: "day", title: "Kunlik", label: "Bugun" }),
  week: Object.freeze({ key: "week", title: "Haftalik", label: "Bu hafta" }),
  month: Object.freeze({ key: "month", title: "Oylik", label: "Bu oy" }),
});

const STATISTICS_PERIOD_KEYS = Object.freeze(Object.keys(STATISTICS_PERIODS));

/**
 * Tanlangan davrning chegaralari.
 *
 * ⚠️ NOMA'LUM KALIT → HAFTALIK: davr — ko'rsatish filtri, ma'lumot emas.
 * Eski mijoz (`period` yubormaydigan student paneli, bot, monitor) va
 * noto'g'ri yozilgan qiymat AVVALGIDEK haftalik reytingni oladi.
 *
 * ⚠️ `weekStart`/`weekEnd`/`weekNumber`/`year` javobda QOLADI: ular
 * mijozlar bilan tuzilgan shartnoma. Yangi kodda `start`/`end` ishlatiladi.
 *
 * @param {string} [periodKey] - "day" | "week" | "month"
 * @returns {{period: string, title: string, start: Date, end: Date, weekStart: Date, weekEnd: Date, weekNumber: number, year: number}}
 */
const getStatisticsPeriodRange = (periodKey) => {
  const period = STATISTICS_PERIODS[periodKey] || STATISTICS_PERIODS.week;

  if (period.key === "week") {
    const week = getCurrentWeekRange();
    return {
      ...week,
      period: period.key,
      title: period.title,
      start: week.weekStart,
      end: week.weekEnd,
    };
  }

  const today = getNowInUzbekistan();

  const start = new Date(today);
  if (period.key === "month") start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const end = new Date(today);
  end.setHours(23, 59, 59, 999);

  return {
    period: period.key,
    title: period.title,
    start,
    end,
    weekStart: start,
    weekEnd: end,
    weekNumber: getWeekNumber(start),
    year: start.getFullYear(),
  };
};

/**
 * Baholar yig'indisini hisoblaydi
 * @param {Array} grades - Baholar array (har bir grade da .grade field bor)
 * @returns {number} Barcha baholar yig'indisi
 */
const calculateTotalSum = (grades) => {
  if (!grades || grades.length === 0) return 0;
  return grades.reduce((acc, g) => acc + g.grade, 0);
};

module.exports = {
  getWeekNumber,
  getCurrentWeekRange,
  getWeekRangeForDate,
  getStatisticsPeriodRange,
  STATISTICS_PERIODS,
  STATISTICS_PERIOD_KEYS,
  calculateTotalSum,
};
