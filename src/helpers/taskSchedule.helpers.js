/**
 * DOIMIY TOPSHIRIQ QOIDASI — "qaysi kunlarda" va "soat nechada" degan
 * savollarning YAGONA javobi (sof funksiyalar, bazasiz).
 *
 * Qoidaning o'zi topshiriq emas: cron shu yerdagi hisobdan foydalanib
 * HAQIQIY topshiriqlarni vaqtidan oldin yaratadi
 * (`taskSchedule.service.js`), paneldagi "keyingi topshiriq" matni ham
 * shu yerdan chiqadi. Ikkita nusxa bo'lsa, panel bir kunni, cron boshqa
 * kunni ko'rsatardi.
 *
 * ⚠️ KUN — TOSHKENT KUNI, UTC yarim tunida saqlanadi (`@db.Date`,
 * `dates.md` §4). Hamma hisob `getUTC*` bilan: host taymzonasi aralashsa
 * "dushanba" bir kunga siljib ketardi.
 */

// Toshkent — UTC+5, DST yo'q (`education.md` §9)
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ⚠️ `parseClock` / `formatClock` QAYTA YOZILMAYDI — ular sof, sinovdan
// o'tgan vaqt utilitalari (`devicePolicy.helpers.test.js`). Nusxa ko'chirish
// "08:30" ni ikki xil o'qiydigan ikkinchi talqin hosil qilardi.
const { parseClock, formatClock } = require("./devicePolicy.helpers");

/**
 * weekly — haftaning tanlangan kunlari ("har dushanba va chorshanba")
 * days   — har N kunda ("har 10 kunda")
 * months — har N oyda, oyning tanlangan kunlari ("3 oyda bir, 1-kuni")
 */
const FREQUENCIES = ["weekly", "days", "months"];

// 0 = yakshanba — JS `getDay()` va `DAYS_UZ` bilan AYNI konvensiya
// (`devices.md` §1: "yangi konvensiya kiritilmaydi")
const WEEKDAY_NAMES = [
  "yakshanba",
  "dushanba",
  "seshanba",
  "chorshanba",
  "payshanba",
  "juma",
  "shanba",
];

const MAX_LEAD_DAYS = 30;
const MAX_DUE_OFFSET_DAYS = 30;
const MAX_INTERVAL_DAYS = 365;
const MAX_INTERVAL_MONTHS = 24;

// ─── KUN ARIFMETIKASI (UTC yarim tuni) ────────────────────────────

const addDays = (day, count) => new Date(day.getTime() + count * DAY_MS);

const daysBetween = (from, to) => Math.round((to.getTime() - from.getTime()) / DAY_MS);

