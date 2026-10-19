/**
 * SERTIFIKAT REJALARI — SOF FUNKSIYALAR.
 *
 * Importning eng nozik ikki joyi shu yerda va ikkalasi ham testlar bilan
 * qoplangan (`test/certificate.helpers.test.js`):
 *   1. SANA — fayl Google Forms'dan keladi va formati maktab sozlamasiga
 *      qarab o'zgaradi ("Dec 1, 2026", "01.12.2026", "9/29/2026 10:24:24").
 *   2. ISM — qo'lda yozilgan, xato bilan ("Suhrobbrk"), ortiqcha bo'shliq
 *      va kirill/lotin aralash bo'lishi mumkin.
 *
 * ⚠️ Bu fayl BAZAGA TEGMAYDI va `prisma` ni import qilmaydi: moslashtirish
 * qoidasini bazasiz sinab ko'rish mumkin bo'lishi kerak.
 */

const { MONTHS_UZ } = require("../utils/constants");

/* ─────────────────────────── HOLATLAR ─────────────────────────── */

/** `CertificatePlanStatus` enumi bilan AYNI — xizmat qatlamining kaliti. */
const PLAN_STATUS = Object.freeze({
  PLANNED: "planned",
  PASSED: "passed",
  CANCELLED: "cancelled",
  SUPERSEDED: "superseded",
});

/** Reja AMALDA (statistika shuni sanaydi, slot band). */
const ACTIVE_STATUS = PLAN_STATUS.PLANNED;

/** Manba — qator qayerdan kelgani. */
const PLAN_SOURCE = Object.freeze({ MANUAL: "manual", IMPORT: "import" });

/**
 * FAOL REJANING yagona kaliti (`CertificatePlan.activeKey`).
 *
 * Har (o'quvchi + yo'nalish) uchun bitta faol reja: o'quvchi formani ikki
 * marta to'ldirsa, oxirgisi yutadi va eskisi `superseded` bo'lib qoladi.
 *
 * @param {string} studentId
 * @param {string} trackId
 * @returns {string}
 */
const planActiveKey = (studentId, trackId) => `${studentId}|${trackId}`;

/* ─────────────────────────── ISM ─────────────────────────── */

/**
 * ISMNI TAQQOSLASH UCHUN NORMALLASHTIRADI.
 *
 * Qo'lda yozilgan ismni tizimdagi `firstName`/`lastName` bilan solishtirish
 * uchun: kichik harf, apostrof variantlari (`ʻ ʼ ' ‘ ’ `` ´`) olib
 * tashlanadi, ketma-ket bo'shliqlar bittaga tushadi.
 *
 * ⚠️ `o'` → `o` QILINMAYDI va bu ataylab: "Olimov" bilan "O'limov" boshqa
 * odamlar bo'lishi mumkin. Apostrofning O'ZI olib tashlanadi, ya'ni
 * "O'limov" → "olimov" — bu YETARLI, chunki apostrof yozilgan-yozilmagani
 * bitta odamning imlo farqi.
 *
 * ⚠️ So'zlar TARTIBI saqlanadi. Tartibsiz taqqoslash alohida funksiyada
 * (`nameSortKey`): "Ummatillayev Halililloh" va "Halililloh Ummatillayev"
 * bitta odam, lekin bu QARORNI chaqiruvchi qiladi.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeName(value) {
  return String(value ?? "")
    .replace(/[‘’ʻʼ'`´]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * ISM — SO'ZLARI SARALANGAN KALIT.
 *
 * Formada "Familiya Ism" ham, "Ism Familiya" ham yoziladi; bazada esa
 * `firstName` va `lastName` alohida. So'zlarni saralab taqqoslash ikkala
 * tartibni ham bitta kalitga keltiradi.
 *
 * ⚠️ Otasining ismi yozilgan bo'lsa ("Ummatillayev Halililloh Akbar")
 * kalit mos kelmaydi — bu TAKLIF bosqichining ishi (`nameTokens`), chunki
 * jim moslashtirish boshqa odamni ulab yuborishi mumkin.
 *
 * @param {unknown} value
 * @returns {string}
 */
function nameSortKey(value) {
  return normalizeName(value).split(" ").filter(Boolean).sort().join(" ");
}

/**
 * Ismning so'zlari to'plami — qisman moslik (TAKLIF) uchun.
 *
 * @param {unknown} value
 * @returns {Set<string>}
 */
function nameTokens(value) {
  return new Set(normalizeName(value).split(" ").filter(Boolean));
}

