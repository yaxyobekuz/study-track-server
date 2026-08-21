const cron = require("node-cron");
const { branchCron } = require("../helpers/branchIterator");
const { distributeDailyCoins } = require("../services/coin.service");
const logger = require("../utils/logger");

const DAILY_COIN_HOUR = 23;
const DAILY_COIN_MINUTE = 30;

const getTashkentNow = () =>
  new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tashkent" }));

const isAfterDailyRunTime = (date) =>
  date.getHours() > DAILY_COIN_HOUR ||
  (date.getHours() === DAILY_COIN_HOUR &&
    date.getMinutes() >= DAILY_COIN_MINUTE);

async function runDistributionForDate(date, reason) {
  if (date.getDay() === 0) {
    logger.info(`[CoinCron] ${reason}: Yakshanba - o'tkazib yuborildi`);
    return;
  }

  logger.info(`[CoinCron] ${reason}: kunlik coin tarqatish boshlandi`);
  const result = await distributeDailyCoins(date);
  logger.info(
    `[CoinCron] ${reason}: ${result.successCount} muvaffaqiyatli, ${result.skippedCount} o'tkazib yuborildi, ${result.errorCount} xato`,
  );
}

/**
 * Kunlik coin tarqatish cron job.
 * Har kuni soat 23:30 da ishlaydi (Asia/Tashkent).
 * Yakshanba kuni (0) o'tkazib yuboriladi - baholar berilmaydi.
 */
function startDailyCoinCron() {
  cron.schedule(
    "30 23 * * *",
    branchCron("[CoinCron]", async (branch) => {
      try {
        const today = getTashkentNow();
        await runDistributionForDate(today, "Jadval bo'yicha");
      } catch (error) {
        logger.error("[CoinCron] Kunlik coin cron job xatosi:", error);
      }
    }),
    {
      scheduled: true,
      timezone: "Asia/Tashkent",
    },
  );

  logger.info(
    "Kunlik coin cron job belgilandi: Har kuni soat 23:30 da (Asia/Tashkent)",
  );

  // Startup recovery ham FILIALLAR BO'YLAB: `runDistributionForDate` bazaga
  // boradi, ya'ni filial kontekstisiz ishlay olmaydi.
  setImmediate(
    branchCron("[CoinCron]", async (branch) => {
      const now = getTashkentNow();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);

      await runDistributionForDate(yesterday, `${branch.name} — recovery (kechagi kun)`);

      if (isAfterDailyRunTime(now)) {
        await runDistributionForDate(now, `${branch.name} — recovery (bugungi kun)`);
      }
    }),
  );
}

module.exports = { startDailyCoinCron };
