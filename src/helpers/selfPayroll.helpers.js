/**
 * XODIM O'Z OYLIGINI KO'RMAYDI — DARVOZA (biznes qarori, 2026-11-23).
 *
 * Xodim panellaridagi "Oylik" ekranlari — hisoblangan summa, stavka,
 * ustamalar, ushlab qolish, to'xtatish va kelmagan kun ayirmasi — VAQTINCHA
 * yopiladi. Ma'muriyat (moliya/oylik ruxsatlari bilan) hammasini avvalgidek
 * ko'radi: bu yerda faqat "O'ZIMNING oyligim" yo'llari yopiladi.
 *
 * OCHIQ QOLADI va bu ataylab:
 *   · JARIMALAR (`Penalty`) — alohida modul, pul emas intizom qarori;
 *   · DARS SOATI fakti (o'tildi / o'tilmadi / qoldi, o'rinbosarlik) —
 *     o'qituvchi "nega soatim kam" degan savolga o'zi javob topishi kerak
 *     (`education.md` §7, `finance.md` §10 "JADVAL — REJA");
 *   · toifa zayavkasi, davomat, topshiriqlar.
 * Shu ekranlardan faqat PUL maydonlari olib tashlanadi.
 *
 * ⚠️ DARVOZA BITTA JOYDA va u SERVERDA. Panelda kartani yashirish
 * YETMAYDI: mobil ilova, eski panel va to'g'ridan-to'g'ri so'rov javobni
 * baribir olardi (`finance.md` §14 — moliya bo'limini o'quvchidan yopish —
 * bilan AYNI mulohaza).
 *
 * ⚠️ QAYTA OCHISH — BITTA SATR (`SELF_PAYROLL_VISIBLE = true`). Shuning
 * uchun yo'llar o'chirilmadi va ekranlar olib tashlanmadi, faqat yopildi:
 * qaror "hozircha" deb qabul qilingan.
 */

const { ForbiddenError } = require("../utils/errors");

/** Yagona kalit: `true` — hamma yo'l avvalgidek ochiladi. */
const SELF_PAYROLL_VISIBLE = false;

const SELF_PAYROLL_CLOSED_MESSAGE =
  "Oylik ma'lumoti xodim uchun yopiq — ma'muriyatga murojaat qiling";

const isSelfPayrollVisible = () => SELF_PAYROLL_VISIBLE;

/** Butun javob oylikdan iborat yo'llar uchun (403). */
const assertSelfPayrollVisible = () => {
  if (!SELF_PAYROLL_VISIBLE) throw new ForbiddenError(SELF_PAYROLL_CLOSED_MESSAGE);
};

/**
 * PUL KALITI — `*Amount` SUFFIKSI + aniq ro'yxat.
 *
 * ⚠️ Suffiks qoidasi ATAYLAB: domenda pul doim `amount` / `*Amount`
 * (`money.helpers.js` dagi `formatAmount` natijasi shunday nomlanadi).
 * Faqat ro'yxat bo'lsa, javobga qo'shilgan YANGI summa (masalan
 * `tutorAmount`) darvozani jimgina chetlab o'tardi.
 *
 * Ro'yxatda esa suffiksga tushmaydiganlar: stavkalar va SUMMA YOZILGAN
 * MATN (`formulaLabel` — "3 000 000 so'm + 50 000 so'm × soat").
 *
 * ⚠️ Foiz va soat kalitlari (`attendanceRate`, `hours`, `points`) bu
 * ro'yxatga KIRMAYDI: ular pul emas va ko'rinishda qolishi kerak.
 */
const SALARY_KEYS = new Set([
  "hourlyRate",
  "perHourRate",
  "dailyRate",
  "perWeeklyHour",
  "baseSalary",
  "formulaLabel",
]);

const isSalaryKey = (key) => SALARY_KEYS.has(key) || /amount$/i.test(key);

/**
 * Javobdan pul maydonlarini OLIB TASHLAYDI (nolga yozmaydi: "0 so'm"
 * yolg'on raqam bo'lardi, yo'q maydon esa panelda umuman chizilmaydi).
 *
 * ⚠️ FAQAT ODDIY OBYEKT ichiga kiradi. `Date`, `Decimal` va boshqa
 * klass nusxalari BORLIGICHA qaytadi — ularni qayta qurish sanani
 * obyektga aylantirib yuborardi.
 *
 * @template T
 * @param {T} value - servis qaytargan javob (massiv, obyekt yoki skalyar)
 * @returns {T} pul maydonlarisiz nusxa
 */
const stripSalaryAmounts = (value) => {
  if (Array.isArray(value)) return value.map(stripSalaryAmounts);

  if (!value || typeof value !== "object") return value;

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSalaryKey(key)) continue;
    out[key] = stripSalaryAmounts(item);
  }
  return out;
};

/**
 * `stripSalaryAmounts` ning BAYROQQA BO'YSUNADIGAN o'rami — javob
 * yo'llarida AYNI SHU chaqiriladi.
 *
 * ⚠️ Nima uchun o'ram: `stripSalaryAmounts` ning o'zi doim tozalaydi
 * (shuning uchun u sinovda ham shundayligicha tekshiriladi). Yo'llar
 * to'g'ridan-to'g'ri uni chaqirsa, `SELF_PAYROLL_VISIBLE = true` qilingan
 * kuni oylik faqat BIR QISM ekranda qaytardi — tyutor guruhi va toifa
 * stavkasi jimgina yopiq qolardi. Bayroq bitta bo'lishi kerak.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
const hideSalaryAmounts = (value) =>
  SELF_PAYROLL_VISIBLE ? value : stripSalaryAmounts(value);

module.exports = {
  SELF_PAYROLL_VISIBLE,
  SELF_PAYROLL_CLOSED_MESSAGE,
  isSelfPayrollVisible,
  assertSelfPayrollVisible,
  isSalaryKey,
  stripSalaryAmounts,
  hideSalaryAmounts,
};
