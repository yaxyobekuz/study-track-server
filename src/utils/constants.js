const { config } = require("../config/env.config");

// Roles
const ROLES = {
  OWNER: "owner",
  TEACHER: "teacher",
  STUDENT: "student",
  DEVELOPER: "developer",
  RECEPTION: "reception",
};

// Days of the week
const DAYS = {
  MONDAY: "dushanba",
  TUESDAY: "seshanba",
  WEDNESDAY: "chorshanba",
  THURSDAY: "payshanba",
  FRIDAY: "juma",
  SATURDAY: "shanba",
};

// Hafta kunlari massivi (o'zbek tilida)
const DAYS_UZ = [
  "yakshanba", // 0 - Sunday
  "dushanba", // 1 - Monday
  "seshanba", // 2 - Tuesday
  "chorshanba", // 3 - Wednesday
  "payshanba", // 4 - Thursday
  "juma", // 5 - Friday
  "shanba", // 6 - Saturday
];

/**
 * Oy nomlari — matn ichida, kun bilan birga: "21-may, 2025".
 * `getMonth()` tartibida (0 = yanvar).
 *
 * Bu yerda turadi, `date.helpers.js` da emas: moliya domeni (`month.helpers.js`)
 * ham shu nomlarga muhtoj, lekin `date.helpers.js` ga bog'lanmasligi kerak
 * (`finance.md` §0 — u `toLocaleString` ga tayanadi).
 */
const MONTHS_UZ = [
  "yanvar",
  "fevral",
  "mart",
  "aprel",
  "may",
  "iyun",
  "iyul",
  "avgust",
  "sentabr",
  "oktabr",
  "noyabr",
  "dekabr",
];

/** Oy nomlari — mustaqil yorliq sifatida: "Yanvar, 2026". */
const MONTHS_UZ_CAP = MONTHS_UZ.map((m) => m[0].toUpperCase() + m.slice(1));

/**
 * Qisqa oy nomlari — FAQAT diagramma o'qi uchun, u yerda 12 ta to'liq nom
 * sig'maydi ("Avgust, 2026" × 12 → o'qi o'qib bo'lmas holga keladi).
 * Jadval, sarlavha va matnda TO'LIQ nom ishlatiladi.
 */
const MONTHS_UZ_SHORT = [
  "Yan",
  "Fev",
  "Mar",
  "Apr",
  "May",
  "Iyn",
  "Iyl",
  "Avg",
  "Sen",
  "Okt",
  "Noy",
  "Dek",
];

// Baho chegaralari
const GRADE_MIN = 1;
const GRADE_MAX = 5;

// Pagination default qiymatlari
const PAGINATION_DEFAULTS = {
  PAGE: 1,
  LIMIT: 24,
};

// Grade time constraints
const GRADE_TIME_LIMIT_MINUTES = config.gradeTimeLimitMinutes;
const ENABLE_SCHEDULE_TIME_VALIDATION = config.enableScheduleTimeValidation;

module.exports = {
  ROLES,
  DAYS,
  DAYS_UZ,
  MONTHS_UZ,
  MONTHS_UZ_CAP,
  MONTHS_UZ_SHORT,
  GRADE_MIN,
  GRADE_MAX,
  PAGINATION_DEFAULTS,
  GRADE_TIME_LIMIT_MINUTES,
  ENABLE_SCHEDULE_TIME_VALIDATION,
};
