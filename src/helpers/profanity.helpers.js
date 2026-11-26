/**
 * SO'KINISH FILTRI — BLOKLAMAYDI, BELGILAYDI.
 *
 * Qoida bitta jumlada:
 *
 * > Xabar har doim yoziladi; filtr unga `flagged` belgisini qo'yadi va
 * > sinf rahbari/moderator shu belgi bo'yicha ko'rib chiqadi.
 *
 * ⚠️ NIMA UCHUN AVTOMAT TSENZURA YO'Q: ro'yxatdagi har bir ildiz begunoh
 * so'z ichida ham uchraydi va bloklovchi filtr bolaning normal xabarini
 * "yuborilmadi" qilib qo'yardi — u esa buni tizim nosozligi deb o'ylardi.
 * Qaror odamda qoladi, filtr faqat DIQQATNI tortadi.
 *
 * ⚠️ NORMALIZATSIYA MAJBURIY: "s0kma", "s*kma", "ссука" kabi yozuvlar
 * oddiy `includes` dan o'tib ketardi. Shu sababli matn avval bir ko'rinishga
 * keltiriladi (kichik harf, kirill→lotin, raqam→harf, takroriy harflar,
 * ajratgichlar olib tashlanadi), keyin ildizlar qidiriladi.
 *
 * ⚠️ RO'YXAT KODDA, KATALOGDA EMAS: bu sozlama emas, moderatsiya
 * yordamchisi. Katalog qilinsa, "kim qo'shdi / kim o'chirdi" degan registr,
 * ruxsat kaliti va ekran kerak bo'lardi — holbuki natija faqat bitta
 * `boolean`.
 */

/** Kirill → lotin (o'zbek va rus harflari aralash yoziladi). */
const CYRILLIC_MAP = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "j", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "x", ц: "c", ч: "ch", ш: "sh", щ: "sh",
  ъ: "", ы: "i", ь: "", э: "e", ю: "yu", я: "ya", ғ: "g", қ: "q", ҳ: "h", ў: "o",
};

/** Raqam/belgi bilan yozilgan harflar ("s0kma", "@blya"). */
const LEET_MAP = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", "@": "a", $: "s" };

/**
 * ILDIZLAR. ⚠️ So'zning O'ZI emas, ILDIZI yoziladi: o'zbek tilida qo'shimcha
 * so'z oxiriga qo'shiladi ("...ma", "...ding", "...lar"), ya'ni to'liq
 * shaklni yozsak har qo'shimcha uchun yangi qator kerak bo'lardi.
 */
const ROOTS = Object.freeze([
  // o'zbek
  "qotoq", "qotaq", "jalab", "ammaki", "haromi", "padarlan", "qanjiq",
  "sikt", "sikm", "sikv", "sikib", "sikay",
  // rus
  "xuy", "huy", "pizd", "blyad", "blyat", "suka", "yebal", "ebal", "ebat",
  "nahuy", "pidor", "mudak", "gandon", "zaebal",
  // inglizcha (ilova bozorida ham uchraydi)
  "fuck", "bitch", "asshole",
]);

/**
 * ⚠️ RO'YXATGA QISQA VA KO'P MA'NOLI ILDIZ QO'SHMANG. Birinchi versiyada
 * "kot" va "onani" bor edi: ular "kotlet" va "onani chaqirdim" kabi
 * mutlaqo begunoh xabarlarni belgilab, sinf rahbarining ro'yxatini
 * soxta signal bilan to'ldirardi — bir hafta ichida u ro'yxatga umuman
 * qaramay qo'yardi, ya'ni filtr o'z vazifasini YO'QOTARDI. "shit" ham
 * shu sababdan olib tashlandi ("mashina" emas, lekin lotin
 * transliteratsiyasida tez-tez uchraydi).

/**
 * Matnni taqqoslash uchun bir ko'rinishga keltiradi.
 *
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  let out = String(text || "").toLowerCase();

  out = out.replace(/[Ѐ-ӿ]/g, (ch) => (ch in CYRILLIC_MAP ? CYRILLIC_MAP[ch] : ch));
  out = out.replace(/[0134578@$]/g, (ch) => LEET_MAP[ch] ?? ch);
  // Harf va raqamdan boshqa hamma narsa ketadi: "s.i.k" → "sik"
  out = out.replace(/[^a-z0-9]+/g, "");
  // Takroriy harflar: "ssuuka" → "suka"
  out = out.replace(/(.)\1{1,}/g, "$1");

  return out;
}

/**
 * Matnda so'kinish ildizi bormi.
 *
 * @param {string} text
 * @returns {boolean}
 */
function containsProfanity(text) {
  if (!text) return false;
  const normalized = normalize(text);
  if (!normalized) return false;
  return ROOTS.some((root) => normalized.includes(normalize(root)));
}

module.exports = { containsProfanity, normalize, ROOTS };
