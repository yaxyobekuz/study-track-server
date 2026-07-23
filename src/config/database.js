const prisma = require("./prisma");
const logger = require("../utils/logger");

/**
 * PostgreSQL (Prisma) ulanishini tekshiradi.
 * Prisma lazy-connect qiladi, lekin startup'da xatoni erta aniqlash uchun
 * bir marta `$connect()` chaqiramiz.
 */
const connectDB = async () => {
  try {
    await prisma.$connect();
    logger.info("PostgreSQL (Prisma) ulandi");
  } catch (error) {
    logger.error(`PostgreSQL ulanish xatosi: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
