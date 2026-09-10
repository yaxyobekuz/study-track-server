const cron = require("node-cron");
const { branchCron } = require("../helpers/branchIterator");
const attemptService = require("../services/diagnosticAttempt.service");
const aiService = require("../services/diagnosticAi.service");
const logger = require("../utils/logger");

/**
 * DIAGNOSTIKA CRON — ikkita mustaqil vazifa.
 *
 * ⚠️ IKKALASI HAM "OXIRIGACHA YETKAZISH" KAFOLATI, asosiy yo'l emas.
 * Oddiy holatda:
 *   - urinish o'quvchi topshirganda yakunlanadi;
 *   - muddati o'tgani so'rov paytida (`getActiveAttempt`, `saveAnswer`)
 *     darhol yopiladi;
 *   - AI tahlili topshirilgandan keyin fonda ishlanadi.
 * Lekin o'quvchi brauzerni yopib ketsa yoki server qayta ishga tushsa,
 * hech kim bu ishlarni tugatib bermasdi. Aynan shu bo'shliq yopiladi.
 */

/**
 * Muddati o'tgan va tashlab ketilgan urinishlarni yopadi.
 *
 * ⚠️ AVTOMAT YOPISH SHART: ochiq qolgan urinish o'quvchining URINISHLAR
 * LIMITINI band qilib turadi va u boshqa hech qachon shu testni topshira
 * olmasdi ("Urinishlar tugadi" degan xato bilan qolib ketardi).
 */
function startDiagnosticExpiryCron() {
  cron.schedule(
    "*/2 * * * *",
    branchCron("[DiagnostikaUrinish]", async (branch) => {
      try {
        const result = await attemptService.expireStaleAttempts();
        if (result.closed > 0) {
          logger.info(
            `[DiagnostikaUrinish] ${branch.name}: ${result.closed} ta urinish yopildi ` +
              `(muddati o'tgan: ${result.expired}, tashlab ketilgan: ${result.abandoned})`,
          );
        }
      } catch (error) {
        logger.error(
          `[DiagnostikaUrinish] ${branch.name} xatosi: ${error.message}`,
        );
      }
    }),
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  logger.info(
    "Diagnostika urinish cron ishga tushdi: har 2 daqiqada (Asia/Tashkent)",
  );
}

/**
 * Navbatda qolgan AI tahlillarini ishlaydi.
 *
 * ⚠️ FON ISHLOVI JARAYON QAYTA ISHGA TUSHGANDA UZILADI va qator
 * `queued`/`processing` holatida osilib qolardi — o'quvchi natija
 * sahifasida "tahlil tayyorlanmoqda" yozuvi bilan abadiy qolardi.
 * `processPending` 10 daqiqadan ortiq `processing` da turgan qatorni ham
 * qaytarib oladi.
 *
 * ⚠️ Har 5 daqiqada: model chaqiruvi pullik va bu yo'l ZAXIRA — odatda
 * tahlil allaqachon tayyor bo'ladi va bu yerda hech narsa topilmaydi.
 */
function startDiagnosticInsightCron() {
  cron.schedule(
    "*/5 * * * *",
    branchCron("[DiagnostikaAI]", async (branch) => {
      try {
        const result = await aiService.processPending({ limit: 20 });
        if (result.processed > 0) {
          logger.info(
            `[DiagnostikaAI] ${branch.name}: ${result.processed}/${result.found} tahlil yakunlandi`,
          );
        }
      } catch (error) {
        logger.error(`[DiagnostikaAI] ${branch.name} xatosi: ${error.message}`);
      }
    }),
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  logger.info(
    "Diagnostika AI cron ishga tushdi: har 5 daqiqada (Asia/Tashkent)",
  );
}

module.exports = {
  startDiagnosticExpiryCron,
  startDiagnosticInsightCron,
};
