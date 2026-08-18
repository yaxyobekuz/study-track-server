/**
 * Oy kaliti (YYYYMM) primitivlari — moliya domenining vaqt o'lchovi.
 *
 * Moliyada o'lchov birligi — OY, kun emas: "oylik summa", "yangi oydan boshlab
 * yangi narx", "ma'lum bir oy uchun". Shuning uchun tarif jadvallarida kun
 * darajasidagi maydon umuman yo'q — `202608` kabi butun son bor. Natijada:
 *
 *  - kesishuv/tegishlilik tekshiruvi oddiy son taqqoslash (indekslanadi);
 *  - "17-avgustda kiritilgan narx avgustga ta'sir qilmasin" talabi tekshiruv
 *    bilan emas, strukturasi bilan kafolatlanadi.
 *
 * Evaziga: 202612 + 1 !== 202701, shuning uchun oy arifmetikasi shu yerda.
 *
 * ── KUN KOORDINATASI: BITTA ISTISNO ──────────
 *
 * `StudentEnrollment.startDate` — o'quvchi maktabga kelgan KUN. U kirish
 * proratsiyasini beradi ("oyning 20-kunida keldi → 12/31") va boshqa hech
 * narsa uchun ishlatilmaydi. CHIQISHDA kun hisobga OLINMAYDI: "oyda 1 kun
 * o'qisa ham to'liq oy" qoidasi kuchda qoladi.
 *
 * Taymzona ma'lumotdan `@db.Date` bilan chiqarib tashlangan: ustunda vaqt
 * komponenti saqlanmaydi. Shu sababli kun qiymatlari FAQAT `getUTC*` bilan
 * o'qiladi (`monthKeyOfDate`, `dayOfMonthOfDate`) va faqat `parseDayDate`
 * orqali kiritiladi. `date.helpers.js` (u `toLocaleString` ga tayanadi)
 * moliya domenida ISHLATILMAYDI.
 */

const { BadRequestError } = require("../utils/errors");

const MIN_MONTH_KEY = 200001;
const MAX_MONTH_KEY = 210012;

// Ochiq (endMonth = null) davrlarni son taqqoslashda "cheksizlik" o'rnida
// ishlatish uchun — SQL/Prisma filtrida NULL bilan ishlash o'rniga.
const OPEN_END_MONTH = 999912;

/**
 * Qiymat haqiqiy YYYYMM oy kalitimi?
 * @param {*} value
 * @returns {boolean}
 */
function isMonthKey(value) {
  if (!Number.isInteger(value)) return false;
  if (value < MIN_MONTH_KEY || value > MAX_MONTH_KEY) return false;
  const month = value % 100;
  return month >= 1 && month <= 12;
}

/**
 * Kiruvchi qiymatni oy kalitiga keltiradi. Qabul qilinadigan shakllar:
 * 202608 (number), "202608", "2026-08" — frontend va query param uchun.
 *
 * @param {*} value
 * @param {string} label - xato xabarida ko'rinadigan maydon nomi
 * @returns {number} YYYYMM
 * @throws {BadRequestError}
 */
function parseMonthKey(value, label = "Oy") {
  if (value == null || value === "") {
    throw new BadRequestError(`${label} ko'rsatilmagan`);
  }

  let key = value;

  if (typeof key === "string") {
    const trimmed = key.trim();
    // "2026-08" / "2026/8" ko'rinishi
    const match = trimmed.match(/^(\d{4})[-/](\d{1,2})$/);
    key = match
      ? Number(match[1]) * 100 + Number(match[2])
      : Number.parseInt(trimmed, 10);
  }

  if (!isMonthKey(key)) {
    throw new BadRequestError(
      `${label} noto'g'ri formatda. To'g'ri format: YYYYMM (masalan 202608)`,
    );
  }

  return key;
}

/**
 * Ixtiyoriy oy maydoni: null/undefined/"" bo'lsa null qaytaradi.
 * `endMonth` kabi maydonlar uchun (null = ochiq davr).
 *
 * @param {*} value
 * @param {string} label
 * @returns {number|null}
 */
function parseOptionalMonthKey(value, label = "Oy") {
  if (value == null || value === "") return null;
  return parseMonthKey(value, label);
}

/**
 * Joriy oy — TOSHKENT vaqti bo'yicha (attendance.service.js:15-21 uslubi).
 *
 * Bu funksiya "amalda / hali amalda emas" qoidalarining hammasini boshqaradi
 * (amaldagi versiya narxini o'zgartirib bo'lmaydi, o'tgan biriktirishni
 * o'chirib bo'lmaydi va h.k.), shuning uchun server-local vaqt bo'lishi
 * mumkin emas: UTC'da ishlaydigan serverda 1-sentabr 02:00 (Toshkent) hali
 * "avgust" bo'lib qolar va amaldagi versiyani tahrirlashga ruxsat berib
 * yuborardi.
 *
 * O'zbekistonda yozgi/qishki vaqt o'tkazish yo'q — fiks +5 shu yerda xavfsiz.
 *
 * @returns {number} YYYYMM
 */