/**
 * Ikki so'z orasidagi tahrir masofasi (Levenshtein).
 *
 * ⚠️ So'z darajasida taqqoslash YETARLI EMAS: ma'lumot qo'lda yozilgan va
 * "Suhrobbek" → "Suhrobbrk" kabi BITTA harf xatosi so'zni butunlay boshqa
 * so'z qilib qo'yadi. Faqat so'z to'plamiga qarasak bunday qator "hech
 * kimga o'xshamaydi" bo'lib, admin uni 153 qatordan qo'lda qidirardi.
 *
 * Ikki qator massiv bilan — ismlar qisqa, lekin funksiya har qator uchun
 * sinfdagi har o'quvchiga qarshi chaqiriladi.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length];
}

/**
 * Bitta so'z juftining mosligi — 0 yoki 0.75..1.
 *
 * Chegaradan pastdagi moslik NOL deb qaytariladi: "Ali" bilan "Olim"
 * qisman o'xshaydi, lekin bu MOSLIK emas va u taklif ro'yxatini begona
 * nomlar bilan to'ldirardi.
 */
const TOKEN_MATCH_MIN = 0.75;

function tokenSimilarity(a, b) {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 0;
  // Juda qisqa so'zda (≤ 3 harf) bitta xato ham boshqa so'z bo'ladi
  if (max <= 3) return 0;

  const ratio = 1 - editDistance(a, b) / max;
  return ratio >= TOKEN_MATCH_MIN ? ratio : 0;
}

/**
 * Ikki ism qanchalik mos — 0..1.
 *
 * Har so'z qarshi tomondagi ENG MOS so'z bilan juftlanadi (tartib muhim
 * emas: "Familiya Ism" ham, "Ism Familiya" ham bir xil chiqadi), natija
 * esa KO'PROQ so'zi bor tomonga bo'linadi. Shu sababli qo'shimcha so'z
 * (otasining ismi) ko'rsatkichni tushiradi — ya'ni bunday qator TAKLIFga
 * chiqadi, avtomatik moslashtirishga emas.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number} 0..1
 */
