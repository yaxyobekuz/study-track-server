const User = require("../models/user.model");
const { config } = require("../config/env.config");
const logger = require("./logger");

/**
 * Default owner foydalanuvchisini yaratadi (agar mavjud bo'lmasa)
 */
const initOwner = async () => {
  try {
    const ownerExists = await User.findOne({ role: "owner" });

    if (!ownerExists) {
      logger.info("Owner topilmadi. Yangi owner yaratilmoqda...");
      const ownerData = {
        username: config.defaultOwnerUsername,
        password: config.defaultOwnerPassword,
        firstName: config.defaultOwnerFirstname,
        lastName: config.defaultOwnerLastname,
        role: "owner",
        isActive: true,
      };

      await User.create(ownerData);
      logger.info("Default owner muvaffaqiyatli yaratildi");
    }
  } catch (error) {
    logger.error("Owner yaratishda xato:", error.message);
  }
};

module.exports = initOwner;
