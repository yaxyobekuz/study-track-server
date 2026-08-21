const fs = require("fs");
const path = require("path");
const platformPrisma = require("./platformPrisma");
const { getClientForSchema } = require("./branchRegistry");
const logger = require("../utils/logger");

const BRANCH_MIGRATIONS_DIR = path.join(__dirname, "..", "..", "prisma", "migrations");
const PLATFORM_MIGRATIONS_DIR = path.join(
  __dirname,
  "..",
  "..",
  "prisma",
  "platform",
  "migrations",
);

/**
 * Migratsiya papkasidagi nomlar ro'yxati (yo'q bo'lsa `null`).
 * @param {string} dir
 * @returns {string[]|null}
 */
const readLocalMigrations = (dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null; // migrations papkasi yo'q — tekshirishga asos yo'q
  }
};

/**
 * Bitta schema uchun: lokal migratsiyalarni `_prisma_migrations` bilan
 * solishtiradi va qo'llanmaganlarini qaytaradi.
 *
 * Filiallashtirishdan oldin bu funksiya bitta global `prisma` client'ini
 * ishlatardi. Endi client PARAMETR: aynan shu mantiq platforma schema'siga
 * ham, har bir filial schema'siga ham qo'llanadi.
 *
 * @param {object} client - PrismaClient (platforma yoki filial)
 * @param {string[]} localMigrations
 * @param {string} label - xato xabari uchun ("platform", "Bosh filial")
 * @returns {Promise<string[]>} qo'llanmagan migratsiyalar
 */
const findPendingMigrations = async (client, localMigrations, label) => {
  if (!localMigrations || localMigrations.length === 0) return [];

  let applied;
  try {
    const rows = await client.$queryRaw`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    applied = new Set(rows.map((row) => row.migration_name));
  } catch (error) {
    // Jadval yo'q yoki o'qish huquqi yo'q — startup'ni to'xtatmaymiz
    logger.warn(`[${label}] Migratsiya holatini tekshirib bo'lmadi: ${error.message}`);
    return [];
  }

  return localMigrations.filter((name) => !applied.has(name));
};

/**
 * Startup'ni to'xtatuvchi xato. Aks holda muammo faqat so'rov vaqtida,
 * tushunarsiz ko'rinishda chiqadi:
 * "The column `roles.permissions` does not exist in the current database".
 */
const failOnPending = (problems) => {
  const message =
    `Bazaga qo'llanmagan migratsiyalar bor:\n` +
    problems
      .map(({ label, pending }) => `  [${label}]\n${pending.map((n) => `    - ${n}`).join("\n")}`)
      .join("\n") +
    `\nYechim: server papkasida "npm run branch:migrate" ni ishga tushiring.`;

  // logger faylga async yozadi, process.exit dan oldin flush bo'lmasligi mumkin
  console.error(`\n[XATO] ${message}\n`);
  logger.error(message);
  process.exit(1);
};

/**
 * PostgreSQL (Prisma) ulanishini tekshiradi va migratsiyalarni nazorat qiladi.
 *
 * TARTIB MUHIM: avval platforma ulanadi, chunki filiallar ro'yxati aynan
 * o'sha yerda. Filiallar reyestri o'qilmasa server ishga tushishi mumkin emas.
 *
 * @returns {Promise<object[]>} faol filiallar (bootstrap keyin ishlatadi)
 */
const connectDB = async () => {
  // ── 1. Platforma ──────────────────────────
  try {
    await platformPrisma.$connect();
    logger.info("PostgreSQL — platforma schema'si ulandi");
  } catch (error) {
    console.error(
      `\n[XATO] Platforma bazasiga ulanib bo'lmadi: ${error.message}\n` +
        `Yechim: "npm run branch:bootstrap" ni ishga tushiring (platforma schema'si hali yaratilmagan bo'lishi mumkin).\n`,
    );
    logger.error(`Platforma ulanish xatosi: ${error.message}`);
    process.exit(1);
  }

  const problems = [];

  const platformPending = await findPendingMigrations(
    platformPrisma,
    readLocalMigrations(PLATFORM_MIGRATIONS_DIR),
    "platform",
  );
  if (platformPending.length) {
    problems.push({ label: "platform", pending: platformPending });
  }

  // ── 2. Filiallar ──────────────────────────
  let branches = [];
  try {
    branches = await platformPrisma.branch.findMany({
      where: { isArchived: false, status: "ready" },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
  } catch (error) {
    // `branches` jadvali yo'q — platforma migratsiyalari qo'llanmagan.
    // Yuqoridagi `problems` allaqachon buni ushlagan bo'lishi kerak.
    logger.warn(`Filiallar reyestri o'qilmadi: ${error.message}`);
  }

  if (branches.length === 0 && problems.length === 0) {
    console.error(
      `\n[XATO] Reyestrda birorta tayyor filial yo'q.\n` +
        `Yechim: "npm run branch:bootstrap" — mavjud baza "Bosh filial" sifatida ro'yxatga olinadi.\n`,
    );
    logger.error("Reyestrda tayyor filial yo'q");
    process.exit(1);
  }

  const branchMigrations = readLocalMigrations(BRANCH_MIGRATIONS_DIR);

  for (const branch of branches) {
    const client = getClientForSchema(branch.schemaName);
    try {
      await client.$connect();
    } catch (error) {
      console.error(
        `\n[XATO] "${branch.name}" filiali (schema: ${branch.schemaName}) bazasiga ulanib bo'lmadi: ${error.message}\n`,
      );
      logger.error(`Filial ulanish xatosi (${branch.code}): ${error.message}`);
      process.exit(1);
    }

    const pending = await findPendingMigrations(client, branchMigrations, branch.name);
    if (pending.length) problems.push({ label: branch.name, pending });
  }

  if (problems.length) failOnPending(problems);

  logger.info(
    `PostgreSQL — ${branches.length} ta filial ulandi: ` +
      branches.map((b) => `${b.name} (${b.schemaName})`).join(", "),
  );

  return branches;
};

module.exports = connectDB;
module.exports.findPendingMigrations = findPendingMigrations;
module.exports.readLocalMigrations = readLocalMigrations;
module.exports.BRANCH_MIGRATIONS_DIR = BRANCH_MIGRATIONS_DIR;
module.exports.PLATFORM_MIGRATIONS_DIR = PLATFORM_MIGRATIONS_DIR;