const monthsBetween = (from, to) =>
  (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
  (to.getUTCMonth() - from.getUTCMonth());

/** O'sha oyda nechta kun bor (31-fevralni surish uchun). */
const daysInMonthOf = (day) =>
  new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();

/**
 * Toshkent kuni + devor-soati → haqiqiy instant.
 * @param {Date} day - UTC yarim tuni
 * @param {number} minuteOfDay - 0..1439
 */
const tashkentInstant = (day, minuteOfDay) =>
  new Date(day.getTime() - TASHKENT_OFFSET_MS + minuteOfDay * 60000);

// ─── QOIDA ────────────────────────────────────────────────────────

/**
 * Shu kunda topshiriq tushadimi.
 *
 * @param {object} schedule - `TaskSchedule` qatori
 * @param {Date} day - Toshkent kuni (UTC yarim tuni)
 * @returns {boolean}
 */
const occursOn = (schedule, day) => {
  if (!schedule || !day) return false;

  const start = schedule.startDate;
  if (day.getTime() < start.getTime()) return false;
  if (schedule.endDate && day.getTime() > schedule.endDate.getTime()) return false;

  switch (schedule.frequency) {
    case "weekly":
      return (schedule.weekdays || []).includes(day.getUTCDay());

    case "days": {
      const step = schedule.intervalDays || 1;
      const diff = daysBetween(start, day);
      return diff >= 0 && diff % step === 0;
    }

    case "months": {
      const step = schedule.intervalMonths || 1;
      const diff = monthsBetween(start, day);
      if (diff < 0 || diff % step !== 0) return false;

      // ⚠️ Oyda yo'q kun OXIRGI KUNGA suriladi: "har oyning 31-kuni"
      // qoidasi fevralda jimgina tushib qolmasligi kerak.
      const last = daysInMonthOf(day);
      const wanted = new Set((schedule.monthDays || []).map((d) => Math.min(d, last)));
      return wanted.has(day.getUTCDate());
    }

    default:
      return false;
  }
};

/**
 * Oraliqdagi barcha hodisa kunlari (ikkala chekka ham kiradi).
 *
 * @param {object} schedule
 * @param {Date} fromDay
 * @param {Date} toDay
 * @param {number} [limit=120] - zaxira to'siq (buzuq qoida tsiklni cho'zmasin)
 * @returns {Date[]}
 */
const occurrencesInRange = (schedule, fromDay, toDay, limit = 120) => {
  const result = [];
  if (!schedule || fromDay.getTime() > toDay.getTime()) return result;

  for (
    let day = fromDay;
    day.getTime() <= toDay.getTime() && result.length < limit;
    day = addDays(day, 1)
  ) {
    if (occursOn(schedule, day)) result.push(day);
  }
  return result;
};

/**
 * Berilgan kundan keyingi (shu kun ham) BIRINCHI hodisa — panel
 * "keyingi topshiriq" ni shundan ko'rsatadi.
 *
 * @param {object} schedule
 * @param {Date} fromDay
 * @param {number} [horizonDays=400] - bir yildan nariga qaralmaydi
 * @returns {Date|null}
 */
const nextOccurrence = (schedule, fromDay, horizonDays = 400) => {
  if (!schedule?.isActive) return null;
  const start = fromDay.getTime() < schedule.startDate.getTime() ? schedule.startDate : fromDay;
  const [first] = occurrencesInRange(schedule, start, addDays(start, horizonDays), 1);
  return first ?? null;
};

/**
 * Hodisa kuni → topshiriqning haqiqiy vaqt oynasi.
 *
 * ⚠️ MUDDAT `dueOffsetDays` BILAN surilishi mumkin: "dushanba 08:10 dan
 * chorshanba 18:00 gacha" degan topshiriq shunday ifodalanadi.
 *
 * @param {object} schedule
 * @param {Date} day
 * @returns {{ startDate: Date|null, dueDate: Date }}
 */
const buildWindow = (schedule, day) => {
  const dueMinute = parseClock(schedule.dueTime) ?? 0;
  const dueDay = addDays(day, schedule.dueOffsetDays || 0);
  const startMinute = schedule.startTime ? parseClock(schedule.startTime) : null;

  return {
    startDate: startMinute === null ? null : tashkentInstant(day, startMinute),
    dueDate: tashkentInstant(dueDay, dueMinute),
  };
};

/**
 * Qoida matni — "Har dushanba, chorshanba · 08:10".
 *
 * ⚠️ SERVERDA quriladi: push xabari va panel AYNI matnni ko'rsatishi kerak
 * (`dates.md` §5.3 — tayyor `*Label` matn ham yagona qoidaga bo'ysunadi).
 *
 * @param {object} schedule
 * @returns {string}
 */
const describeSchedule = (schedule) => {
  if (!schedule) return "—";
  const time = schedule.startTime
    ? `${schedule.startTime}–${schedule.dueTime}`
    : schedule.dueTime;

  let rule;
  switch (schedule.frequency) {
    case "weekly": {
      const days = [...(schedule.weekdays || [])]
        // Dushanbadan boshlab tartiblaymiz (yakshanba — oxirida)
        .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
        .map((d) => WEEKDAY_NAMES[d])
        .join(", ");
      rule = days ? `Har ${days}` : "Har hafta";
      break;
    }
    case "days": {
      const step = schedule.intervalDays || 1;
      rule = step === 1 ? "Har kuni" : `Har ${step} kunda`;
      break;
    }
    case "months": {
      const step = schedule.intervalMonths || 1;
      const days = (schedule.monthDays || []).slice().sort((a, b) => a - b).join(", ");
      const period = step === 1 ? "Har oy" : `Har ${step} oyda`;
      rule = days ? `${period}ning ${days}-kuni` : period;
      break;
    }
    default:
      rule = "—";
  }

  const tail = schedule.dueOffsetDays > 0 ? ` (+${schedule.dueOffsetDays} kun)` : "";
  return `${rule} · ${time}${tail}`;
};

module.exports = {
  FREQUENCIES,
  WEEKDAY_NAMES,
  MAX_LEAD_DAYS,
  MAX_DUE_OFFSET_DAYS,
  MAX_INTERVAL_DAYS,
  MAX_INTERVAL_MONTHS,
  addDays,
  daysBetween,
  monthsBetween,
  daysInMonthOf,
  tashkentInstant,
  occursOn,
  occurrencesInRange,
  nextOccurrence,
  buildWindow,
  describeSchedule,
  parseClock,
  formatClock,
};
