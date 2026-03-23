/**
 * Environment Variables Validation & Centralized Config
 *
 * Server ishga tushishidan oldin barcha kerakli environment variables'lar
 * mavjudligini tekshiradi va markazlashtirilgan config object export qiladi.
 *
 * MUHIM: Bu fayl logger init bo'lishidan oldin ishlaydi,
 * shuning uchun faqat console.log ishlatiladi.
 */

const requiredEnvVars = ["MONGODB_URI", "JWT_SECRET"];

const optionalEnvVars = {
  PORT: 5000,
  NODE_ENV: "development",
  JWT_EXPIRES_IN: "30d",
  LOG_LEVEL: "info",
  DO_REGION: "fra1",
  MAX_UPLOAD_FILE_SIZE_MB: 20,
};

/**
 * Environment variables'larni tekshiradi
 * @throws {Error} Agar majburiy environment variable yo'q bo'lsa
 */
const validateEnv = () => {
  const missingVars = [];

  // Majburiy variables'larni tekshirish
  requiredEnvVars.forEach((varName) => {
    if (!process.env[varName]) {
      missingVars.push(varName);
    }
  });

  if (missingVars.length > 0) {
    throw new Error(
      `Quyidagi environment variables kiritilmagan: ${missingVars.join(", ")}\n` +
        `Iltimos, .env faylida ushbu qiymatlarni to'ldiring.`,
    );
  }

  // Optional variables uchun default qiymatlarni belgilash
  Object.entries(optionalEnvVars).forEach(([key, defaultValue]) => {
    if (!process.env[key]) {
      process.env[key] = String(defaultValue);
      console.log(
        `${key} environment variable kiritilmagan. Default qiymat ishlatilmoqda: ${defaultValue}`,
      );
    }
  });

  console.log("Environment variables tekshirildi");
};

/**
 * Markazlashtirilgan config object
 * Barcha env var'lar shu yerdan olinadi — boshqa fayllar process.env ishlatmasligi kerak
 */
const config = {
  // Server
  port: parseInt(process.env.PORT, 10) || 5000,
  nodeEnv: process.env.NODE_ENV || "development",
  isProduction: (process.env.NODE_ENV || "development") === "production",
  isDevelopment: (process.env.NODE_ENV || "development") === "development",
  isTest: (process.env.NODE_ENV || "development") === "test",

  // Database
  mongodbUri: process.env.MONGODB_URI,

  // JWT
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "30d",

  // Logging
  logLevel: process.env.LOG_LEVEL || "info",

  // DigitalOcean Spaces
  doEndpoint: process.env.DO_ENDPOINT || "",
  doRegion: process.env.DO_REGION || "fra1",
  doAccessKey: process.env.DO_ACCESS_KEY,
  doSecretKey: process.env.DO_SECRET_KEY,
  doBucketName: process.env.DO_BUCKET_NAME,
  doBucketPublicBaseUrl: process.env.DO_BUCKET_PUBLIC_BASE_URL,

  // Upload
  maxUploadFileSizeMb: parseInt(process.env.MAX_UPLOAD_FILE_SIZE_MB, 10) || 20,

  // Telegram
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,

  // Message queue
  messageRateLimitMs: parseInt(process.env.MESSAGE_RATE_LIMIT_MS, 10) || 1000,

  // Grade
  gradeTimeLimitMinutes: parseInt(process.env.GRADE_TIME_LIMIT_MINUTES, 10) || 30,
  enableScheduleTimeValidation: process.env.ENABLE_SCHEDULE_TIME_VALIDATION === "true",

  // CORS
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim())
    : [],

  // Default owner
  defaultOwnerUsername: process.env.DEFAULT_OWNER_USERNAME || "admin",
  defaultOwnerPassword: process.env.DEFAULT_OWNER_PASSWORD || "admin123",
  defaultOwnerFirstname: process.env.DEFAULT_OWNER_FIRSTNAME || "Administrator",
  defaultOwnerLastname: process.env.DEFAULT_OWNER_LASTNAME,
};

module.exports = { validateEnv, config };
