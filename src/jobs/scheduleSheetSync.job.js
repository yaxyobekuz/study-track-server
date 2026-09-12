/**
 * GOOGLE SHEETS DARS JADVALI — avtomatik tekshiruv.
 *
 * Har 10 daqiqada, har filialda: jadval manbai "Google Sheets" va avtomatik
 * tekshiruv yoqilgan bo'lsa, sheet o'qiladi. Mazmun o'zgargan bo'lsa yangi
 * tahrir yoziladi va mas'ul odamlarga xabar boradi.
 *
 * ⚠️ Bu job amaldagi jadvalga TEGMAYDI. Sheet o'zgarishi faqat odam
 * ko'rib chiqib "Qo'llash" ni bosganda amalga kiradi. Sheet ishlamay qolsa
 * ham oxirgi tasdiqlangan jadval amalda qoladi — avtomatik almashtirish yo'q.
 */

const cron = require("node-cron");
const logger = require("../utils/logger");
const { branchCron } = require("../helpers/branchIterator");
const { runScheduleSheetSyncPass } = require("../services/scheduleSheetSync.service");

const startScheduleSheetSyncCron = () => {
  cron.schedule(
    "*/10 * * * *",
    branchCron("[ScheduleSheetSyncCron]", async (branch) => {
      try {
        await runScheduleSheetSyncPass();
      } catch (error) {
        logger.error(`[ScheduleSheetSync] ${branch.name}: cron xatosi`, error);
      }
    }),
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  logger.info("[ScheduleSheetSync] Cron ishga tushdi: har 10 daqiqada (Asia/Tashkent)");
};

module.exports = { startScheduleSheetSyncCron, runScheduleSheetSyncPass };
