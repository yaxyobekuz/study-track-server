const { DAYS_UZ, MONTHS_UZ, MONTHS_UZ_CAP } = require("../utils/constants");

const UZBEKISTAN_TIMEZONE = "Asia/Tashkent";

// Toshkent — UTC+5, DST yo'q (`education.md` §7). Shu sababli devor-soatini
// olish uchun `Intl` shart emas: instantni +5 soatga surib, `getUTC*` bilan
// o'qish yetarli va aniq.
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

/**
 * Returns current date-time in Uzbekistan timezone.
 * @returns {Date} Current date-time aligned to Asia/Tashkent timezone
 */
const getNowInUzbekistan = () => {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: UZBEKISTAN_TIMEZONE }),
  );
};

/**
 * Toshkent devor-soati bo'yicha kunni UTC yarim tunidagi Date qilib qaytaradi.
 *
 * `Changelog.date` aynan shu shaklda saqlanadi (changelogMarkdown.helpers.js
 * dagi `normalizeDate`), `@@unique([date, panel])` shunga tayanadi.
 *
 * DIQQAT — bu yerda ikkita tipik xato bor:
 *  1. `Date.now() - 86400000` NOTO'G'RI: 09:00 Toshkent = 04:00 UTC, ya'ni
 *     O'SHA kalendar kun. Bir sutka ayirish kunni ikki marta orqaga suradi.
 *  2. `getDateRangeForDay()` ham to'g'ri kelmaydi: u `setHours` bilan
 *     server-lokal ishlaydi va host UTC+5 bo'lmasa bir kunga adashadi.
 *
 * @param {number} offsetDays 0 = bugun, -1 = kecha
 * @returns {Date} UTC yarim tuni
 */
const getTashkentDateUtc = (offsetDays = 0) => {
  const nowUz = getNowInUzbekistan(); // lokal getterlari Toshkent soatini o'qiydi
  // Date.UTC oy/yil chegarasini o'zi normallashtiradi (0 → oldingi oyning oxiri)
  return new Date(
    Date.UTC(nowUz.getFullYear(), nowUz.getMonth(), nowUz.getDate() + offsetDays),
  );
};

/**
 * Bugungi kun nomini qaytaradi (o'zbek tilida)
 * @returns {string} Kun nomi (masalan: "dushanba")
 */
const getCurrentDayUz = () => {
  const today = getNowInUzbekistan();
  return DAYS_UZ[today.getDay()];
};

/**
 * Berilgan sananing kun nomini qaytaradi (o'zbek tilida)
 * @param {Date|string} date - Sana
 * @returns {string} Kun nomi (masalan: "seshanba")
 */
const getDayNameUz = (date) => {
  const dateObj = date instanceof Date ? date : new Date(date);
  return DAYS_UZ[dateObj.getDay()];
};

/**
 * Kunning boshlanish va tugash vaqtini qaytaradi
 * @param {Date|string} date - Sana
 * @returns {{startDate: Date, endDate: Date}} Kun boshlanish va tugash vaqti
 */
const getDateRangeForDay = (date) => {
  const dateObj = date instanceof Date ? date : new Date(date);

  const startDate = new Date(dateObj);
  startDate.setHours(0, 0, 0, 0);

  const endDate = new Date(dateObj);
  endDate.setHours(23, 59, 59, 999);

  return { startDate, endDate };
};

/**
 * Yakshanba ekanligini tekshiradi
 * @param {Date|string} date - Sana (optional, default: bugun)
 * @returns {boolean} Yakshanba bo'lsa true
 */
const isSunday = (date = new Date()) => {
  const dateObj = date instanceof Date ? date : new Date(date);
  return dateObj.getDay() === 0;
};

/**
 * Bugun ekanligini tekshiradi
 * @param {Date|string} date - Sana
 * @returns {boolean} Bugun bo'lsa true
 */
const isToday = (date) => {
  const dateObj = date instanceof Date ? date : new Date(date);
  const today = getNowInUzbekistan();

  return (
    dateObj.getDate() === today.getDate() &&
    dateObj.getMonth() === today.getMonth() &&
    dateObj.getFullYear() === today.getFullYear()
  );
};

