const fs = require("fs");
const path = require("path");
const prisma = require("./prisma");
const logger = require("../utils/logger");

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "prisma", "migrations");

/**
 * `prisma/migrations` papkasini bazadagi `_prisma_migrations` jadvali bilan
 * solishtiradi va qo'llanmagan migratsiya bo'lsa serverni to'xtatadi.
 *
 * Aks holda xato faqat so'rov vaqtida, tushunarsiz ko'rinishda chiqadi:
 * "The column `roles.permissions` does not exist in the current database".
 */
const assertMigrationsApplied = async () => {
  let localMigrations;
  try {
    localMigrations = fs
      .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return; // migrations papkasi yo'q — tekshirishga asos yo'q
  }

  if (localMigrations.length === 0) return;

  let applied;
  try {
    const rows = await prisma.$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    applied = new Set(rows.map((row) => row.migration_name));
  } catch (error) {
    // Jadval yo'q yoki o'qish huquqi yo'q — startup'ni to'xtatmaymiz
    logger.warn(`Migratsiya holatini tekshirib bo'lmadi: ${error.message}`);
    return;
  }

  const pending = localMigrations.filter((name) => !applied.has(name));
  if (pending.length === 0) return;

  const message =
    `Bazaga qo'llanmagan ${pending.length} ta migratsiya bor:\n` +
    pending.map((name) => `  - ${name}`).join("\n") +
    `\nYechim: server papkasida "npm run prisma:migrate" ni ishga tushiring.`;

  // logger faylga async yozadi, process.exit dan oldin flush bo'lmasligi mumkin
  console.error(`\n[XATO] ${message}\n`);
  logger.error(message);
  process.exit(1);
};

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

  await assertMigrationsApplied();
};

module.exports = connectDB;
