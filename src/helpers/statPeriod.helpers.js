/**
 * DASHBOARD DAVRLARI — "Kunlik / Haftalik / Oylik / Yillik".
 *
 * Bosh sahifadagi kartalarda davr tanlagich bor va u HAR KARTADA bir xil
 * ma'noni bildirishi shart: "oylik" bitta kartada "oyning 1-kunidan
 * bugungacha", ikkinchisida "oxirgi 30 kun" bo'lsa, ikkala raqam yonma-yon
 * turib bir-biriga zid ko'rinardi. Shuning uchun davr chegarasi BITTA
 * joyda hisoblanadi va uni `taskReport.service.js` ham,
 * `attendanceStats.service.js` ham shu yerdan oladi.
 *
 * ⚠️ CHEGARA SERVERDA, TOSHKENT VAQTIDA (`education.md` §9). Brauzer
 * mintaqasi boshqa bo'lsa "bugun" bir kunga siljib ketardi.
 *
 * ⚠️ DAVR BUGUN BILAN TUGAYDI: "oylik" — oyning 1-kunidan BUGUNGACHA,
 * tugagan oy EMAS. Bosh sahifa "hozir qanday" degan savolga javob beradi.
 */

const { formatDateUz, formatDateRangeUz, getTashkentDateUtc } = require("./date.helpers");
const { formatMonthKey } = require("./month.helpers");

const DAY_MS = 86400000;

/** Tanlagichdagi davrlar — panel ro'yxati bilan AYNI tartibda. */
const PERIOD_PRESETS = ["day", "week", "month", "year"];

const PERIOD_LABELS = {
  day: "Kunlik",
  week: "Haftalik",
  month: "Oylik",
  year: "Yillik",
  custom: "Tanlangan davr",
};

/** Oldingi davrning nomi — taqqoslash qatorida yoziladi. */
const PREVIOUS_LABELS = {
  day: "O'tgan kun",
  week: "O'tgan hafta",
  month: "O'tgan oy",
  year: "O'tgan yil",
  custom: "Oldingi davr",
};

const isoDay = (date) => date.toISOString().slice(0, 10);

/** "YYYY-MM-DD" → UTC yarim tunidagi Date (kun kaliti bilan ishlash uchun). */
const dayDate = (key) => new Date(`${key}T00:00:00Z`);

const shiftDays = (key, delta) => isoDay(new Date(dayDate(key).getTime() + delta * DAY_MS));

/** Kun kaliti → o'sha haftaning DUSHANBASI (hafta kuni indeksi bilan AYNI). */
const weekKey = (key) => {
  const d = dayDate(key);
  return isoDay(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS));
};

const monthKey = (key) => `${key.slice(0, 7)}-01`;

const bucketKey = (key, granularity) =>
  granularity === "day" ? key : granularity === "week" ? weekKey(key) : monthKey(key);

/**
 * BO'LAK YORLIG'I — dinamika jadvalidagi qator nomi.
 *
 * ⚠️ MATN SERVERDA YIG'ILADI: AYNI qator Word hujjatida ham, ekrandagi
 * hujjatda ham turadi (`.claude/rules/dates.md` — sana matni bitta
 * manbadan).
 */
const bucketLabel = (key, granularity) => {
  if (granularity === "month") {
    return formatMonthKey(Number(`${key.slice(0, 4)}${key.slice(5, 7)}`));
  }

  const day = formatDateUz(key, { utc: true });
  return granularity === "week" ? `${day} dan boshlangan hafta` : day;
};

/** Davrning barcha bo'laklari — bo'sh kunlar ham nol bo'lib turishi uchun. */
const buildBuckets = (fromKey, toKey, granularity) => {
  const keys = [];
  const seen = new Set();

  for (let t = dayDate(fromKey).getTime(); t <= dayDate(toKey).getTime(); t += DAY_MS) {
    const key = bucketKey(isoDay(new Date(t)), granularity);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }

  return keys;
};

/**
 * DAVR MATNI — "27-oktabr, 2026" yoki "1-oktabr, 2026 — 27-oktabr, 2026".
 *
 * ⚠️ PRESET NOMI (oylik / yillik) O'RNIGA ANIQ ORALIQ yoziladi: hujjatni
 * "Oktabr, 2026" deb sarlavhalash uni TUGAGAN oy hisoboti qilib
 * ko'rsatardi va oy oxirida boshqa raqam chiqqanda hujjat "noto'g'ri"
 * bo'lib qolardi.
 */
const periodLabel = (fromKey, toKey) =>
  fromKey === toKey
    ? formatDateUz(fromKey, { utc: true })
    : formatDateRangeUz(fromKey, toKey, { utc: true });

/** Oraliqdagi kunlar soni (ikkala chegara ham kiradi). */
const rangeDays = (fromKey, toKey) =>
  Math.round((dayDate(toKey).getTime() - dayDate(fromKey).getTime()) / DAY_MS) + 1;

/** Bo'lak o'lchovi: qisqa davr kun, o'rtachasi hafta, uzuni oy bo'yicha. */
const granularityOf = (days) => (days <= 31 ? "day" : days <= 120 ? "week" : "month");

/**
 * PRESET → oraliq. Noma'lum preset uchun `null` (chaqiruvchi o'z sukutini beradi).
 *
 * @param {string} preset - "day" | "week" | "month" | "year"
 * @returns {{from: string, to: string}|null}
 */
