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
const { startAcademicInsightCron } = require("./src/jobs/academicInsight.job");
const { startTopicIncrementCron } = require("./src/jobs/topicIncrement.job");
const { startDailyCoinCron } = require("./src/jobs/coinDaily.job");
const { startTaskPenaltyCron } = require("./src/jobs/taskPenalty.job");
const { startAttendanceAbsentCron } = require("./src/jobs/attendanceAbsent.job");
const { startStudentAttendanceAbsentCron } = require("./src/jobs/studentAttendanceAbsent.job");
const { startGradePenaltyCron } = require("./src/jobs/gradePenalty.job");
const { startTestSessionExpiryCron } = require("./src/jobs/testSessionExpiry.job");
const { startSeasonStatusCron } = require("./src/jobs/seasonStatus.job");
const { startPremiumExpiryCron } = require("./src/jobs/premiumExpiry.job");
const { startInvoiceGenerationCron } = require("./src/jobs/invoiceGeneration.job");
const { startFinanceReconcileCron } = require("./src/jobs/financeReconcile.job");
const { startInventoryReconcileCron } = require("./src/jobs/inventoryReconcile.job");
const {
  startInventoryCheckReminderCron,
} = require("./src/jobs/inventoryCheckReminder.job");
const {
  startChangelogNotificationCron,
} = require("./src/jobs/changelogNotification.job");
const { startSecuritySweepCron } = require("./src/jobs/securitySweep.job");

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
// ⚠️ TANA PARSERI `xss()` DAN OLDIN. `xss-clean` middleware'i
// `if (req.body) req.body = clean(req.body)` shaklida ishlaydi —
// tana hali parse qilinmagan bo'lsa, u faqat `req.query` va
// `req.params` ni tozalab, TANANI umuman ko'rmasdi. Ya'ni butun
// tizim bo'ylab POST/PUT tanalari sanitizatsiyadan o'tmagan edi.
//
// ⚠️ Limiterdan OLDIN ham turadi va bu ataylab: 429 qaytganda ham
// xavfsizlik jurnaliga `username` yozilishi kerak. Tana hajmi
// `express.json()` ning standart 100kb chegarasi bilan cheklangan,
// shuning uchun bu qo'shimcha yuk ahamiyatsiz.
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(xss());

// Rate limiting
const limiter = rateLimit({
  max: 100,
  windowMs: 1 * 60 * 1000,
  message: { message: "Juda ko'p so'rov yuborildi, iltimos biroz kuting." },
});
app.use("/api", limiter);

// Stricter rate limit for login (brute force protection)
//
// ⚠️ `handler` MAJBURIY: limiter 429 qaytarganda so'rov CONTROLLERGA
// yetib bormaydi, ya'ni o'sha urinishlar xavfsizlik jurnaliga tushmasdi
// — va aynan hujum eng qizigan paytda jurnal "jim" bo'lib qolardi.
const loginLimiter = rateLimit({
  max: 10,
  windowMs: 15 * 60 * 1000,
  message: {
    message: "Juda ko'p urinish. 15 daqiqadan so'ng qayta urinib ko'ring.",
  },
  handler: (req, res) => {
    const securityService = require("./src/services/security.service");
    const { clientInfo } = require("./src/helpers/request.helpers");

    securityService.recordAttempt({
      username: String(req.body?.username || "").slice(0, 120),
      success: false,
      reason: "rate_limited",
      client: clientInfo(req),
    });

    res.status(429).json({
      success: false,
      message: "Juda ko'p urinish. 15 daqiqadan so'ng qayta urinib ko'ring.",
    });
  },
});
app.use("/api/auth/login", loginLimiter);

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
  // `connectDB` platformaga ulanadi, filiallar reyestrini o'qiydi va har bir
  // filial schema'sida migratsiyalar qo'llanganini tekshiradi.
  await connectDB();

  // TARTIB: avval rollar (platformada), keyin owner — `initOwner` yangi
  // foydalanuvchiga rolning boshlang'ich ruxsatlarini beradi.
  await initRoles();

  const branchService = require("./src/services/branch.service");
  const defaultBranch = await branchService.getDefaultBranch();
  await initOwner(defaultBranch);

  // Cron job'larni faqat DB ulanganidan keyin ishga tushirish
  startWeeklyStatsCron();
  startAcademicInsightCron();
  startTopicIncrementCron();
  startDailyCoinCron();
  await startTaskPenaltyCron();
  await startAttendanceAbsentCron();
  await startStudentAttendanceAbsentCron();
  startGradePenaltyCron();
  startTestSessionExpiryCron();
  startSeasonStatusCron();
  startPremiumExpiryCron();
  startInvoiceGenerationCron();
  startFinanceReconcileCron();
  startInventoryReconcileCron();
  startInventoryCheckReminderCron();
  startChangelogNotificationCron();
  startSecuritySweepCron();

  // Navbatlar: modul yuklanganda filial konteksti yo'q, shuning uchun
  // "qotib qolgan" yozuvlarni tiklash va navbatni uyg'otish BOOTSTRAP'da,
  // filiallar bo'ylab bajariladi.
  await require("./src/services/messageQueue.service").recoverAll();
  await require("./src/services/penaltyNotificationQueue.service").recoverAll();

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

  // Graceful shutdown — platforma VA barcha ochiq filial ulanishlarini yopish.
  // `config/prisma.js` endi Proxy: unda `$disconnect` yo'q, chunki u joriy
  // filialga bog'liq. Reyestr esa hammasini biladi.
  const platformPrisma = require("./src/config/platformPrisma");
  const branchRegistry = require("./src/config/branchRegistry");
  const shutdown = async (signal) => {
    logger.info(`${signal} qabul qilindi, server yopilmoqda...`);
    server.close(async () => {
      await branchRegistry.disconnectAll();
      await platformPrisma.$disconnectBase();
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
