/**
 * Telefon raqami — saqlash va ko'rsatish yordamchilari.
 *
 * Saqlash formati BITTA: `+998XXXXXXXXX` (12 raqam, `+` bilan). Foydalanuvchi
 * qanday kiritmasin — `90 123 45 67`, `+998 (90) 123-45-67`, `998901234567` —
 * bazaga faqat shu shakl tushadi. Aks holda bir xil raqam uch xil yozilib,
 * qidiruv ham, `tel:` havola ham ishonchsiz bo'lib qolardi.
 *
 * Ko'rsatish formati ham bitta: `+998 90 123 45 67` (admin paneldagi
 * `phone.utils.js` bilan AYNAN bir xil bo'laklash — Excel va ekran bir xil
 * ko'rinsin).
 */

const { BadRequestError } = require("../utils/errors");

const PHONE_ERROR = "Telefon raqami noto'g'ri. Namuna: +998 90 123 45 67";

/** Faqat raqamlar. */
const digitsOf = (value) => String(value ?? "").replace(/\D/g, "");

/**
 * Kiritilgan qiymatni saqlash shakliga keltiradi.
 *
 *   - bo'sh (`null`/`undefined`/faqat bo'shliq) → `null` (raqam o'chirildi)
 *   - 9 raqam (`901234567`)                     → `+998901234567`
 *   - 12 raqam, `998` bilan boshlanadi          → `+998901234567`
 *   - boshqa har qanday holat                   → `BadRequestError`
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function normalizePhone(value) {
  if (value === null || value === undefined) return null;
  if (String(value).trim() === "") return null;

  const d = digitsOf(value);
  if (d.length === 9) return `+998${d}`;
  if (d.length === 12 && d.startsWith("998")) return `+${d}`;

  throw new BadRequestError(PHONE_ERROR);
}

/**
 * `+998901234567` → `+998 90 123 45 67`. Bo'sh qiymat → `—`.
 * Boshqa uzunlikdagi (eski/yaroqsiz) qiymat borligicha qaytariladi —
 * yashirib qo'yish raqamni yo'qotgandek tuyulardi.
 *
 * @param {string|null|undefined} value
 * @returns {string}
 */
function formatPhoneUz(value) {
  if (!value) return "—";
  const d = digitsOf(value);
  if (d.length === 12 && d.startsWith("998")) {
    return `+${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8, 10)} ${d.slice(10, 12)}`;
  }
  return String(value);
}

/**
 * IKKI RAQAM BITTA KATAKDA — o'quvchining O'ZINIKI va OTA-ONASINIKI.
 *
 * ⚠️ IKKITA USTUN EMAS, BITTA USTUN IKKI QATOR. Hisobotlar A4 varaqqa
 * chiqadi va `+998 90 123 45 67` bitta qatorga sig'ishi uchun ustun
 * kamida ~1,2 dyuym bo'lishi kerak: ikkita shunday ustun qo'yilsa,
 * ism va izoh ustunlari qisilib, raqamning o'zi ham bo'shliqlardan
 * bo'linib ("+998 90 123" / "45 67") o'qilmas bo'lib qolardi.
 *
 * ⚠️ QATOR TARTIBI MA'NO TASHIYDI: birinchi qator — o'quvchi, ikkinchisi
 * — ota-ona (ustun sarlavhasi ham shuni aytadi). Shuning uchun raqami
 * yo'q tomon `—` bilan O'Z O'RNIDA qoladi: tashlab ketilsa, yolg'iz
 * raqam kimniki ekani noma'lum bo'lardi. Ikkalasi ham yo'q bo'lsa —
 * bitta `—`.
 *
 * `\n` Word'da `<w:br/>` ga aylanadi (`word.service.js`), panelda esa
 * hujjat komponenti AYNI ikki qatorni chizadi.
 *
 * @param {{phone?: string|null, parentPhone?: string|null}|null} contact
 * @returns {string}
 */
function phonePairText(contact) {
  const own = formatPhoneUz(contact?.phone);
  const parent = formatPhoneUz(contact?.parentPhone);

  if (own === "\u2014" && parent === "\u2014") return "\u2014";
  return `${own}\n${parent}`;
}

/**
 * Shu ustunning sarlavhasi — hujjatlarda BIR XIL yozilsin
 * (ekrandagi nusxa ham shuni oladi).
 */
const PHONE_PAIR_LABEL = "Telefon (o'quvchi / ota-ona)";

module.exports = { normalizePhone, formatPhoneUz, phonePairText, PHONE_PAIR_LABEL };
