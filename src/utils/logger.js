const winston = require("winston");
const DailyRotateFile = require("winston-daily-rotate-file");
const path = require("path");
const { config } = require("../config/env.config");

// Log formatini belgilash
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

/**
 * Xabarni matnga aylantiradi.
 *
 * ⚠️ `logger.info(obj)` chaqirilsa winston obyektni `message` ga qo'yadi va
 * shablon uni `[object Object]` qilib chop etardi — log butunlay foydasiz
 * bo'lib qolardi. Bu — SO'NGGI HIMOYA: chaqiruvchi kod tayyor satr
 * yuborishi kerak, lekin unutilgan joyda ham log o'qilishi shart.
 */
const toText = (value) => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    // Aylanma havolali obyekt — hech bo'lmasa tur nomi ko'rinsin
    return String(value);
  }
};

// Console uchun odam o'qiy oladigan format
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    const text = toText(message);
    if (stack) {
      return `${timestamp} ${level}: ${text}\n${stack}`;
    }
    return `${timestamp} ${level}: ${text}`;
  })
);

// Transport'lar ro'yxati
const transports = [];

// Console transport (har doim)
transports.push(
  new winston.transports.Console({
    format: consoleFormat,
  })
);

// File transport (faqat production va development)
if (!config.isTest) {
  // Barcha loglar uchun
  transports.push(
    new DailyRotateFile({
      filename: path.join("logs", "combined-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "20m",
      maxFiles: "14d",
      format: logFormat,
    })
  );

  // Faqat error loglar uchun
  transports.push(
    new DailyRotateFile({
      filename: path.join("logs", "error-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "20m",
      maxFiles: "30d",
      level: "error",
      format: logFormat,
    })
  );
}

// Logger yaratish
const logger = winston.createLogger({
  level: config.logLevel || (config.isProduction ? "info" : "debug"),
  format: logFormat,
  transports,
  // Xatolarni handle qilish
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join("logs", "exceptions.log"),
    }),
  ],
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join("logs", "rejections.log"),
    }),
  ],
});

// Development rejimida yanada batafsil loglar
if (!config.isProduction) {
  logger.debug("Logger tizimi ishga tushdi (development rejimida)");
}

module.exports = logger;