/**
 * Ikki sanani taqqoslaydi (faqat kun, soat hisobga olinmaydi)
 * @param {Date|string} date1 - Birinchi sana
 * @param {Date|string} date2 - Ikkinchi sana
 * @returns {boolean} Bir xil kun bo'lsa true
 */
const isSameDay = (date1, date2) => {
  const d1 = date1 instanceof Date ? date1 : new Date(date1);
  const d2 = date2 instanceof Date ? date2 : new Date(date2);

  return (
    d1.getDate() === d2.getDate() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getFullYear() === d2.getFullYear()
  );
};

/**
 * Sana uchun ertangi kunning boshlanish vaqtini qaytaradi
 * @param {Date|string} date - Sana (optional, default: bugun)
 * @returns {Date} Ertangi kun boshlanish vaqti
 */
const getTomorrowStart = (date = new Date()) => {
  const dateObj = date instanceof Date ? date : new Date(date);
  const tomorrow = new Date(dateObj);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow;
};

/**
 * Vaqtni HH:mm formatidan daqiqalarga aylantiradi (yarim tunda 0)
 * @param {string} timeStr - Vaqt (masalan: "09:30")
 * @returns {number} Daqiqalar (masalan: 570)
 */
const timeToMinutes = (timeStr) => {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
};

/**
 * Hozirgi vaqtni daqiqalarda qaytaradi (yarim tunda 0)
 * @returns {number} Hozirgi vaqt daqiqalarda
 */
const getCurrentTimeInMinutes = () => {
  const now = getNowInUzbekistan();
  return now.getHours() * 60 + now.getMinutes();
};

/**
 * Daqiqalarni HH:mm formatiga aylantiradi
 * @param {number} minutes - Daqiqalar (masalan: 570)
 * @returns {string} Vaqt (masalan: "09:30")
 */
const minutesToTime = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};

/**
 * Dars vaqti oralig'ini tekshiradi (baho qo'yish uchun)
 * @param {string} startTime - Boshlanish vaqti (HH:mm)
 * @param {string} endTime - Tugash vaqti (HH:mm)
 * @param {number} gracePeriodMinutes - Darsdan keyin qo'shimcha vaqt (default: 30)
 * @returns {{canGrade: boolean, reason: string}} Natija
 */
const checkGradingTimeWindow = (startTime, endTime, gracePeriodMinutes = 30) => {
  const currentMinutes = getCurrentTimeInMinutes();
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);
  const graceEndMinutes = endMinutes + gracePeriodMinutes;

  // Dars boshlanishidan oldin
  if (currentMinutes < startMinutes) {
    const minutesUntilStart = startMinutes - currentMinutes;
    return {
      canGrade: false,
      reason: `Dars hali boshlanmagan. ${minutesToTime(startMinutes)} da boshlanadi (${minutesUntilStart} daqiqadan keyin)`,
    };
  }

  // Darsdan keyin grace period tugagan
  if (currentMinutes > graceEndMinutes) {
    return {
      canGrade: false,
      reason: `Baho qo'yish muddati tugagan. Dars ${minutesToTime(endMinutes)} da tugagan (${gracePeriodMinutes} daqiqalik muddat tugadi)`,
    };
  }

  // Dars davomida yoki grace period ichida
  return { canGrade: true, reason: null };
};

/* ------------------------------------------------------------------ *
 * SANA FORMATLASH — server bo'yicha yagona manba
 *
 * Serverdan chiqadigan har qanday sana matni (Telegram xabari, Excel
 * ustuni, xato matni) FAQAT shu funksiyalardan o'tadi:
 *
 *     kun          →  "21-may, 2025"        formatDateUz
 *     kun + vaqt   →  "21-may, 2025 14:30"  formatDateTimeUz
 *     vaqt         →  "14:30"               formatTimeUz
 *
 * Oy yorlig'i ("Yanvar, 2026") — moliya domenida: `month.helpers.js`
 * dagi `formatMonthKey`.
 *
 * ⚠️ `toLocaleDateString("uz-UZ")` ISHLATILMAYDI: u Node ICU qurilishiga
 * qarab "21.05.2025" yoki "5/21/2025" beradi, ya'ni format server qayerda
 * ishga tushganiga bog'liq bo'lib qoladi. To'liq qoida: `.claude/rules/dates.md`.
 * ------------------------------------------------------------------ */

