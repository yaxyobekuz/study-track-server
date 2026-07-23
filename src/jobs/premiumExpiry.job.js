const cron = require("node-cron");
const prisma = require("../config/prisma");
const { notifyPremiumEvent } = require("../services/premiumNotification.service");
const logger = require("../utils/logger");

/**
 * Muddati tugagan premiumlarni topib, holatini yangilaydi va o'quvchiga
 * bot orqali xabar yuboradi.
 * @returns {Promise<void>}
 */
async function runPremiumExpiryPass() {
  const now = new Date();

  const expiredUsers = await prisma.user.findMany({
    where: {
      premiumIsActive: true,
      premiumExpiresAt: { lte: now },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      premiumIsActive: true,
      premiumExpiresAt: true,
    },
  });

  if (expiredUsers.length === 0) {
    logger.info("[PremiumExpiryCron] Muddati tugagan premium topilmadi");
    return;
  }

  let count = 0;
  for (const user of expiredUsers) {
    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { premiumIsActive: false },
      });
      await prisma.premium.updateMany({
        where: { student: user.id, status: "active" },
        data: { status: "expired" },
      });
      await notifyPremiumEvent(user, "expired");
      count++;
    } catch (error) {
      logger.error(
        `[PremiumExpiryCron] ${user.id} premiumini tugatishda xato: ${error.message}`,
      );
    }
  }

  logger.info(`[PremiumExpiryCron] ${count} ta premium muddati tugadi`);
}

/**
 * Premium muddati cron jobni boshlaydi.
 * Har soatda ishga tushadi (Asia/Tashkent).
 */
function startPremiumExpiryCron() {
  cron.schedule(
    "0 * * * *",
    async () => {
      logger.info("[PremiumExpiryCron] Premium muddati tekshiruvi boshlandi...");
      try {
        await runPremiumExpiryPass();
      } catch (error) {
        logger.error("[PremiumExpiryCron] Cron xatosi:", error);
      }
    },
    {
      scheduled: true,
      timezone: "Asia/Tashkent",
    },
  );

  logger.info("Premium muddati cron job belgilandi: Har soatda (Asia/Tashkent)");
}

module.exports = { startPremiumExpiryCron, runPremiumExpiryPass };
