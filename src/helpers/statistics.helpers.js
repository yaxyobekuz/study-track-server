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
  // ⚠️ KALENDAR YILI (1-yanvardan), "oxirgi 365 kun" EMAS — qolgan uchtasi
  // bilan AYNI qoida. O'QUV YILI EMAS: bu domenda o'quv yili tushunchasi
  // yo'q (`education.md` §1) va uni reyting orqali qaytarib kiritish
  // "sentabrdan boshlanadigan davr" degan ikkinchi taqvim yaratardi.
  year: Object.freeze({ key: "year", title: "Yillik", label: "Bu yil" }),
});

const STATISTICS_PERIOD_KEYS = Object.freeze(Object.keys(STATISTICS_PERIODS));

/** Kunning boshi / oxiri (Toshkent devor-soati bo'yicha). */
const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfDay = (date) => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
};

/**
 * "YYYY-MM-DD" → kalendar kuni. Yaroqsiz bo'lsa `null`.
 *
 * ⚠️ `new Date("2026-10-19")` ISHLATILMAYDI: u qiymatni UTC yarim tuni deb
 * o'qiydi va keyingi `getDate()` lokal kunni qaytarib, sanani bir kunga
 * siljitardi (`dates.md` §4). Kun bo'laklardan quriladi.
 *
 * ⚠️ Mavjud bo'lmagan sana ("2026-02-31") rad etiladi: JS uni jimgina
 * 3-martga aylantirardi va foydalanuvchi so'ramagan davr ochilardi.
 */
const parseDayKey = (value) => {
  if (typeof value !== "string") return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);

  const valid =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day;

  return valid ? date : null;
};

/** Kalendar kunini "YYYY-MM-DD" ga aylantiradi (API qiymati, format emas). */
const toDayKey = (date) => {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};

/** Berilgan sana tegishli haftaning dushanbasi. */
const mondayOf = (date) => {
  const day = date.getDay(); // 0 = yakshanba
  const back = day === 0 ? 6 : day - 1;
  const monday = new Date(date);
  monday.setDate(date.getDate() - back);
  return startOfDay(monday);
};

/**
 * Tanlangan davrning chegaralari.
 *
 * ⚠️ DAVR ISTALGAN KUNGA OCHILADI (`dateKey` — "YYYY-MM-DD"): o'tgan
 * hafta, o'tgan oy yoki aniq bir kun. Berilmasa — bugungi davr.
 *
 * ⚠️ OXIRI HECH QACHON BUGUNDAN OSHMAYDI: joriy hafta/oy tanlanganda
 * oraliq bugun bilan tugaydi (avvalgi xatti-harakat AYNAN shu), o'tgan
 * davrlarda esa to'liq hafta (dushanba–yakshanba) yoki to'liq oy olinadi.
 * Kelajakdagi sana so'ralsa, u bugunga tushiriladi — "hali bo'lmagan
 * hafta" degan bo'sh ro'yxat ochilmaydi.
 *
 * ⚠️ NOMA'LUM DAVR KALITI → HAFTALIK: davr — ko'rsatish filtri, ma'lumot
 * emas. Eski mijoz (`period` yubormaydigan student paneli, bot, monitor)
 * va noto'g'ri yozilgan qiymat AVVALGIDEK haftalik reytingni oladi.
 *
 * ⚠️ `weekStart`/`weekEnd`/`weekNumber`/`year` javobda QOLADI: ular
 * mijozlar bilan tuzilgan shartnoma. Yangi kodda `start`/`end` ishlatiladi.
 *
 * @param {string} [periodKey] - "day" | "week" | "month"
 * @param {string} [dateKey] - "YYYY-MM-DD"; bo'sh bo'lsa bugun
 * @returns {{period: string, title: string, date: string, isCurrent: boolean, start: Date, end: Date, weekStart: Date, weekEnd: Date, weekNumber: number, year: number}}
 */
const getStatisticsPeriodRange = (periodKey, dateKey) => {
  const period = STATISTICS_PERIODS[periodKey] || STATISTICS_PERIODS.week;

  const today = getNowInUzbekistan();
  const todayStart = startOfDay(today);
  const todayEnd = endOfDay(today);

  const requested = parseDayKey(dateKey);
  const anchor =
    requested && startOfDay(requested) <= todayStart ? requested : today;

  let start;
  let end;

  if (period.key === "day") {
    start = startOfDay(anchor);
    end = endOfDay(anchor);
  } else if (period.key === "week") {
    start = mondayOf(anchor);
    const sunday = new Date(start);
    sunday.setDate(start.getDate() + 6);
    end = endOfDay(sunday);
  } else if (period.key === "month") {
    start = startOfDay(
      new Date(anchor.getFullYear(), anchor.getMonth(), 1),
    );
    end = endOfDay(
      new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0),
    );
  } else {
    start = startOfDay(new Date(anchor.getFullYear(), 0, 1));
    end = endOfDay(new Date(anchor.getFullYear(), 11, 31));
  }

  if (end > todayEnd) end = todayEnd;

  return {
    period: period.key,
    title: period.title,
    date: toDayKey(anchor),
    // ⚠️ ORALIQNING KUN KALITLARI — EKRANDAGI YORLIQ UCHUN.
    // `start`/`end` — INSTANT va ular serverning "Toshkent devor-soati"
    // ramkasida quriladi: oxiri 23:59:59 bo'lgani uchun brauzerda +5
    // soat surilib, yorliqda KEYINGI kun chiqardi ("26-oktabr —
    // 30-oktabr", holbuki hafta 29-da tugaydi). Kun kaliti esa soatsiz,
    // ya'ni hech qayerga surilmaydi (`dates.md` §4).
    startDay: toDayKey(start),
    endDay: toDayKey(end),
    // Davr bugunni qamraydimi — panel "keyingi" tugmasini shunga qarab yopadi
    isCurrent: end.getTime() === todayEnd.getTime(),
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