function nameSimilarity(a, b) {
  const left = [...nameTokens(a)];
  const right = [...nameTokens(b)];
  if (left.length === 0 || right.length === 0) return 0;

  const used = new Set();
  let score = 0;

  for (const token of left) {
    let bestIndex = -1;
    let best = 0;
    right.forEach((other, index) => {
      if (used.has(index)) return;
      const value = tokenSimilarity(token, other);
      if (value > best) {
        best = value;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) {
      used.add(bestIndex);
      score += best;
    }
  }

  return score / Math.max(left.length, right.length);
}

/* ─────────────────────────── SANA ─────────────────────────── */

const EN_MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * Oy nomi → 1..12 (o'zbekcha va inglizcha, qisqartmasi bilan).
 *
 * ⚠️ Oy nomlari ro'yxati bu yerda QAYTA YOZILMAYDI: o'zbekchasi
 * `utils/constants.js` dan olinadi (`dates.md` §2 — nusxa ko'chirilgan
 * massiv aynan shu qoida buzilishining sababi bo'lgan). Inglizcha ro'yxat
 * esa FORMAT EMAS, PARSER: u ekranga chiqmaydi, faqat Google Forms
 * eksportini o'qish uchun kerak.
 */
const MONTH_BY_NAME = (() => {
  const map = new Map();
  const add = (name, index) => {
    const key = name.toLowerCase();
    map.set(key, index + 1);
    // Qisqartma: "dec", "sen", "iyn" — fayllarda shunday ham uchraydi
    map.set(key.slice(0, 3), index + 1);
  };
  EN_MONTHS.forEach(add);
  MONTHS_UZ.forEach((name, index) => add(normalizeName(name), index));
  // "sentyabr"/"oktyabr" — keng tarqalgan imlo xatosi. Format sifatida
  // TAQIQLANGAN (`dates.md` §1), lekin o'qishda qabul qilinadi: yuklangan
  // faylni imlo xatosi uchun rad etish ma'nosiz.
  map.set("sentyabr", 9);
  map.set("oktyabr", 10);
  return map;
})();

/** Sana faqat KUN aniqligida yotadi — `@db.Date`, UTC yarim tuni. */
const toUtcDay = (year, month, day) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  // Mavjud bo'lmagan kun (31-fevral) Date tomonidan "siljitiladi" — rad
  // etiladi, aks holda muddat jimgina boshqa kunga tushib ketardi.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
};

/** Ikki xonali yil: 26 → 2026, 99 → 1999 (ISO-8601 oynasi). */
const expandYear = (year) => {
  if (year >= 1000) return year;
  if (year >= 100) return null;
  return year <= 68 ? 2000 + year : 1900 + year;
};

const NUMERIC_DATE = /^(\d{1,4})[./\-](\d{1,2})[./\-](\d{2,4})/;

/** `dmy` — kun oldin (o'zbekcha), `mdy` — oy oldin (Google Forms / AQSh). */
const DATE_ORDER = Object.freeze({ DMY: "dmy", MDY: "mdy" });

/**
 * USTUN BO'YICHA SANA TARTIBINI ANIQLAYDI.
 *
 * ⚠️ `01.12.2026` ni bitta qatorga qarab hal qilib bo'lmaydi: u ham
 * 1-dekabr, ham 12-yanvar bo'lishi mumkin. Shuning uchun qaror BUTUN
 * USTUN bo'yicha qabul qilinadi — faylda bitta `29/09` bo'lsa, u butun
 * ustunni "oy oldin" deb hal qiladi.
 *
 * Ovoz berish: `p1 > 12` → kun oldin, `p2 > 12` → oy oldin. Ikkalasi ham
 * uchrasa fayl ichida format ARALASH — bunda `fallback` qoladi va
 * chaqiruvchi ogohlantirish chiqaradi (`ambiguous`).
 *
 * @param {unknown[]} values
 * @param {string} [fallback]
 * @returns {{order: string, ambiguous: boolean, decided: boolean}}
 */
function detectDateOrder(values, fallback = DATE_ORDER.DMY) {
  let dmy = 0;
  let mdy = 0;

  for (const value of values || []) {
    if (value instanceof Date) continue;
    const match = NUMERIC_DATE.exec(String(value ?? "").trim());
    if (!match) continue;

    const p1 = Number(match[1]);
    const p2 = Number(match[2]);
    // 4 xonali birinchi qism — ISO (YYYY-MM-DD), tartibga aloqasi yo'q
    if (match[1].length === 4) continue;

    if (p1 > 12 && p2 <= 12) dmy += 1;
    else if (p2 > 12 && p1 <= 12) mdy += 1;
  }

  if (dmy > 0 && mdy === 0) return { order: DATE_ORDER.DMY, ambiguous: false, decided: true };
  if (mdy > 0 && dmy === 0) return { order: DATE_ORDER.MDY, ambiguous: false, decided: true };

  return { order: fallback, ambiguous: dmy > 0 && mdy > 0, decided: false };
}

/**
 * KATAKDAN KUNNI O'QIYDI (`@db.Date` uchun UTC yarim tuni).
 *
 * Qabul qiladi:
 *   - `Date` (xlsx `cellDates` bergan katak) — TOSHKENT kuni olinadi
 *   - Excel seriya raqami (CSV orqali kelganda `cellDates` ishlamaydi)
 *   - "Dec 1, 2026" / "1-dekabr, 2026" / "1 dekabr 2026"
 *   - "2026-12-01" (ISO)
 *   - "01.12.2026" / "9/29/2026" — tartib `order` bilan beriladi
 *
 * @param {unknown} value
 * @param {string} [order] - `detectDateOrder` natijasi
 * @returns {Date|null} yaroqsiz qiymatda `null` (xato EMAS: "aniq sanani
 *   bilmayman" javobi ham shu yo'ldan o'tadi)
 */
function parseSheetDay(value, order = DATE_ORDER.DMY) {
  if (value == null || value === "") return null;

  // 1) Haqiqiy Date — xlsx o'zi o'girgan katak.
  //
  // ⚠️ `getUTC*` EMAS, TOSHKENT kuni: `cellDates` sanani MAHALLIY yarim tun
  // sifatida quradi (`2026-12-01T00:00:00+05:00` → `...T19:00:00Z`), ya'ni
  // UTC bo'yicha o'qilsa 30-noyabr bo'lib qolardi.
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const tashkent = new Date(value.getTime() + 5 * 3600000);
    return toUtcDay(
      tashkent.getUTCFullYear(),
      tashkent.getUTCMonth() + 1,
      tashkent.getUTCDate(),
    );
  }

  // 2) Excel seriya raqami (1900 tizimi, 1 = 1899-12-31)
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 1 || value > 80000) return null;
    const base = Date.UTC(1899, 11, 30);
    const date = new Date(base + Math.floor(value) * 86400000);
    return toUtcDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  const text = String(value).trim();
  if (!text) return null;

  // 3) ISO — "2026-12-01"
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return toUtcDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // 4) Oy NOMI bilan — "Dec 1, 2026", "1-dekabr, 2026", "December 1 2026"
  const named = parseNamedMonth(text);
  if (named) return named;

  // 5) Raqamli — tartib ustun bo'yicha hal qilingan
  const numeric = NUMERIC_DATE.exec(text);
  if (numeric) {
    const p1 = Number(numeric[1]);
    const p2 = Number(numeric[2]);
    const year = expandYear(Number(numeric[3]));
    if (!year) return null;

    // Qiymatning O'ZI tartibni inkor qilsa, qiymat yutadi: `29/09` ni
    // "29-oy" deb o'qish ochiq xato bo'lardi.
    if (p1 > 12) return toUtcDay(year, p2, p1);
    if (p2 > 12) return toUtcDay(year, p1, p2);

    return order === DATE_ORDER.MDY ? toUtcDay(year, p1, p2) : toUtcDay(year, p2, p1);
  }

  return null;
}

/** "Dec 1, 2026" / "1-dekabr, 2026" ko'rinishlari. */
function parseNamedMonth(text) {
  const clean = normalizeName(text).replace(/[,]+/g, " ").replace(/\s+/g, " ").trim();

  // "dec 1 2026" — oy oldin
  let match = /^([a-zЀ-ӿ]+)\s*-?\s*(\d{1,2})\s+(\d{2,4})$/.exec(clean);
  if (match) {
    const month = MONTH_BY_NAME.get(match[1]);
    const year = expandYear(Number(match[3]));
    if (month && year) return toUtcDay(year, month, Number(match[2]));
  }

  // "1-dekabr 2026" / "1 dekabr 2026" — kun oldin
  match = /^(\d{1,2})\s*-?\s*([a-zЀ-ӿ]+)\s+(\d{2,4})$/.exec(clean);
  if (match) {
    const month = MONTH_BY_NAME.get(match[2]);
    const year = expandYear(Number(match[3]));
    if (month && year) return toUtcDay(year, month, Number(match[1]));
  }

  return null;
}

/**
 * FORMA TIMESTAMP'I — kun + soat.
 *
 * Google Forms "9/29/2026 10:24:24" ko'rinishida eksport qiladi. Qiymat
 * TOSHKENT devor-soati deb qabul qilinadi (maktab bitta mintaqada —
 * `education.md` §9) va INSTANT qilib saqlanadi.
 *
 * @param {unknown} value
 * @param {string} [order]
 * @returns {Date|null}
 */
function parseSheetInstant(value, order = DATE_ORDER.MDY) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const text = String(value ?? "").trim();
  if (!text) return null;

  const day = parseSheetDay(text, order);
  if (!day) return null;

  const time = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  const hours = time ? Number(time[1]) : 0;
  const minutes = time ? Number(time[2]) : 0;
  const seconds = time && time[3] ? Number(time[3]) : 0;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;

  // Toshkent devor-soati → UTC instant (+5, DST yo'q)
  return new Date(day.getTime() + (hours - 5) * 3600000 + minutes * 60000 + seconds * 1000);
}

