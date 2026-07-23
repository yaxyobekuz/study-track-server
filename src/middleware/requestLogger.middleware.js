const logger = require("../utils/logger");

/**
 * Request logger middleware
 *
 * Har bir HTTP so'rovni log qiladi:
 * - HTTP method
 * - URL
 * - IP address
 * - User ID (agar autentifikatsiya qilingan bo'lsa)
 * - Response vaqti (millisekund)
 * - Status code
 */
const requestLogger = (req, res, next) => {
  const start = Date.now();

  // Response tugaganda log yozish
  res.on("finish", () => {
    const duration = Date.now() - start;
    const logData = {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get("user-agent"),
    };

    // Agar foydalanuvchi autentifikatsiya qilgan bo'lsa, user ID ni ham qo'shamiz
    if (req.user) {
      logData.userId = req.user.id;
      logData.userRole = req.user.role;
    }

    // Status code bo'yicha log level tanlash
    if (res.statusCode >= 500) {
      logger.error(logData);
    } else if (res.statusCode >= 400) {
      logger.warn(logData);
    } else {
      logger.info(logData);
    }
  });

  next();
};

module.exports = requestLogger;
