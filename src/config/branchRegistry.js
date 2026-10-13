/**
 * FILIAL CLIENT'LARI REYESTRI — `schemaName` → PrismaClient.
 *
 * Har filial o'z PostgreSQL schema'sida yashaydi, ya'ni o'z ulanish satri va
 * o'z pool'i bilan alohida PrismaClient talab qiladi. Client'lar LAZY
 * yaratiladi: server 20 ta filial bilan ishga tushsa ham, faqat murojaat
 * qilingan filiallar ulanadi.
 *
 * POOL: har client uchun `connection_limit` ataylab kichik (default 5).
 * Prisma standarti — `CPU × 2 + 1`, ya'ni 4 yadroli serverda 9. O'n filialda
 * bu 90 ta ulanish bo'lib, Postgres'ning odatiy `max_connections = 100` ini
 * yeb qo'yardi.
 *
 * ⚠️ LEKIN FILIAL CHEKLOVINING O'ZI YETARLI EMAS. `connection_limit` HAR BIR
 * client uchun amal qiladi, jami esa ochilgan filiallar soniga ko'payadi:
 * 6 filial × 5 + platforma 5 = 35, va bazaga bitta jarayon emas, bir nechtasi
 * ulanadi (prod, dev nusxasi, pgAdmin). Rolda `rolconnlimit = 100` bo'lsa
 * "too many connections for role" aynan shunda chiqadi.
 *
 * Shuning uchun chegara filialga emas, JARAYONGA qo'yiladi
 * (`config.dbConnectionBudget`): budjet ochiq filiallarga teng bo'linadi va
 * yangi filial ochilganda mavjud client'lar QAYTA O'LCHANADI. Shu sababli
 * jami ulanish filiallar soni qancha bo'lishidan qat'i nazar budjetdan
 * oshmaydi — "filial qo'shdim, server yiqildi" holati tuzilishi bo'yicha
 * imkonsiz.
 *
 * Kesh kaliti — `id` emas, `schemaName`: filial qatori qayta o'qilganda ham,
 * migratsiya skriptidan chaqirilganda ham (u yerda `Branch` qatori bo'lmasligi
 * mumkin) bir xil client qaytadi.
 */

const { PrismaClient, Prisma } = require("../generated/prisma");
const { config } = require("./env.config");
const { buildSchemaUrl } = require("../helpers/schemaUrl.helpers");
const logger = require("../utils/logger");
const {
  buildAutoIdExtension,
  virtualsExtension,
} = require("./prismaExtensions");

// Tranzaksiya ichida ikkinchi so'rov kerak bo'lishi mumkin — 1 ta ulanishli
// pool o'zini kutib qolardi.
const MIN_POOL_SIZE = 2;

// Almashtirilgan client yopilishidan oldin davom etayotgan so'rovlarga
// beriladigan muhlat.
const RETIRE_DELAY_MS = 30_000;

// schemaName -> extended PrismaClient
const clients = new Map();

// schemaName -> o'sha client yaratilgandagi `connection_limit`. Qayta
// o'lchashda kerak: Prisma pool hajmini ish vaqtida ko'rsatmaydi.
const poolSizes = new Map();

// Budjet yetmasligi haqida ogohlantirish qaysi filial sonida yozilgani.
let budgetWarnedFor = 0;

/**
 * Xom (kengaytirilmagan) client — `$disconnect` uchun kerak, chunki
 * `$extends()` yangi obyekt qaytaradi va undagi `$disconnect` baribir
 * asosiy client'ga boradi, lekin havolani aniq saqlab qo'ygan tozaroq.
 */
const baseClients = new Map();

/**
 * Berilgan schema uchun client (kerak bo'lsa yaratadi).
 *
 * @param {string} schemaName - "public", "br_chilonzor"
 * @returns {import("../generated/prisma").PrismaClient}
 */
function getClientForSchema(schemaName) {
  const cached = clients.get(schemaName);
  if (cached) return cached;

  const base = buildBase(schemaName, poolSizeFor(clients.size + 1));

  const client = base
    .$extends(buildAutoIdExtension(Prisma))
    .$extends(virtualsExtension);

  baseClients.set(schemaName, base);
  clients.set(schemaName, client);

  // Yangi filial qo'shilgani bilan ulush kichraydi — eskilari ham qayta
  // o'lchanadi, aks holda birinchi ochilgan filiallar budjetdan katta
  // pool bilan qolib ketardi.
  rebalance();

  return client;
}

/**
 * Bitta client uchun pool hajmi: budjetni ochiq filiallarga bo'lib, kamida
 * `MIN_POOL_SIZE` beradi (tranzaksiya ichida ikkinchi so'rov kerak bo'lishi
 * mumkin, 1 ta ulanish o'zini deadlock qilardi) va `branchConnectionLimit`
 * dan oshmaydi — filial kam bo'lganda ham pool cheksiz o'smaydi.
 */
