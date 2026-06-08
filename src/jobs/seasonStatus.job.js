const cron = require("node-cron");
const TestSeason = require("../models/testSeason.model");
const { computeSeasonStatus } = require("../helpers/seasonStatus.helper");
const logger = require("../utils/logger");

/**
 * Saqlangan holat sanalardan hisoblangan holatga mos kelmaydigan mavsumlarni
 * yangilaydi. pre-save hook create/edit paytida holatni darhol to'g'rilaydi;
 * bu pass esa faqat vaqt o'tishi bilan yuz beradigan o'tishlarni
 * (draft → active boshlanish sanasida, active → closed tugash sanasida) qoplaydi.
 */
async function syncSeasonStatuses() {
  const now = new Date();
  const seasons = await TestSeason.find().select("startDate endDate status");

  const ops = [];
  for (const season of seasons) {
    const computed = computeSeasonStatus(season.startDate, season.endDate, now);
    if (computed !== season.status) {
      ops.push({
        updateOne: {
          filter: { _id: season._id },
          update: { $set: { status: computed } },
        },
      });
    }
  }

  if (ops.length > 0) {
    await TestSeason.bulkWrite(ops);
    logger.info(`[SeasonStatusCron] ${ops.length} ta mavsum holati yangilandi`);
  }
}

/**
 * Cron job: Mavsum holatlarini har daqiqada sanalarga moslab yangilaydi.
 * Cron syntax: "* * * * *" (har daqiqada)
 */
function startSeasonStatusCron() {
  cron.schedule(
    "* * * * *",
    async () => {
      try {
        await syncSeasonStatuses();
      } catch (error) {
        logger.error("[SeasonStatusCron] Cron xatosi:", error);
      }
    },
    {
      scheduled: true,
      timezone: "Asia/Tashkent",
    },
  );

  // Startup paytida bir marta darhol moslashtirish
  syncSeasonStatuses().catch((error) =>
    logger.error("[SeasonStatusCron] Startup sync xatosi:", error),
  );

  logger.info(
    "Season status cron job scheduled: Har daqiqada (Asia/Tashkent)",
  );
}

module.exports = { startSeasonStatusCron, syncSeasonStatuses };