function currentMonthKey() {
  const now = new Date();
  const tashkent = new Date(
    now.getTime() + now.getTimezoneOffset() * 60000 + 5 * 3600000,
  );
  return tashkent.getFullYear() * 100 + (tashkent.getMonth() + 1);
}

/**
 * Bugungi kun raqami — TOSHKENT vaqti bo'yicha, `currentMonthKey()` bilan
 * bitta manbadan. Hisob-faktura cron'i "bugun belgilangan kunmi?" degan
 * savolga shu bilan javob beradi; `new Date().getDate()` server-local bo'lib,
 * oy chegarasida bir kunga adashishi mumkin edi.
 *
 * @returns {number} 1..31
 */
function currentDayOfMonth() {
  const now = new Date();
  const tashkent = new Date(
    now.getTime() + now.getTimezoneOffset() * 60000 + 5 * 3600000,
  );
  return tashkent.getDate();
}

/**
 * Joriy oyda necha kun bor (Toshkent). `invoiceDayOfMonth` fevralda oy
 * uzunligidan oshib ketmasligi uchun.
 *
 * @returns {number} 28..31
 */
function daysInCurrentMonth() {
  return daysInMonth(currentMonthKey());
}

// ─────────────────────────────────────────────
// KUN KOORDINATASI (faqat o'qish davri uchun)
// ─────────────────────────────────────────────

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Berilgan oyda necha kun bor.
 * @param {number} monthKey - YYYYMM
 * @returns {number} 28..31
 */
function daysInMonth(monthKey) {
  // Keyingi oyning 0-kuni = shu oyning oxirgi kuni
  return new Date(
    Date.UTC(Math.trunc(monthKey / 100), monthKey % 100, 0),
  ).getUTCDate();
}

/**
 * "YYYY-MM-DD" → UTC yarim tunidagi Date.
 *
 * `parseMonthKey` kabi QAT'IY: `Date` obyekti ham, vaqtli satr ham qabul
 * qilinmaydi. Sabab — `new Date("2026-01-20T00:00:00")` (Z siz, `<input
 * type="date">` dan keladigan shakl) HOST vaqtida o'qiladi va UTC+5 da
 * 19-yanvarga aylanib ketadi, ya'ni proratsiya bir kunga siljiydi.
 *
 * Mavjud bo'lmagan sana ("2026-02-30") `new Date` da jimgina 2-martga
 * ag'dariladi — shuning uchun teskari tekshiruv bor.
 *
 * @param {string} value
 * @param {string} label - xato xabaridagi maydon nomi
 * @returns {Date} UTC yarim tun
 * @throws {BadRequestError}
 */
function parseDayDate(value, label = "Sana") {
  const match = DAY_RE.exec(String(value ?? "").trim());
  if (!match) {
    throw new BadRequestError(
      `${label} noto'g'ri formatda. To'g'ri format: YYYY-MM-DD`,
    );
  }

  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));

  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    throw new BadRequestError(`${label} mavjud emas`);
  }

  return date;
}

/**
 * Ixtiyoriy kun sanasi — bo'sh qiymat `null` beradi (ochiq davr uchun).
 * @param {string|null|undefined} value
 * @param {string} label
 * @returns {Date|null}
 */
function parseOptionalDayDate(value, label = "Sana") {
  if (value == null || value === "") return null;
  return parseDayDate(value, label);
}

/**
 * Sana qaysi oyga tegishli. FAQAT `getUTC*` — lokal getter'lar UTC−5 hostda
 * bir kun orqaga o'qiydi va oy chegarasida noto'g'ri oy beradi.
 *
 * @param {Date} date
 * @returns {number} YYYYMM
 */
function monthKeyOfDate(date) {
  return date.getUTCFullYear() * 100 + date.getUTCMonth() + 1;
}

/**
 * Sananing oy ichidagi kuni (1..31). FAQAT `getUTC*`.
 * @param {Date} date
 * @returns {number}
 */
function dayOfMonthOfDate(date) {
  return date.getUTCDate();
}

/**
 * Oyning birinchi kuni (UTC yarim tun).
 * @param {number} monthKey
 * @returns {Date}
 */
function monthStartDate(monthKey) {
  return new Date(Date.UTC(Math.trunc(monthKey / 100), (monthKey % 100) - 1, 1));
}

/**
 * Oyning oxirgi kuni (UTC yarim tun, INKLYUZIV).
 * @param {number} monthKey
 * @returns {Date}
 */
function monthEndDate(monthKey) {
  return new Date(
    Date.UTC(Math.trunc(monthKey / 100), (monthKey % 100) - 1, daysInMonth(monthKey)),
  );
}

/**
 * Keyingi oy. Narx o'zgartirishning standart boshlanish nuqtasi.
 * @param {number} monthKey
 * @returns {number}
 */
