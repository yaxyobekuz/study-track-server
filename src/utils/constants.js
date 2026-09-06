const { config } = require("../config/env.config");

// Roles
const ROLES = {
  OWNER: "owner",
  TEACHER: "teacher",
  STUDENT: "student",
  DEVELOPER: "developer",
  RECEPTION: "reception",
};

/**
 * FAOLLIK KANALLARI — `ActivityChannel` enumining nusxasi.
 *
 * ⚠️ Prisma enumini `require` qilib bo'lmaydi (u generatsiya qilingan
 * tipda, ish vaqtida qiymat sifatida yo'q), shuning uchun ro'yxat shu
 * yerda. Schema o'zgarsa ikkalasi ham tahrirlanadi — `permissions.js`
 * bilan admin paneli o'rtasidagi qo'lda sinxron bilan bir xil qoida.
 */
const ACTIVITY_CHANNELS = [
  "bot",
  "admin",
  "teacher",
  "student",
  "reception",
  "worker",
];

/** Kanal → foydalanuvchiga ko'rinadigan nom. */
const ACTIVITY_CHANNEL_LABELS = {
  bot: "Telegram bot",
  admin: "Admin panel",
  teacher: "O'qituvchi paneli",
  student: "O'quvchi paneli",
  reception: "Qabulxona",
  worker: "Xodim paneli",
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
  ACTIVITY_CHANNELS,
  ACTIVITY_CHANNEL_LABELS,
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
