const cron = require("node-cron");
const prisma = require("../config/prisma");
const { finalizeExpiredSession } = require("../services/testSession.service");
const logger = require("../utils/logger");

/**
 * Cron job: Vaqti tugagan ochiq test sessiyalarini har daqiqada yakunlaydi.
 * Cron syntax: "* * * * *" (har daqiqada)
 *
 * Lazy-expiry (saveAnswer / getSessionForStudent) cron oralig'idagi bo'shliqni
 * qoplaydi; bu job esa tashlab ketilgan sessiyalar oxir-oqibat baholanishini
 * kafolatlaydi.
 */
function startTestSessionExpiryCron() {
  cron.schedule(
    "* * * * *",
    async () => {
      try {
        const now = new Date();
        const expiredSessions = await prisma.testSession.findMany({
          where: {
            status: "in_progress",
            expiresAt: { lt: now },
          },
        });

        if (expiredSessions.length === 0) {
          return;
        }

        logger.info(
          `=== Test Session Expiry Cron: ${expiredSessions.length} ta sessiya yakunlanmoqda ===`,
        );

        let successCount = 0;
        let errorCount = 0;

        for (const session of expiredSessions) {
          try {
            await finalizeExpiredSession(session);
            successCount++;
          } catch (error) {
            errorCount++;
            logger.error(
              `Test session ${session.id} yakunlashda xato:`,
              error,
            );
          }
        }

        logger.info(
          `=== Test Session Expiry Cron yakunlandi: ${successCount} muvaffaqiyat, ${errorCount} xato ===`,
        );
      } catch (error) {
        logger.error("Test session expiry cron job xatosi:", error);
      }
    },
    {
      scheduled: true,
      timezone: "Asia/Tashkent",
    },
  );

  logger.info(
    "Test session expiry cron job scheduled: Har daqiqada (Asia/Tashkent)",
  );
}

module.exports = { startTestSessionExpiryCron };