/* ─────────────────────────── MUDDAT ─────────────────────────── */

/**
 * Muddat kesimi uchun oy kaliti — "2026-12".
 *
 * ⚠️ Moliya oyi (`YYYYMM` son) EMAS: bu moliya domeni emas va sana
 * `@db.Date` bo'lib yotadi. `getUTC*` bilan o'qiladi.
 *
 * @param {Date|null} date
 * @returns {string|null}
 */
function monthKeyOf(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Muddatgacha qolgan KUNLAR (bugun — 0, kechagi muddat — manfiy).
 *
 * @param {Date|null} dueDate - `@db.Date` (UTC yarim tuni)
 * @param {Date} todayUtcDay - Toshkent bugunining UTC yarim tuni
 * @returns {number|null}
 */
function daysLeft(dueDate, todayUtcDay) {
  if (!(dueDate instanceof Date) || Number.isNaN(dueDate.getTime())) return null;
  return Math.round((dueDate.getTime() - todayUtcDay.getTime()) / 86400000);
}

/**
 * Muddatgacha qolgan vaqtning MATNI: "Bugun", "12 kun qoldi", "3 kun o'tdi".
 *
 * ⚠️ Bu SANA EMAS, MASOFA — shuning uchun `dates.md` formatiga tushmaydi va
 * sananing o'zi har doim yonida (`dueDateLabel`) turadi.
 *
 * ⚠️ SERVERDA hisoblanadi va ikkala panelga TAYYOR ketadi: admin va
 * o'quvchi ekranida bir xil matn bo'lishi kerak, ikki nusxa esa vaqt
 * o'tishi bilan ajralib ketardi ("12 kun qoldi" / "12 kun").
 *
 * @param {number|null} days - `daysLeft` natijasi
 * @returns {string|null}
 */
function daysLeftLabel(days) {
  if (days === null || days === undefined) return null;
  if (days === 0) return "Bugun";
  if (days > 0) return `${days} kun qoldi`;
  return `${Math.abs(days)} kun o'tdi`;
}

module.exports = {
  PLAN_STATUS,
  ACTIVE_STATUS,
  PLAN_SOURCE,
  DATE_ORDER,
  planActiveKey,
  normalizeName,
  nameSortKey,
  nameTokens,
  editDistance,
  nameSimilarity,
  detectDateOrder,
  parseSheetDay,
  parseSheetInstant,
  monthKeyOf,
  daysLeft,
  daysLeftLabel,
};