function nextMonth(monthKey) {
  return monthKey % 100 === 12 ? monthKey + 89 : monthKey + 1;
}

/**
 * Oldingi oy. Eski versiyani yopishda ishlatiladi.
 * @param {number} monthKey
 * @returns {number}
 */
function prevMonth(monthKey) {
  return monthKey % 100 === 1 ? monthKey - 89 : monthKey - 1;
}

/**
 * Ikki oy orasidagi farq (oylarda): diffMonths(202601, 202603) === 2.
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
function diffMonths(from, to) {
  const y = Math.trunc(to / 100) - Math.trunc(from / 100);
  return y * 12 + ((to % 100) - (from % 100));
}

/**
 * Ko'rsatish uchun: 202608 → "2026-08".
 * @param {number|null} monthKey
 * @returns {string|null}
 */
function formatMonthKey(monthKey) {
  if (monthKey == null) return null;
  return `${Math.trunc(monthKey / 100)}-${String(monthKey % 100).padStart(2, "0")}`;
}

/**
 * Davr matni: "2026-01 — 2026-08" yoki "2026-01 dan boshlab".
 * Xato xabarlarida foydalanuvchiga qaysi davr to'sqinlik qilayotganini
 * ko'rsatish uchun.
 *
 * @param {number} startMonth
 * @param {number|null} endMonth
 * @returns {string}
 */
function formatMonthRange(startMonth, endMonth) {
  return endMonth == null
    ? `${formatMonthKey(startMonth)} dan boshlab`
    : `${formatMonthKey(startMonth)} — ${formatMonthKey(endMonth)}`;
}

/**
 * `[startMonth, endMonth]` davri `monthKey` ni qamrab oladimi?
 * @param {{startMonth: number, endMonth: number|null}} period
 * @param {number} monthKey
 * @returns {boolean}
 */
function periodCovers(period, monthKey) {
  if (period.startMonth > monthKey) return false;
  return period.endMonth == null || period.endMonth >= monthKey;
}

/**
 * Berilgan oyni qamrab oluvchi qatorni topish uchun Prisma `where` bo'lagi.
 * Uch joyda bir xil ishlatiladi (versiya, biriktirish, ommaviy resolve) —
 * shuning uchun bitta manba.
 *
 * @param {number} monthKey
 * @returns {Object} Prisma where fragment
 */
function coveringMonthWhere(monthKey) {
  return {
    startMonth: { lte: monthKey },
    OR: [{ endMonth: null }, { endMonth: { gte: monthKey } }],
  };
}

/**
 * `[startMonth, endMonth]` davri bilan kesishuvchi qatorlar uchun Prisma
 * `where` bo'lagi (ochiq davr = OPEN_END_MONTH).
 *
 * Kesishuv sharti: yangi.start <= mavjud.end  VA  mavjud.start <= yangi.end
 *
 * @param {number} startMonth
 * @param {number|null} endMonth
 * @returns {Object} Prisma where fragment
 */
function overlappingPeriodWhere(startMonth, endMonth) {
  return {
    startMonth: { lte: endMonth == null ? OPEN_END_MONTH : endMonth },
    OR: [{ endMonth: null }, { endMonth: { gte: startMonth } }],
  };
}

/**
 * Davrlar ro'yxatidagi bo'shliqlarni topadi (narx belgilanmagan oylar).
 * Bo'shliq xato emas — tarifda narxsiz oy bo'lishi mumkin — lekin UI uni
 * ogohlantirish sifatida ko'rsatishi kerak.
 *
 * @param {Array<{startMonth: number, endMonth: number|null}>} periods
 * @returns {Array<{fromMonth: number, toMonth: number}>}
 */
function findGaps(periods) {
  const sorted = [...periods].sort((a, b) => a.startMonth - b.startMonth);
  const gaps = [];

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];

    // Ochiq davrdan keyin bo'shliq bo'lishi mumkin emas (kesishuv tekshiruvi
    // uni allaqachon rad etgan bo'lardi).
    if (current.endMonth == null) continue;

    const gapStart = nextMonth(current.endMonth);
    if (gapStart < next.startMonth) {
      gaps.push({ fromMonth: gapStart, toMonth: prevMonth(next.startMonth) });
    }
  }

  return gaps;
}

module.exports = {
  MIN_MONTH_KEY,
  MAX_MONTH_KEY,
  OPEN_END_MONTH,
  isMonthKey,
  parseMonthKey,
  parseOptionalMonthKey,
  currentMonthKey,
  currentDayOfMonth,
  daysInCurrentMonth,
  daysInMonth,
  parseDayDate,
  parseOptionalDayDate,
  monthKeyOfDate,
  dayOfMonthOfDate,
  monthStartDate,
  monthEndDate,
  nextMonth,
  prevMonth,
  diffMonths,
  formatMonthKey,
  formatMonthRange,
  periodCovers,
  coveringMonthWhere,
  overlappingPeriodWhere,
  findGaps,
};
