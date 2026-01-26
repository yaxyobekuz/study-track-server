const winston = require("winston");
const DailyRotateFile = require("winston-daily-rotate-file");
const path = require("path");

// Log formatini belgilash
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Console uchun odam o'qiy oladigan format
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    if (stack) {
      return `${timestamp} ${level}: ${message}\n${stack}`;
    }
    return `${timestamp} ${level}: ${message}`;
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
if (process.env.NODE_ENV !== "test") {
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
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
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
if (process.env.NODE_ENV !== "production") {
  logger.debug("Logger tizimi ishga tushdi (development rejimida)");
}

module.exports = logger;
