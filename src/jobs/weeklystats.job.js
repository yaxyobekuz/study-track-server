const cron = require("node-cron");
const { branchCron } = require("../helpers/branchIterator");
const { distributeWeeklyBonusCoins } = require("../services/coin.service");
const { getCurrentWeekRange } = require("../helpers/statistics.helpers");
const logger = require("../utils/logger");

/**
 * Cron job: Haftalik bonus coinlarni har yakshanba 00:01 da tarqatadi.
 * Reytinglar `grade` jadvalidan jonli hisoblangani uchun endi WeeklyStats
 * generatsiyasi shart emas — faqat maktab/sinf #1 bonuslari beriladi.
 * Cron: "1 0 * * 0" (daqiqa soat kun oy hafta-kuni; 0 = yakshanba)
 */
function startWeeklyStatsCron() {
  cron.schedule(
    "1 0 * * 0",
    branchCron("[WeeklyBonusCron]", async (branch) => {
      try {
        logger.info(`[WeeklyBonusCron] ${branch.name}: haftalik bonus boshlandi`);

        // Yakshanba 00:01 da joriy hafta oralig'i = endigina tugagan hafta (Du–Sha)
        const range = getCurrentWeekRange();
        await distributeWeeklyBonusCoins(range);

        logger.info(
          `=== Weekly Bonus Cron Job Completed for week ${range.weekNumber}/${range.year} ===`,
        );
      } catch (error) {
        logger.error("Error in weekly bonus cron job:", error);
      }
    }),
    {
      scheduled: true,
      timezone: "Asia/Tashkent",
    },
  );

  logger.info(
    "Weekly bonus cron job scheduled: Every Sunday at 00:01 (Asia/Tashkent)",
  );
}

module.exports = { startWeeklyStatsCron };
