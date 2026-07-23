const prisma = require("../config/prisma");
const { config } = require("../config/env.config");
const { hashPassword } = require("./password");
const logger = require("./logger");

/**
 * Default owner foydalanuvchisini yaratadi (agar mavjud bo'lmasa)
 */
const initOwner = async () => {
  try {
    const ownerExists = await prisma.user.findFirst({ where: { role: "owner" } });

    if (!ownerExists) {
      logger.info("Owner topilmadi. Yangi owner yaratilmoqda...");
      const password = await hashPassword(config.defaultOwnerPassword);
      await prisma.user.create({
        data: {
          username: config.defaultOwnerUsername.toLowerCase().trim(),
          password,
          plainPassword: config.defaultOwnerPassword,
          firstName: config.defaultOwnerFirstname,
          lastName: config.defaultOwnerLastname,
          role: "owner",
          isActive: true,
        },
      });
      logger.info("Default owner muvaffaqiyatli yaratildi");
    }
  } catch (error) {
    logger.error("Owner yaratishda xato:", error.message);
  }
};

module.exports = initOwner;
