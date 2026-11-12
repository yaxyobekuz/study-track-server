/**
 * O'QUV TILI — YAGONA MANBA (sof funksiyalar, bazaga tegmaydi).
 *
 * Bitta maktabda bir xil fan uch tilda o'qitiladi: 5-sinfda ham o'zbek, ham
 * rus, ham ingliz guruh bo'lishi mumkin va ularning mavzular rejasi BOSHQA
 * (kitob boshqa, tartib boshqa). Shuning uchun:
 *
 *   · `Class.language` — guruhning tili (qaysi ro'yxatdan sanash kerak);
 *   · `Topic.language` — mavzular rejasining tili (har til mustaqil, 1 dan
 *     raqamlanadi).
 *
 * ⚠️ TIL — SINFNING xossasi, FANNING emas. Har til uchun alohida `Subject`
 * ochish ("Matematika (rus)") jurnal, jadval, baho va hisobotlarning HAMMA
 * kesimini uch barobar bo'lib yuborardi: "matematikadan o'rtacha baho" degan
 * savolga javob uchta bo'lib qolardi.
 *
 * ⚠️ RO'YXAT KODDA, KATALOGDA EMAS. Til — domenning o'lchovi (mavzular
 * ro'yxatini bo'ladi va ankorlar unga tayanadi), filialning sozlamasi emas.
 * Katalog qilinsa, umumiy ko'rinishda ikki filialning "rus tili" boshqa-boshqa
 * qator bo'lib qolardi (`TeachingLanguage` enumi izohiga qarang).
 *
 * ⚠️ QIYMATLAR `TeachingLanguage` ENUMI BILAN AYNI va admin panelidagi
 * `teachingLanguage.data.js` bilan QO'LDA SINXRON — `permissions.js` bilan
 * bir xil qoida.
 */

/** Prisma `TeachingLanguage` enumi qiymatlari — tartib ham shu. */
const TEACHING_LANGUAGES = Object.freeze(["uz", "ru", "en"]);

/**
 * SUKUT — o'zbek.
 *
 * Mavjud sinflar va mavzular migratsiyada aynan shu qiymatni oldi: ular
 * haqiqatan o'zbek tilidagi reja va ularni "noma'lum" qoldirish jadvaldagi
 * mavzuni jimgina yo'qotardi.
 */
const DEFAULT_TEACHING_LANGUAGE = "uz";

/** Tilning o'zi ("Rus tili" emas — ustun sarlavhasi va tanlagich uchun). */
const TEACHING_LANGUAGE_LABELS = Object.freeze({
  uz: "O'zbek",
  ru: "Rus",
  en: "Ingliz",
});

/** Sinf kesimida ("Rus sinf") — yuklash oynasi va sinf kartasi shuni yozadi. */
const TEACHING_LANGUAGE_CLASS_LABELS = Object.freeze({
  uz: "O'zbek sinf",
  ru: "Rus sinf",
  en: "Ingliz sinf",
});

/**
 * AI PROMPTIDA ishlatiladigan til nomi.
 *
 * ⚠️ Model savolni AYNI tilda yozishi kerak: rus guruhiga o'zbekcha savol
 * tushsa, test bilimni emas, tilni o'lchab qo'yardi.
 */
const TEACHING_LANGUAGE_PROMPT_NAMES = Object.freeze({
  uz: "o'zbek",
  ru: "rus",
  en: "ingliz",
});

/**
 * Kelgan qiymatni enum qiymatiga keltiradi.
 *
 * ⚠️ TANIMAGAN QIYMAT XATO OTMAYDI, `fallback` qaytaradi — bu funksiya
 * O'QISH yo'lida ham ishlatiladi (eski qator, bo'sh ustun). Kiritishni
 * tekshirish uchun `assertLanguage` bor.
 *
 * @param {unknown} value
 * @param {{fallback?: string|null}} [options]
 * @returns {string|null}
 */
function normalizeLanguage(value, { fallback = DEFAULT_TEACHING_LANGUAGE } = {}) {
  if (value === null || value === undefined || value === "") return fallback;
  const key = String(value).trim().toLowerCase();
  return TEACHING_LANGUAGES.includes(key) ? key : fallback;
}

/** Qiymat enumga kiradimi (`normalizeLanguage` dan farqli — taxmin qilmaydi). */
function isTeachingLanguage(value) {
  return TEACHING_LANGUAGES.includes(String(value ?? "").trim().toLowerCase());
}

/** Yorliq — noma'lum qiymatda kalitning o'zi (ekranda bo'sh joy turmasin). */
function languageLabel(value) {
  const key = normalizeLanguage(value, { fallback: null });
  return key ? TEACHING_LANGUAGE_LABELS[key] : String(value ?? "—");
}

/** Sinf kesimidagi yorliq ("Rus sinf"). */
function languageClassLabel(value) {
  const key = normalizeLanguage(value, { fallback: null });
  return key ? TEACHING_LANGUAGE_CLASS_LABELS[key] : String(value ?? "—");
}

/** AI promptiga ketadigan til nomi. */
function languagePromptName(value) {
  const key = normalizeLanguage(value);
  return TEACHING_LANGUAGE_PROMPT_NAMES[key];
}

module.exports = {
  TEACHING_LANGUAGES,
  DEFAULT_TEACHING_LANGUAGE,
  TEACHING_LANGUAGE_LABELS,
  TEACHING_LANGUAGE_CLASS_LABELS,
  TEACHING_LANGUAGE_PROMPT_NAMES,
  normalizeLanguage,
  isTeachingLanguage,
  languageLabel,
  languageClassLabel,
  languagePromptName,
};
