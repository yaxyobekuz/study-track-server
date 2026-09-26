/**
 * AI MATNIDAGI RAQAMLAR NAZORATI — "raqam modeldan chiqmaydi" kafolati.
 *
 * Model yozgan matndagi HAR BIR son unga berilgan faktlar ichida bo'lishi
 * shart; bittasi topilmasa chaqiruvchi BUTUN javobni rad etadi va qoidalar
 * matniga tushadi. Tizim promptidagi iltimos yetarli emas — bu chegara.
 *
 * ⚠️ Mantiq `academicInsight.service.js` dagi nazorat bilan AYNI
 * (u yerda xususiy funksiyalar). O'sha fayl ataylab o'zgartirilmadi —
 * ishlab turgan haftalik tahlilga tegmaslik uchun; yangi AI qatlamlari
 * shu moduldan foydalanadi.
 */

/** Faktlardagi matn maydonining chegarasi (nom uchun yetarli). */
const MAX_FACT_TEXT_LENGTH = 160;

/**
 * Promptga ketadigan MATNLARNI qisqartiradi va bir qatorga yig'adi.
 *
 * ⚠️ Faktlar ichida BAZADAN KELGAN ERKIN MATN bor (fan, mavzu, sinf nomi) —
 * prompt injection yuzasi. Qisqartirish uzun ko'rsatmani sig'dirmaydi,
 * qator uzilishini olib tashlash "yangi qoida" bloki yasashga yo'l
 * qo'ymaydi; asosiy himoya baribir raqam nazorati.
 */
const maskFacts = (value, maxLength = MAX_FACT_TEXT_LENGTH) => {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
  if (Array.isArray(value)) return value.map((item) => maskFacts(item, maxLength));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskFacts(item, maxLength)]));
  }
  return value;
};

/**
 * Sonning ruxsat etilgan yozilish shakllari.
 *
 * ⚠️ Ishorasiz qiymat ham qo'shiladi: model ishorani SO'Z bilan yozadi
 * ("0.35 ballga pasaydi"). Yaxlitlangan ko'rinishlar (4.3 ↔ 4.30) —
 * to'qib chiqarish emas, o'sha faktning boshqa aniqligi.
 */
const numberForms = (num, out) => {
  if (!Number.isFinite(num)) return;
  for (const value of [num, Math.abs(num)]) {
    out.add(String(value));
    out.add(value.toFixed(0));
    out.add(value.toFixed(1));
    out.add(value.toFixed(2));
    out.add(String(Number(value.toFixed(1))));
    out.add(String(Number(value.toFixed(2))));
  }
};

/** Faktlar ichidagi BARCHA sonlar — matn ichidagilari ham. */
const collectFactNumbers = (value, out = new Set()) => {
  if (typeof value === "number") numberForms(value, out);
  else if (typeof value === "string") {
    for (const hit of value.matchAll(/\d+(?:[.,]\d+)?/g)) numberForms(Number(hit[0].replace(",", ".")), out);
  } else if (Array.isArray(value)) {
    for (const item of value) collectFactNumbers(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectFactNumbers(item, out);
  }
  return out;
};

/**
 * Matnda faktlarda YO'Q sonlar (bo'sh massiv — hammasi joyida).
 * Ming ajratgichi ("1 200") va vergulli kasr ("4,95") normallashtiriladi.
 */
const ungroundedNumbers = (text, allowed) => {
  const normalized = String(text).replace(/(\d)[\s ](?=\d{3}(?!\d))/g, "$1");
  const bad = [];
  for (const hit of normalized.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const token = hit[0].replace(",", ".");
    if (allowed.has(token) || allowed.has(String(Number(token)))) continue;
    bad.push(hit[0]);
  }
  return bad;
};

/**
 * Matn maydoni — to'g'ri bo'lsa qiymat, aks holda `null`.
 * ⚠️ Uzun matn KESILMAYDI, RAD ETILADI: kesilgan jumla so'z (yoki son)
 * o'rtasida uzilib chiqardi.
 */
const textField = (value, max) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
};

module.exports = { maskFacts, collectFactNumbers, ungroundedNumbers, textField };