function poolSizeFor(clientCount) {
  const budget = Math.max(
    config.dbConnectionBudget - config.platformConnectionLimit,
    MIN_POOL_SIZE,
  );
  const count = Math.max(clientCount, 1);
  const share = Math.floor(budget / count);

  // ⚠️ `MIN_POOL_SIZE` budjetdan USTUN. Bo'linma 2 dan kichik bo'lganda
  // (budjet 25, 15+ filial) jami budjetdan oshadi — pool'ni 1 ga tushirish
  // tranzaksiyani o'zini kutib qoldirgani uchun bu ataylab shunday.
  // Bunday holatda jim qolmaydi: budjet oshirilishi yoki pgBouncer
  // qo'yilishi kerak, ikkalasi ham sozlama qarori.
  // Ogohlantirish har filial ochilganda ikki marta (`getClientForSchema` va
  // `rebalance`) chaqirilgani uchun filial soniga bir martadan yoziladi.
  if (share < MIN_POOL_SIZE && budgetWarnedFor !== count) {
    budgetWarnedFor = count;
    logger.warn(
      `[BranchPool] ${count} ta filial uchun budjet (${config.dbConnectionBudget}) yetmaydi: ` +
        `har biriga ${MIN_POOL_SIZE} ta ulanish bilan jami ` +
        `${count * MIN_POOL_SIZE + config.platformConnectionLimit} bo'ladi. ` +
        `DB_CONNECTION_BUDGET ni oshiring yoki pgBouncer qo'ying.`,
    );
  }

  return Math.min(Math.max(share, MIN_POOL_SIZE), config.branchConnectionLimit);
}

/** `connection_limit` va `pool_timeout` qo'yilgan xom client. */
function buildBase(schemaName, connectionLimit) {
  const url = buildSchemaUrl(config.databaseUrl, schemaName, {
    connectionLimit,
    poolTimeout: config.dbPoolTimeout,
  });

  const base = new PrismaClient({
    datasourceUrl: url,
    log: config.isDevelopment ? ["warn", "error"] : ["error"],
  });

  poolSizes.set(schemaName, connectionLimit);
  return base;
}

/**
 * Ochiq client'larning pool hajmini joriy filial soniga moslaydi.
 *
 * Prisma pool hajmini ish vaqtida o'zgartirmaydi — shuning uchun hajmi
 * noto'g'ri bo'lgan client O'RNIGA yangisi qo'yiladi, eskisi esa FONDA
 * yopiladi: shu zahoti `$disconnect()` qilsak, o'sha client bilan
 * boshlangan so'rov o'rtada uzilib qolardi.
 */
function rebalance() {
  const target = poolSizeFor(clients.size);

  for (const schemaName of [...clients.keys()]) {
    if (poolSizes.get(schemaName) === target) continue;

    const stale = baseClients.get(schemaName);
    const base = buildBase(schemaName, target);

    clients.set(
      schemaName,
      base.$extends(buildAutoIdExtension(Prisma)).$extends(virtualsExtension),
    );
    baseClients.set(schemaName, base);

    if (stale) retire(stale);
  }
}

/** Almashtirilgan client'ni davom etayotgan so'rovlardan keyin yopadi. */
function retire(base) {
  setTimeout(() => {
    base.$disconnect().catch(() => {});
  }, RETIRE_DELAY_MS).unref();
}

/**
 * Filial obyekti bo'yicha client.
 * @param {{schemaName: string}} branch
 */
function getClientForBranch(branch) {
  return getClientForSchema(branch.schemaName);
}

/**
 * Client'ni keshdan chiqarib, ulanishni yopadi. Filial arxivlanganda yoki
 * provisioning xato bilan tugaganda chaqiriladi — aks holda o'chirilgan
 * schema'ga ochiq ulanish qolib ketardi.
 *
 * @param {string} schemaName
 */
async function evictSchema(schemaName) {
  const base = baseClients.get(schemaName);
  clients.delete(schemaName);
  baseClients.delete(schemaName);
  poolSizes.delete(schemaName);
  if (base) {
    await base.$disconnect().catch(() => {});
  }

  // Bitta filial ketdi — qolganlarga ko'proq ulush tegadi.
  rebalance();
}

/**
 * Barcha filial ulanishlarini yopadi (graceful shutdown).
 */
async function disconnectAll() {
  const all = [...baseClients.values()];
  clients.clear();
  baseClients.clear();
  poolSizes.clear();
  await Promise.all(all.map((c) => c.$disconnect().catch(() => {})));
}

/** Hozir ochiq bo'lgan schema nomlari — diagnostika uchun. */
function openSchemas() {
  return [...clients.keys()];
}

/**
 * Ulanish hisobi — diagnostika uchun: qaysi schema qancha ulanish olgan va
 * jami budjetga sig'adimi.
 */
function poolStats() {
  const branches = Object.fromEntries(poolSizes);
  const branchTotal = Object.values(branches).reduce((sum, n) => sum + n, 0);

  return {
    branches,
    branchTotal,
    platform: config.platformConnectionLimit,
    total: branchTotal + config.platformConnectionLimit,
    budget: config.dbConnectionBudget,
  };
}

module.exports = {
  getClientForSchema,
  getClientForBranch,
  evictSchema,
  disconnectAll,
  openSchemas,
  poolStats,
};
