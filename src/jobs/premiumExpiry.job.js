const cron = require("node-cron");
const User = require("../models/user.model");
const Premium = require("../models/premium.model");
const { notifyPremiumEvent } = require("../services/premiumNotification.service");
const logger = require("../utils/logger");

/**
 * Muddati tugagan premiumlarni topib, holatini yangilaydi va o'quvchiga
 * bot orqali xabar yuboradi.
 * @returns {Promise<void>}
 */
async function runPremiumExpiryPass() {
  const now = new Date();

  const expiredUsers = await User.find({
    "premium.isActive": true,
    "premium.expiresAt": { $lte: now },
  }).select("_id firstName lastName premium");

  if (expiredUsers.length === 0) {
    logger.info("[PremiumExpiryCron] Muddati tugagan premium topilmadi");
    return;
  }

  let count = 0;
  for (const user of expiredUsers) {
    try {
      await User.findByIdAndUpdate(user._id, { "premium.isActive": false });
      await Premium.updateMany(
        { student: user._id, status: "active" },
        { status: "expired" },
      );
      await notifyPremiumEvent(user, "expired");
      count++;
    } catch (error) {
      logger.error(
        `[PremiumExpiryCron] ${user._id} premiumini tugatishda xato: ${error.message}`,
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
