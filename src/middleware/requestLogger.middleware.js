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

    // ⚠️ BIRINCHI ARGUMENT — TAYYOR SATR, obyekt emas.
    // `logger.warn(obj)` chaqirilganda winston obyektni `message` ga
    // qo'yadi va konsolda `warn: [object Object]` chiqardi: so'rov logi
    // butunlay foydasiz bo'lib qolgan edi. Tuzilgan ma'lumot IKKINCHI
    // argument sifatida beriladi — u fayl (JSON) transportiga to'liq
    // tushadi, konsolda esa qisqa satr ko'rinadi.
    const line =
      `${logData.method} ${logData.url} ${logData.statusCode} · ${logData.duration}` +
      (logData.userId ? ` · user=${logData.userId}` : "");

    if (res.statusCode >= 500) {
      logger.error(line, logData);
    } else if (res.statusCode >= 400) {
      logger.warn(line, logData);
    } else {
      logger.info(line, logData);
    }
  });

  next();
};

module.exports = requestLogger;
