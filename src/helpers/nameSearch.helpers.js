/**
 * ISM BO'YICHA QIDIRUV — `User` uchun Prisma sharti.
 *
 * Har so'z ism, familiya yoki logindan BIRIGA mos kelishi kerak — "Valiyev
 * Ali" ham, "Ali Valiyev" ham topiladi (bitta `contains` bilan ikkalasi ham
 * topilmasdi). Qidiruv SQL darajasida — xotirada filtrlangan ro'yxat
 * sahifalashdan keyin "topilmadi" deb yolg'on gapirardi.
 */

// Qidiruvda nechta so'z hisobga olinadi ("Valiyev Ali" — ikki so'z). Cheksiz
// so'z har biri uchun uchta `ILIKE` shartini ko'paytirardi.
const SEARCH_TERMS_MAX = 4;

/**
 * @param {unknown} search - foydalanuvchi kiritgan matn
 * @returns {object|null} `User` uchun `where` bo'lagi; bo'sh qidiruvda `null`
 */
function buildNameSearchWhere(search) {
  const terms = String(search ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, SEARCH_TERMS_MAX);
  if (terms.length === 0) return null;

  return {
    AND: terms.map((term) => ({
      OR: [
        { firstName: { contains: term, mode: "insensitive" } },
        { lastName: { contains: term, mode: "insensitive" } },
        { username: { contains: term, mode: "insensitive" } },
      ],
    })),
  };
}

module.exports = { SEARCH_TERMS_MAX, buildNameSearchWhere };
