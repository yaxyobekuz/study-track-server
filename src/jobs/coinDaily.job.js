const cron = require("node-cron");
const { distributeDailyCoins } = require("../services/coin.service");
const logger = require("../utils/logger");

/**
 * Kunlik coin tarqatish cron job.
 * Har kuni soat 23:30 da ishlaydi (Asia/Tashkent).
 * Yakshanba kuni (0) o'tkazib yuboriladi — baholar berilmaydi.
 */
function startDailyCoinCron() {
  cron.schedule(
    "30 23 * * *",
    async () => {
      try {
        const today = new Date();
        // 0 = Yakshanba
        if (today.getDay() === 0) {
          logger.info("[CoinCron] Yakshanba — kunlik coin tarqatish o'tkazib yuborildi");
          return;
        }

        logger.info("=== Kunlik Coin Tarqatish Boshlandi ===");
        const result = await distributeDailyCoins(today);
        logger.info(
          `=== Kunlik Coin Tarqatish Tugadi: ${result.successCount} muvaffaqiyatli, ` +
            `${result.skippedCount} o'tkazib yuborildi, ${result.errorCount} xato ===`,
        );
      } catch (error) {
        logger.error("[CoinCron] Kunlik coin cron job xatosi:", error);
      }
    },
    {
      scheduled: true,
      timezone: "Asia/Tashkent",
    },
  );

  logger.info(
    "Kunlik coin cron job belgilandi: Har kuni soat 23:30 da (Asia/Tashkent)",
  );
}

module.exports = { startDailyCoinCron };
