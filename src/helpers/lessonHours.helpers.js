/**
 * DARS SOATLARI — KPI oyligi uchun sof matematika (DB'siz).
 *
 * O'qituvchining oylik dars soati `Schedule`/`ScheduleLesson` dan chiqadi:
 * har bir dars haftaning bir kuniga (`ScheduleDay`) va vaqt oralig'iga
 * (`startTime`–`endTime`, "HH:mm") bog'langan. Oylik soat =
 *   Σ dars [ davomiylik(soat) × o'sha hafta kuni oyda necha marta kelishi ].
 *
 * Bu yerda faqat sof funksiyalar; schedule'ni o'qish `lessonHours.service.js` da.
 */

// ScheduleDay enum → ISO hafta kuni (dushanba=1 … shanba=6).
// JS `getUTCDay()`: yakshanba=0, dushanba=1 … shanba=6 — aynan mos keladi.
const SCHEDULE_DAY_TO_WEEKDAY = {
  dushanba: 1,
  seshanba: 2,
  chorshanba: 3,
  payshanba: 4,
  juma: 5,
  shanba: 6,
};

// Dars vaqti kiritilmagan bo'lsa ishlatiladigan zaxira davomiylik (1 akademik
// soat). Seed va odatiy jadvalda vaqt bo'ladi, shuning uchun bu kamdan-kam.
const DEFAULT_LESSON_HOURS = 1;

/** "HH:mm" → yarim tundan boshlab daqiqa, yaroqsiz bo'lsa null. */
const parseHHMM = (value) => {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
};

/**
 * Bitta dars davomiyligi (soatда). Vaqt yaroqsiz/teskari bo'lsa `fallback`.
 * @returns {number} soat (masalan 45 daqiqa → 0.75)
 */
const lessonDurationHours = (startTime, endTime, fallback = DEFAULT_LESSON_HOURS) => {
  const start = parseHHMM(startTime);
  const end = parseHHMM(endTime);
  if (start == null || end == null || end <= start) return fallback;
  return (end - start) / 60;
};

/**
 * Berilgan oyda (YYYYMM) hafta kuni necha marta uchraydi.
 * UTC bilan quriladi — kun sanog'i taymzonadan qat'i nazar bir xil.
 * @param {number} month - YYYYMM
 * @param {number} weekday - ISO (1=dushanba … 6=shanba)
 */
const countWeekdayInMonth = (month, weekday) => {
  const year = Math.floor(month / 100);
  const monthIndex = (month % 100) - 1;
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

  let count = 0;
  for (let day = 1; day <= daysInMonth; day += 1) {
    if (new Date(Date.UTC(year, monthIndex, day)).getUTCDay() === weekday) {
      count += 1;
    }
  }
  return count;
};

/**
 * [fromDate, toDate] (inklyuziv) oralig'ida hafta kuni necha marta uchraydi.
 * Sanalar UTC yarim tunidagi Date bo'lishi kutiladi.
 * @param {number} weekday - ISO (1=dushanba … 6=shanba)
 * @param {Date} fromDate
 * @param {Date} toDate
 */
const countWeekdayBetween = (weekday, fromDate, toDate) => {
  if (toDate < fromDate) return 0;
  const cur = new Date(
    Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate()),
  );
  const end = new Date(
    Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate()),
  );
  let count = 0;
  while (cur <= end) {
    if (cur.getUTCDay() === weekday) count += 1;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
};

module.exports = {
  SCHEDULE_DAY_TO_WEEKDAY,
  DEFAULT_LESSON_HOURS,
  parseHHMM,
  lessonDurationHours,
  countWeekdayInMonth,
  countWeekdayBetween,
};
