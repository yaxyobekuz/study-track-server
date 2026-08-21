/**
 * KATALOG QANCHA ISHLATILYAPTI — barcha filiallar bo'yicha.
 *
 * Tarif va chegirma KATALOGI platformada (umumiy), BIRIKTIRISHLAR esa har
 * filialning o'z schema'sida. Shu ikkilikdan bitta jiddiy tuzoq kelib chiqadi:
 *
 *   ⚠️ "Bu tarifga hech kim biriktirilmagan" degan xulosani JORIY FILIAL
 *      bo'yicha chiqarib bo'lmaydi. Chilonzorda biriktirilmagan tarif
 *      Yunusobodda 200 ta o'quvchida bo'lishi mumkin — va uni o'chirish
 *      o'sha filialning hisob-fakturalarini narxsiz qoldirardi.
 *
 * Shuning uchun o'chirish/arxivlash qaroriga ta'sir qiladigan HAR QANDAY
 * sanoq shu service orqali, filiallar bo'ylab olinadi.
 *
 * Faqat O'QISH, shuning uchun `mapBranches` (parallel).
 */

const prisma = require("../config/prisma");
const { mapBranches } = require("../helpers/branchIterator");

/**
 * `groupBy` natijalarini filiallar bo'ylab qo'shadi.
 *
 * @param {Array<{branch: object, value?: Array, error?: Error}>} results
 * @param {string} key - guruhlash ustuni ("tariffId" / "discountId")
 * @returns {Map<string, number>}
 */
const mergeCounts = (results, key) => {
  const merged = new Map();
  for (const { value } of results) {
    for (const row of value ?? []) {
      merged.set(row[key], (merged.get(row[key]) ?? 0) + row._count._all);
    }
  }
  return merged;
};

/**
 * Tarif → nechta o'quvchiga biriktirilgan (barcha filiallar).
 *
 * @param {string[]} tariffIds
 * @returns {Promise<Map<string, number>>}
 */
const countTariffAssignments = async (tariffIds) => {
  if (!tariffIds?.length) return new Map();

  const results = await mapBranches(
    () =>
      prisma.studentTariff.groupBy({
        by: ["tariffId"],
        where: { tariffId: { in: tariffIds } },
        _count: { _all: true },
      }),
    { label: "[CatalogUsage]" },
  );

  return mergeCounts(results, "tariffId");
};

/**
 * Bitta tarif bo'yicha sanoq.
 * @param {string} tariffId
 * @returns {Promise<number>}
 */
const countTariffAssignment = async (tariffId) =>
  (await countTariffAssignments([tariffId])).get(tariffId) ?? 0;

/**
 * Chegirma → nechta o'quvchiga biriktirilgan (barcha filiallar).
 *
 * @param {string[]} discountIds
 * @param {object} [extraWhere] - qo'shimcha shart, masalan
 *   `coveringMonthWhere(month)` ("shu oyda amal qiladiganlar")
 * @returns {Promise<Map<string, number>>}
 */
const countDiscountAssignments = async (discountIds, extraWhere = {}) => {
  if (!discountIds?.length) return new Map();

  const results = await mapBranches(
    () =>
      prisma.studentDiscount.groupBy({
        by: ["discountId"],
        where: { discountId: { in: discountIds }, ...extraWhere },
        _count: { _all: true },
      }),
    { label: "[CatalogUsage]" },
  );

  return mergeCounts(results, "discountId");
};

/**
 * Bitta chegirma bo'yicha sanoq.
 * @param {string} discountId
 * @param {object} [extraWhere]
 * @returns {Promise<number>}
 */
const countDiscountAssignment = async (discountId, extraWhere = {}) =>
  (await countDiscountAssignments([discountId], extraWhere)).get(discountId) ?? 0;

module.exports = {
  countTariffAssignments,
  countTariffAssignment,
  countDiscountAssignments,
  countDiscountAssignment,
};
