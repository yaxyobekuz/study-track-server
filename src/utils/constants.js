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
  // Ota-ona mobil ilovasi (ota-ona nazorati). ⚠️ O'quvchi hisobi bilan
  // kiradi — bola telefonidan (`student`) faqat shu kanal ajratadi.
  "parent",
];

/** Kanal → foydalanuvchiga ko'rinadigan nom. */
const ACTIVITY_CHANNEL_LABELS = {
  bot: "Telegram bot",
  admin: "Admin panel",
  teacher: "O'qituvchi paneli",
  student: "O'quvchi paneli",
  reception: "Qabulxona",
  worker: "Xodim paneli",
  parent: "Ota-ona ilovasi",
};

/* ───────────────────────── OTA-ONA NAZORATI ───────────────────────── */

/**
 * HECH QACHON BLOKLANMAYDIGAN ilovalar — raqam terish, SMS, favqulodda.
 *
 * ⚠️ SOZLAMA EMAS, DOIMIY (`devices.md` §0.3 bilan bir xil etik pol):
 * bloklangan telefon bolani yordam so'rashdan mahrum qila olmaydi. Server
 * bularni bloklash / limit qo'yishni RAD ETADI, policy'da esa qurilmaga
 * `alwaysAllowed` bo'lib boradi. O'quvchi ilovasining o'z paketini
 * qurilmaning o'zi qo'shadi (u paket nomini server bilmaydi).
 */
const PARENTAL_ALWAYS_ALLOWED = Object.freeze([
  "com.android.dialer",
  "com.google.android.dialer",
  "com.android.mms",
  "com.google.android.apps.messaging",
  "com.android.emergency",
]);

/**
 * "HIMOYALANGAN" DEGANI — qaysi ruxsatlar BIRGA yoqilgan bo'lishi kerak.
 *
 * Qurilma `PUT /parental/device/health` da har bir ruxsatning holatini
 * yuboradi, `protected` esa SHU ro'yxatdan hisoblanadi (bitta joy).
 * `batteryOk` ataylab kirmaydi: batareya optimizatsiyasi fon ishini
 * sekinlashtiradi, lekin blokni o'chirmaydi — u faqat maslahat.
 */
const PARENTAL_REQUIRED_HEALTH = Object.freeze({
  android: Object.freeze(["usageAccess", "accessibility", "deviceAdmin", "overlay"]),
  ios: Object.freeze(["familyControls"]),
});

/** Hodisa turi → ota-onaga ko'rinadigan nom (`GET /parental/events`). */
const PARENTAL_EVENT_LABELS = Object.freeze({
  permission_revoked: "Himoya o'chirildi",
  protection_restored: "Himoya tiklandi",
  uninstall_attempt: "Ilovani o'chirishga urinish",
  wrong_pin: "Noto'g'ri PIN",
  unlocked: "PIN bilan ochildi",
  offline: "Telefon aloqaga chiqmadi",
  unlock_request: "Ruxsat so'rovi",
  pin_set: "PIN o'rnatildi",
  pin_changed: "PIN almashtirildi",
  pin_reset: "PIN tiklandi (parol bilan)",
});

// Days of the week
const DAYS = {
  MONDAY: "dushanba",
  TUESDAY: "seshanba",
  WEDNESDAY: "chorshanba",
  THURSDAY: "payshanba",
  FRIDAY: "juma",
  SATURDAY: "shanba",
};

// ISH VAQTI MANBAI — `WorkTimeSource` enumining ko'zgusi (schema.prisma).
// Prisma enum qiymatlari matn sifatida keladi, shuning uchun taqqoslash
// har joyda shu konstantalar orqali yoziladi.
const WORK_TIME_SOURCE = {
  MANUAL: "manual",
  SCHEDULE: "schedule",
};

// DARS JADVALIDAN ishlaydigan o'qituvchi ishga o'sha kuni o'tadigan BIRINCHI
// darsidan shuncha daqiqa OLDIN kelishi shart (biznes qarori, 2026-10-02).
// Kechikish shu kelish vaqtidan sanaladi; davomat sozlamasidagi kechikish
// imtiyozi (`lateArrivalGraceMinutes`) boshqa xodimlardagi kabi ustiga qo'shiladi.
const SCHEDULE_ARRIVAL_LEAD_MINUTES = 10;

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
const ENABLE_SCHEDULE_TIME_VALIDATION = config.enableScheduleTimeValidation;

module.exports = {
  ROLES,
  ACTIVITY_CHANNELS,
  ACTIVITY_CHANNEL_LABELS,
  PARENTAL_ALWAYS_ALLOWED,
  PARENTAL_REQUIRED_HEALTH,
  PARENTAL_EVENT_LABELS,
  DAYS,
  DAYS_UZ,
  WORK_TIME_SOURCE,
  SCHEDULE_ARRIVAL_LEAD_MINUTES,
  MONTHS_UZ,
  MONTHS_UZ_CAP,
  MONTHS_UZ_SHORT,
  GRADE_MIN,
  GRADE_MAX,
  PAGINATION_DEFAULTS,
  ENABLE_SCHEDULE_TIME_VALIDATION,
};
