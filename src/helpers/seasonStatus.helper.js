/**
 * Mavsum holatini boshlanish/tugash sanalari asosida hisoblaydi.
 * Holat to'liq sanalardan kelib chiqadi (qo'lda belgilanmaydi):
 *   - now < startDate            → "draft"  (kutilmoqda)
 *   - startDate <= now <= endDate → "active" (faol)
 *   - now > endDate              → "closed" (yakunlangan)
 *
 * @param {Date|string} startDate - boshlanish sanasi
 * @param {Date|string} endDate - tugash sanasi
 * @param {Date} [now=new Date()] - joriy vaqt
 * @returns {"draft"|"active"|"closed"} hisoblangan holat
 */
function computeSeasonStatus(startDate, endDate, now = new Date()) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (now < start) return "draft";
  if (now > end) return "closed";
  return "active";
}

module.exports = { computeSeasonStatus };