/**
 * Formatlash uchun Date tayyorlaydi. Yaroqsiz qiymatda `null`.
 *
 * @param {Date|string|number|null|undefined} value
 * @param {boolean} utc `true` — qiymat UTC yarim tunida saqlangan KUN
 *   (`@db.Date`, `Changelog.date`): getterlar UTC bo'yicha o'qiladi.
 *   `false` — haqiqiy instant (`createdAt`, `paidAt`): Toshkent devor-soatiga
 *   suriladi. Ikkalasi ham keyin `getUTC*` bilan o'qiladi.
 * @returns {Date|null}
 */
const toDisplayDate = (value, utc) => {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return utc ? date : new Date(date.getTime() + TASHKENT_OFFSET_MS);
};

/**
 * Kanonik sana: "21-may, 2025".
 *
 * @param {Date|string|number|null} value
 * @param {{fallback?: string, utc?: boolean}} [options]
 *   `utc: true` — kun aniqligidagi maydonlar uchun (`StudentEnrollment.startDate`,
 *   `Changelog.date`). Ular UTC yarim tunida yotadi va Toshkentga surilsa
 *   kun raqami o'zgarmasa-da, mantiq chalkashadi.
 * @returns {string}
 */
const formatDateUz = (value, { fallback = "—", utc = false } = {}) => {
  const date = toDisplayDate(value, utc);
  if (!date) return fallback;

  return `${date.getUTCDate()}-${MONTHS_UZ[date.getUTCMonth()]}, ${date.getUTCFullYear()}`;
};

/**
 * Vaqt: "14:30" (Toshkent devor-soati).
 * @param {Date|string|number|null} value
 * @param {{fallback?: string}} [options]
 * @returns {string}
 */
const formatTimeUz = (value, { fallback = "—" } = {}) => {
  const date = toDisplayDate(value, false);
  if (!date) return fallback;

  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
};

/**
 * Kanonik sana + vaqt: "21-may, 2025 14:30" (Toshkent devor-soati).
 * @param {Date|string|number|null} value
 * @param {{fallback?: string}} [options]
 * @returns {string}
 */
const formatDateTimeUz = (value, { fallback = "—" } = {}) => {
  const date = toDisplayDate(value, false);
  if (!date) return fallback;

  return `${formatDateUz(value)} ${formatTimeUz(value)}`;
};

/**
 * Sana oralig'i: "21-may, 2025 — 30-iyun, 2025".
 * Oxiri bo'lmasa — "21-may, 2025 dan (hozirgacha)".
 * @param {Date|string|null} start
 * @param {Date|string|null} end
 * @param {{fallback?: string, utc?: boolean, openLabel?: string}} [options]
 * @returns {string}
 */
const formatDateRangeUz = (
  start,
  end,
  { fallback = "—", utc = false, openLabel = "hozirgacha" } = {},
) => {
  const from = formatDateUz(start, { fallback: "", utc });
  if (!from) return fallback;

  const to = formatDateUz(end, { fallback: "", utc });
  return to ? `${from} — ${to}` : `${from} dan (${openLabel})`;
};

module.exports = {
  getNowInUzbekistan,
  getTashkentDateUtc,
  formatDateUz,
  formatTimeUz,
  formatDateTimeUz,
  formatDateRangeUz,
  MONTHS_UZ,
  MONTHS_UZ_CAP,
  getCurrentDayUz,
  getDayNameUz,
  getDateRangeForDay,
  isSunday,
  isToday,
  isSameDay,
  getTomorrowStart,
  timeToMinutes,
  getCurrentTimeInMinutes,
  minutesToTime,
  checkGradingTimeWindow,
};
