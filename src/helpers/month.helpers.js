/**
 * Oy kaliti (YYYYMM) primitivlari — moliya domenining vaqt o'lchovi.
 *
 * Moliyada o'lchov birligi — OY, kun emas: "oylik summa", "yangi oydan boshlab
 * yangi narx", "ma'lum bir oy uchun". Shuning uchun tarif jadvallarida kun
 * darajasidagi maydon umuman yo'q — `202608` kabi butun son bor. Natijada:
 *
 *  - taymzona ma'lumotdan butunlay chiqib ketadi va faqat shu fayldagi
 *    `currentMonthKey()` da qoladi;
 *  - kesishuv/tegishlilik tekshiruvi oddiy son taqqoslash (indekslanadi);
 *  - "17-avgustda kiritilgan narx avgustga ta'sir qilmasin" talabi tekshiruv
 *    bilan emas, strukturasi bilan kafolatlanadi.
 *
 * Evaziga: 202612 + 1 !== 202701, shuning uchun oy arifmetikasi shu yerda.
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
