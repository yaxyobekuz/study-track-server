const cron = require("node-cron");
const {
  generateWeeklyStatsForAllStudents,
  recalculateRankings,
} = require("../services/weeklystats.service");
const { distributeWeeklyBonusCoins } = require("../services/coin.service");
const { getWeekNumber } = require("../helpers/statistics.helpers");
const logger = require("../utils/logger");

/**
 * Cron job: Generate WeeklyStats every Sunday at 00:01
 * Cron syntax: "1 0 * * 0" (minute hour day month weekday)
 * 0 = Sunday
 */
function startWeeklyStatsCron() {
  // Run every Sunday at 00:01
  cron.schedule(
    "1 0 * * 0",
    async () => {
      try {
        logger.info("=== Weekly Stats Cron Job Started ===");

        const today = new Date();
        const weekNumber = getWeekNumber(today);
        const year = today.getFullYear();

        // Generate stats for all students
        const result = await generateWeeklyStatsForAllStudents(
          weekNumber,
          year,
        );

        // Recalculate rankings
        await recalculateRankings(weekNumber, year);

        // Haftalik bonus coinlarni tarqatish (reytinglar tayyor bo'lgandan keyin)
        await distributeWeeklyBonusCoins(weekNumber, year);

        logger.info(
          `=== Weekly Stats Cron Job Completed: ${result.successCount} success, ${result.errorCount} errors ===`,
        );
      } catch (error) {
        logger.error("Error in weekly stats cron job:", error);
      }
    },
    {
      scheduled: true,
      timezone: "Asia/Tashkent",
    },
  );

  logger.info(
    "Weekly stats cron job scheduled: Every Sunday at 00:01 (Asia/Tashkent)",
  );
}

module.exports = { startWeeklyStatsCron };
