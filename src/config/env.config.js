/**
 * Environment Variables Validation & Centralized Config
 *
 * Server ishga tushishidan oldin barcha kerakli environment variables'lar
 * mavjudligini tekshiradi va markazlashtirilgan config object export qiladi.
 *
 * MUHIM: Bu fayl logger init bo'lishidan oldin ishlaydi,
 * shuning uchun faqat console.log ishlatiladi.
 */

const requiredEnvVars = ["DATABASE_URL", "JWT_SECRET"];

const optionalEnvVars = {
  PORT: 5000,
  NODE_ENV: "development",
  JWT_EXPIRES_IN: "30d",
  LOG_LEVEL: "info",
  DO_REGION: "fra1",
  MAX_UPLOAD_FILE_SIZE_MB: 20,
  // Filiallashtirish
  PLATFORM_SCHEMA: "platform",
  BRANCH_SCHEMA_PREFIX: "br_",
  BRANCH_CONNECTION_LIMIT: 5,
};

/**
 * Ulanish satrining `schema` parametrini almashtiradi.
 *
 * `helpers/schemaUrl.helpers.js` dagi `buildSchemaUrl` bilan bir xil ish
 * qiladi, lekin bu fayl LOGGER'DAN ham, `utils/errors.js` dan ham OLDIN
 * yuklanadi (izohga qarang) — shuning uchun bu yerda mustaqil, tashqi
 * bog'liqliksiz nusxa turadi.
 */
const withSchema = (url, schema) => {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("schema", schema);
    return parsed.toString();
  } catch {
    return undefined; // noto'g'ri URL — validateEnv baribir xato beradi
  }
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

  // PLATFORM_DATABASE_URL — `DATABASE_URL` dan hosila. `process.env` ga ham
  // yoziladi, chunki uni IKKI iste'molchi o'qiydi: platforma client'i (bu
  // yerdan) va `prisma migrate deploy` child-process'i (env orqali — filial
  // ochilganda va `npm run branch:migrate` da).
  if (!process.env.PLATFORM_DATABASE_URL) {
    const derived = withSchema(process.env.DATABASE_URL, process.env.PLATFORM_SCHEMA);
    if (!derived) {
      throw new Error(
        "PLATFORM_DATABASE_URL hosil qilinmadi: DATABASE_URL noto'g'ri formatda",
      );
    }
    process.env.PLATFORM_DATABASE_URL = derived;
    console.log(
      `PLATFORM_DATABASE_URL kiritilmagan. DATABASE_URL dan hosil qilindi (schema=${process.env.PLATFORM_SCHEMA})`,
    );
  }

  console.log("Environment variables tekshirildi");
};

/**
 * Markazlashtirilgan config object
 * Barcha env var'lar shu yerdan olinadi - boshqa fayllar process.env ishlatmasligi kerak
 */
const config = {
  // Server
  port: parseInt(process.env.PORT, 10) || 5000,
  nodeEnv: process.env.NODE_ENV || "development",
  isProduction: (process.env.NODE_ENV || "development") === "production",
  isDevelopment: (process.env.NODE_ENV || "development") === "development",
  isTest: (process.env.NODE_ENV || "development") === "test",

  // Database (PostgreSQL — Prisma)
  // `DATABASE_URL` — BAZAGA ulanish satri. Filial u yerdagi `schema`
  // parametri bilan tanlanadi (helpers/schemaUrl.helpers.js), shuning uchun
  // yangi filial yangi ulanish satri, parol yoki zaxira nusxa TALAB QILMAYDI.
  databaseUrl: process.env.DATABASE_URL,

  // Filiallashtirish
  platformSchema: process.env.PLATFORM_SCHEMA || "platform",
  platformDatabaseUrl:
    process.env.PLATFORM_DATABASE_URL ||
    withSchema(process.env.DATABASE_URL, process.env.PLATFORM_SCHEMA || "platform"),
  branchSchemaPrefix: process.env.BRANCH_SCHEMA_PREFIX || "br_",
  // Har filial client'ining pool hajmi. Prisma standarti (CPU×2+1) o'n
  // filialda Postgres `max_connections` ini yeb qo'yardi.
  branchConnectionLimit: parseInt(process.env.BRANCH_CONNECTION_LIMIT, 10) || 5,

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
  // O'quvchi paneli (Telegram WebApp) public URL - bot tugmalari uchun
  studentWebappUrl: process.env.STUDENT_WEBAPP_URL || "http://localhost:3000",

  // AI (OpenAI) - savol generatsiyasi uchun (ixtiyoriy)
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  aiMaxQuestionsPerRequest:
    parseInt(process.env.AI_MAX_QUESTIONS_PER_REQUEST, 10) || 20,

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