const resolvePresetRange = (preset) => {
  const todayKey = isoDay(getTashkentDateUtc(0));

  switch (preset) {
    case "day":
      return { from: todayKey, to: todayKey };
    case "week": {
      // Hafta DUSHANBADAN boshlanadi (hisobotdagi `weekday` indeksi bilan AYNI)
      return { from: weekKey(todayKey), to: todayKey };
    }
    case "month":
      return { from: `${todayKey.slice(0, 7)}-01`, to: todayKey };
    case "year":
      return { from: `${todayKey.slice(0, 4)}-01-01`, to: todayKey };
    default:
      return null;
  }
};

/**
 * Oy/yil chegarasida kunni XAVFSIZ suradi: 31-mart − 1 oy → 28-fevral.
 *
 * `Date.UTC(2026, 1, 31)` 3-martga "oshib ketadi", ya'ni oldingi davr
 * keyingi oyga tushib qolardi. Shuning uchun kun oyning oxirgi kuniga
 * CHEGARALANADI.
 */
const shiftCalendar = (key, { months = 0, years = 0 } = {}) => {
  const d = dayDate(key);
  const year = d.getUTCFullYear() + years;
  const month = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  return isoDay(new Date(Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay))));
};

/**
 * OLDINGI DAVR — "o'tgan kun / o'tgan hafta / o'tgan oy / o'tgan yil".
 *
 * ⚠️ DAVRNING AYNI QISMI olinadi, to'liq oldingi davr EMAS: joriy oy 28
 * kunlik bo'lsa, oldingi oydan ham 28 kun olinadi. Aks holda 28 kunlik
 * oktabr 30 kunlik sentabr bilan solishtirilib, "kelganlar soni kamaydi"
 * degan YOLG'ON xulosa chiqardi — foiz esa normallashgani uchun to'g'ri
 * qolar edi va ikki raqam bir-biriga zid ko'rinardi.
 *
 * ⚠️ Preset bo'lmasa (qo'lda tanlangan oraliq) — AYNI uzunlikdagi, darhol
 * oldin turgan oyna.
 *
 * @param {{fromKey: string, toKey: string, preset: string|null}} period
 * @returns {{fromKey: string, toKey: string, days: number, label: string, title: string}}
 */
const previousRange = ({ fromKey, toKey, preset }) => {
  let from;
  let to;

  switch (preset) {
    case "day":
      from = shiftDays(fromKey, -1);
      to = shiftDays(toKey, -1);
      break;
    case "week":
      from = shiftDays(fromKey, -7);
      to = shiftDays(toKey, -7);
      break;
    case "month":
      from = shiftCalendar(fromKey, { months: -1 });
      to = shiftCalendar(toKey, { months: -1 });
      break;
    case "year":
      from = shiftCalendar(fromKey, { years: -1 });
      to = shiftCalendar(toKey, { years: -1 });
      break;
    default: {
      const days = rangeDays(fromKey, toKey);
      from = shiftDays(fromKey, -days);
      to = shiftDays(fromKey, -1);
    }
  }

  return {
    fromKey: from,
    toKey: to,
    days: rangeDays(from, to),
    label: periodLabel(from, to),
    title: PREVIOUS_LABELS[preset] ?? PREVIOUS_LABELS.custom,
  };
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * SO'ROVDAN DAVR — preset yoki qo'lda tanlangan oraliq.
 *
 * @param {{period?: string, from?: string, to?: string}} query
 * @param {{maxDays?: number, defaultDays?: number, onError?: (msg: string) => Error}} [options]
 * @returns {{key: string, label: string, fromKey: string, toKey: string, days: number,
 *   granularity: string, rangeLabel: string, includesToday: boolean,
 *   start: Date, end: Date, previous: object}}
 */
const resolveStatPeriod = (query = {}, options = {}) => {
  const { maxDays = 366, defaultDays = 30, onError } = options;
  const fail = (message) => {
    throw onError ? onError(message) : new Error(message);
  };

  const todayKey = isoDay(getTashkentDateUtc(0));
  const preset = resolvePresetRange(query.period);

  const toKey = preset
    ? preset.to
    : DATE_RE.test(query.to || "")
      ? query.to
      : todayKey;

  const fromKey = preset
    ? preset.from
    : DATE_RE.test(query.from || "")
      ? query.from
      : shiftDays(toKey, -(defaultDays - 1));

  const days = rangeDays(fromKey, toKey);
  if (days < 1) fail("Davr boshi oxiridan keyin bo'lmasligi kerak");
  if (days > maxDays) fail("Davr bir yildan oshmasligi kerak");

  const key = preset ? query.period : "custom";

  return {
    key,
    label: PERIOD_LABELS[key] ?? PERIOD_LABELS.custom,
    fromKey,
    toKey,
    days,
    granularity: granularityOf(days),
    rangeLabel: periodLabel(fromKey, toKey),
    includesToday: toKey === todayKey,
    todayKey,
    // ⚠️ `@db.Date` (davomat kuni) UTC yarim tunida yotadi — oraliq ham
    // shu o'lchovda beriladi (`dates.md` §4).
    start: dayDate(fromKey),
    end: dayDate(toKey),
    previous: previousRange({ fromKey, toKey, preset: preset ? query.period : null }),
  };
};

module.exports = {
  DAY_MS,
  PERIOD_PRESETS,
  PERIOD_LABELS,
  PREVIOUS_LABELS,
  isoDay,
  dayDate,
  shiftDays,
  weekKey,
  monthKey,
  bucketKey,
  bucketLabel,
  buildBuckets,
  periodLabel,
  rangeDays,
  granularityOf,
  resolvePresetRange,
  previousRange,
  resolveStatPeriod,
};
