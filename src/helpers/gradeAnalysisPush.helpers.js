/**
 * BAHOLAR TAHLILI PUSH XABARI — matn va `data` (sof funksiya).
 *
 * Tahlil nashr qilinganda o'quvchining BARCHA tirik qurilmalariga bitta
 * xabar boradi. Ota-ona ham farzandining loginidan kiradi (mobil ilova
 * kirishni o'zi ajratadi), ya'ni ikkalasining qurilmasi bitta `userId` da.
 *
 * ⚠️ MATN SHAXSIY EMAS (o'rtacha baho yo'q): xabar qulflangan ekranda
 * ko'rinadi va telefonni boshqa odam ushlab turgan bo'lishi mumkin. Ustiga
 * bitta umumiy matn — butun qamrovga BITTA `sendToUsers` chaqiruvi.
 *
 * ⚠️ `data` MOBIL ILOVA BILAN SHARTNOMA: ilova `type = "grade_analysis"`
 * bo'yicha tahlil sahifasini ochadi va `GET /grade-analysis/my/latest`
 * ni so'raydi. Kalitlarni o'zgartirish ilovani ham yangilashni talab qiladi.
 */

const GRADE_ANALYSIS_PUSH_CHANNEL = "grade_analysis";

/**
 * @param {{ runId: string, period: string, periodTitle: string, branchId?: string }} input
 * @returns {{ title: string, body: string, data: object, channelId: string }}
 */
function buildGradeAnalysisPush({ runId, period, periodTitle, branchId }) {
  return {
    title: "Baholar tahlili tayyor",
    body: `${periodTitle} tahlil: fanlar bo'yicha natijalar, e'tibor talab qiladigan mavzular va tavsiyalar.`,
    channelId: GRADE_ANALYSIS_PUSH_CHANNEL,
    data: {
      type: "grade_analysis",
      event: "published",
      runId,
      period,
      branchId,
    },
  };
}

module.exports = { GRADE_ANALYSIS_PUSH_CHANNEL, buildGradeAnalysisPush };
