/**
 * FILIAL OCHISH — schema yaratish, migratsiya va seed.
 *
 * Uch qadam, va uchalasi ham IDEMPOTENT: xato bo'lsa qayta urinish yetarli,
 * qo'lda tozalash kerak emas.
 *
 *   1) CREATE SCHEMA IF NOT EXISTS  — DDL, platforma ulanishi orqali
 *   2) prisma migrate deploy        — child-process, o'sha schema'ga
 *   3) seed                         — sozlama singletonlari + owner nusxasi
 *
 * NIMA UCHUN CHILD-PROCESS: migratsiyalarni qo'lda (SQL fayllarni o'qib)
 * qo'llash mumkin edi, lekin unda `_prisma_migrations` jadvalini ham qo'lda
 * to'ldirish kerak bo'lardi — checksum, `logs`, `applied_steps_count`. Bitta
 * xato yozuv butun filialni "migratsiya qo'llanmagan" holatiga tushirardi.
 * `migrate deploy` — Prisma'ning o'z hakami, shuning uchun aynan u chaqiriladi.
 * (Shu sababli `prisma` paketi `dependencies` da, `devDependencies` da emas.)
 *
 * ASINXRON: `branch.service.create()` qatorni `provisioning` holatida darhol
 * qaytaradi, bu funksiya esa fonda ishlaydi. `migrate deploy` bir necha soniya
 * davom etadi va HTTP so'rovini ushlab turishi kerak emas.
 */

const path = require("path");
const { spawn } = require("child_process");

const platformPrisma = require("../config/platformPrisma");
const { config } = require("../config/env.config");
const { runWithBranch } = require("../config/branchContext");
const { getClientForSchema, evictSchema } = require("../config/branchRegistry");
const { buildSchemaUrl, assertSafeSchemaName } = require("../helpers/schemaUrl.helpers");
const logger = require("../utils/logger");
const branchService = require("./branch.service");
const settingsService = require("./settings.service");
const initOwnerModule = require("../utils/initOwner");

const SERVER_ROOT = path.join(__dirname, "..", "..");
const MIGRATE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * `CREATE SCHEMA IF NOT EXISTS`.
 *
 * DDL parametrlanmaydi, shuning uchun nom `$executeRawUnsafe` ga tushishdan
 * OLDIN `assertSafeSchemaName` dan o'tadi (`helpers/schemaUrl.helpers.js`).
 *
 * @param {string} schemaName
 */
const createSchema = async (schemaName) => {
  assertSafeSchemaName(schemaName);
  await platformPrisma.$executeRawUnsafe(
    `CREATE SCHEMA IF NOT EXISTS "${schemaName}"`,
  );
  logger.info(`[Provision] Schema tayyor: ${schemaName}`);
};

/**
 * `prisma migrate deploy` ni berilgan schema uchun ishga tushiradi.
 *
 * @param {string} schemaName
 * @returns {Promise<void>}
 */
const runMigrations = (schemaName) =>
  new Promise((resolve, reject) => {
    const url = buildSchemaUrl(config.databaseUrl, schemaName, {
      connectionLimit: 1, // migratsiya bitta ulanishda ketadi
    });

    // Windows'da `prisma` — .cmd, shuning uchun `shell: true`.
    const child = spawn("npx", ["prisma", "migrate", "deploy"], {
      cwd: SERVER_ROOT,
      shell: true,
      env: { ...process.env, DATABASE_URL: url },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Migratsiya ${MIGRATE_TIMEOUT_MS / 1000}s ichida tugamadi`));
    }, MIGRATE_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        logger.info(`[Provision] Migratsiya qo'llandi: ${schemaName}`);
        resolve();
      } else {
        reject(
          new Error(
            `prisma migrate deploy xato bilan tugadi (${code}): ${stderr || stdout}`,
          ),
        );
      }
    });
  });

/**
 * Yangi filialni ishlashga tayyorlaydi: sozlama singletonlari + owner nusxasi.
 *
 * Sozlamalar ALOHIDA seed yozilmaydi — `settings.service.js` dagi
 * `get*Settings()` upsert'lari aynan shu ish uchun mo'ljallangan va ular
 * yagona haqiqat manbai (default qiymatlar schema'da).
 *
 * @param {object} branch
 */
const seedBranch = async (branch) => {
  await runWithBranch(branch, async () => {
    await Promise.all([
      settingsService.getCoinSettings(),
      settingsService.getScheduleSettings(),
      settingsService.getPlannerSettings(),
      settingsService.getAttendanceSettings(),
      settingsService.getGradePenaltySettings(),
      settingsService.getTestSettings(),
      settingsService.getPenaltySettings(),
      settingsService.getPremiumSettings(),
      settingsService.getFinanceSettings(),
    ]);
  });

  // Owner har filialda AYNAN O'SHA `id` bilan bo'lishi kerak — sababi
  // utils/initOwner.js izohida.
  const defaultBranch = await branchService.getDefaultBranch();
  if (defaultBranch) {
    const owner = await initOwnerModule.readOwner(defaultBranch);
    await initOwnerModule.mirrorOwnerIntoBranch(branch, owner);
  }

  logger.info(`[Provision] Seed tugadi: ${branch.name}`);
};

/**
 * To'liq provisioning. Xato bo'lsa filial `failed` holatiga o'tadi va sababi
 * `provisionError` da qoladi — admin UI shuni ko'rsatadi va "Qayta urinish"
 * tugmasi shu funksiyani qayta chaqiradi.
 *
 * @param {object} branch - `Branch` qatori
 * @returns {Promise<object>} yangilangan filial
 */
const provision = async (branch) => {
  const startedAt = Date.now();
  logger.info(`[Provision] "${branch.name}" ochilmoqda (${branch.schemaName})...`);

  try {
    await branchService.setStatus(branch.id, "provisioning", null);

    await createSchema(branch.schemaName);
    await runMigrations(branch.schemaName);

    // Migratsiyadan OLDIN ochilgan client eski (bo'sh) metadata bilan
    // qolishi mumkin — toza ulanish olamiz.
    await evictSchema(branch.schemaName);
    await getClientForSchema(branch.schemaName).$connect();

    await seedBranch(branch);

    const ready = await branchService.setStatus(branch.id, "ready", null);
    logger.info(
      `[Provision] "${branch.name}" tayyor (${Math.round((Date.now() - startedAt) / 1000)}s)`,
    );
    return ready;
  } catch (error) {
    logger.error(`[Provision] "${branch.name}" xato bilan tugadi: ${error.message}`);
    await evictSchema(branch.schemaName).catch(() => {});
    return branchService.setStatus(branch.id, "failed", error.message.slice(0, 2000));
  }
};

/**
 * Fonda ishga tushiradi (HTTP javobi kutmaydi).
 * @param {object} branch
 */
const provisionInBackground = (branch) => {
  setImmediate(() => {
    provision(branch).catch((error) =>
      logger.error(`[Provision] Kutilmagan xato: ${error.message}`),
    );
  });
};

module.exports = {
  provision,
  provisionInBackground,
  createSchema,
  runMigrations,
  seedBranch,
};
