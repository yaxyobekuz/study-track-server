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

module.exports = { normalizePhone, formatPhoneUz };
