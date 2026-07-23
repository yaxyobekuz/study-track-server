// Load environment variables
require("dotenv").config();

// Validate environment variables
const { validateEnv, config } = require("./src/config/env.config");
validateEnv();

// Logger
const logger = require("./src/utils/logger");

// Express
const express = require("express");

// Security middleware
const cors = require("cors");
const helmet = require("helmet");
const xss = require("xss-clean");
const rateLimit = require("express-rate-limit");

// Routes
const routes = require("./src/routes");

// Swagger UI (o'qituvchi paneli API hujjati)
const swaggerUi = require("swagger-ui-express");
const teacherApiSpec = require("./src/docs/teacherSwagger");

// Database connection
const connectDB = require("./src/config/database");

// Middlewares
const { errorHandler, notFound } = require("./src/middleware/error.middleware");
const requestLogger = require("./src/middleware/requestLogger.middleware");

// Initialization utilities
const initOwner = require("./src/utils/initOwner");
const initRoles = require("./src/utils/initRoles");

// Cron jobs
const { startWeeklyStatsCron } = require("./src/jobs/weeklystats.job");
const { startTopicIncrementCron } = require("./src/jobs/topicIncrement.job");
const { startDailyCoinCron } = require("./src/jobs/coinDaily.job");
const { startTaskPenaltyCron } = require("./src/jobs/taskPenalty.job");
const { startAttendanceAbsentCron } = require("./src/jobs/attendanceAbsent.job");
const { startStudentAttendanceAbsentCron } = require("./src/jobs/studentAttendanceAbsent.job");
const { startGradePenaltyCron } = require("./src/jobs/gradePenalty.job");
const { startTestSessionExpiryCron } = require("./src/jobs/testSessionExpiry.job");
const { startSeasonStatusCron } = require("./src/jobs/seasonStatus.job");
const { startPremiumExpiryCron } = require("./src/jobs/premiumExpiry.job");

// ================================

// Initialize app
const app = express();

// Trust proxy
app.set("trust proxy", 1);

// Swagger UI — helmet'dan OLDIN ulanadi (CSP inline skriptlarni bloklamasligi uchun)
// O'qituvchi paneli API hujjati: http://localhost:<PORT>/api-docs
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(teacherApiSpec, {
    customSiteTitle: "Study-Track — O'qituvchi API",
    swaggerOptions: { persistAuthorization: true },
  }),
);

// Security middleware
app.use(helmet());
app.use(
  cors(
    config.corsOrigins.length > 0
      ? { origin: config.corsOrigins, credentials: true }
      : undefined,
  ),
);
app.use(xss());

// Rate limiting
const limiter = rateLimit({
  max: 100,
  windowMs: 1 * 60 * 1000,
  message: { message: "Juda ko'p so'rov yuborildi, iltimos biroz kuting." },
});
app.use("/api", limiter);

// Stricter rate limit for login (brute force protection)
const loginLimiter = rateLimit({
  max: 10,
  windowMs: 15 * 60 * 1000,
  message: {
    message: "Juda ko'p urinish. 15 daqiqadan so'ng qayta urinib ko'ring.",
  },
});
app.use("/api/auth/login", loginLimiter);

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logger (har bir so'rovni log qiladi)
app.use(requestLogger);

// Routes
app.use("/api", routes);

// Error handling
app.use(notFound);
app.use(errorHandler);

/**
 * Server va barcha async tizimlarni ketma-ket ishga tushiradi
 * DB ulanish → Owner init → Roles init → Cron jobs → HTTP server
 */
const bootstrap = async () => {
  await connectDB();
  await initOwner();
  await initRoles();

  // Cron job'larni faqat DB ulanganidan keyin ishga tushirish
  startWeeklyStatsCron();
  startTopicIncrementCron();
  startDailyCoinCron();
  await startTaskPenaltyCron();
  await startAttendanceAbsentCron();
  await startStudentAttendanceAbsentCron();
  startGradePenaltyCron();
  startTestSessionExpiryCron();
  startSeasonStatusCron();
  startPremiumExpiryCron();

  const server = app.listen(config.port, () => {
    logger.info(`Server port ${config.port} da ishga tushdi`);
    logger.info(`Muhit: ${config.nodeEnv}`);
  });

  // app.listen xatolarini ushlash (masalan, port band bo'lsa EADDRINUSE)
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      // console.error ishlatamiz, chunki logger faylga yozib ulgurmasdan process.exit bo'lib ketadi
      console.error(
        `\n[XATO] Port ${config.port} band. Boshqa jarayon shu portni egallab turibdi.\n` +
          `Yechim: o'sha jarayonni to'xtating yoki .env faylida PORT qiymatini o'zgartiring.\n`,
      );
      logger.error(`Port ${config.port} band (EADDRINUSE)`);
    } else {
      console.error("[XATO] Server ishga tushmadi:", err);
      logger.error("Server listen xatosi:", err);
    }
    process.exit(1);
  });

  // Graceful shutdown — Prisma ulanishini yopish
  const prisma = require("./src/config/prisma");
  const shutdown = async (signal) => {
    logger.info(`${signal} qabul qilindi, server yopilmoqda...`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

bootstrap().catch((err) => {
  // logger async faylga yozadi, process.exit dan oldin flush bo'lmasligi mumkin -
  // shuning uchun konsolga ham chiqaramiz
  console.error("[XATO] Server ishga tushishda xato:", err);
  logger.error("Server ishga tushishda xato:", err);
  process.exit(1);
});

module.exports = app;
