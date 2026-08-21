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
 * Kesh kaliti — `id` emas, `schemaName`: filial qatori qayta o'qilganda ham,
 * migratsiya skriptidan chaqirilganda ham (u yerda `Branch` qatori bo'lmasligi
 * mumkin) bir xil client qaytadi.
 */

const { PrismaClient, Prisma } = require("../generated/prisma");
const { config } = require("./env.config");
const { buildSchemaUrl } = require("../helpers/schemaUrl.helpers");
const {
  buildAutoIdExtension,
  virtualsExtension,
} = require("./prismaExtensions");

// schemaName -> extended PrismaClient
const clients = new Map();

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

  const url = buildSchemaUrl(config.databaseUrl, schemaName, {
    connectionLimit: config.branchConnectionLimit,
  });

  const base = new PrismaClient({
    datasourceUrl: url,
    log: config.isDevelopment ? ["warn", "error"] : ["error"],
  });

  const client = base
    .$extends(buildAutoIdExtension(Prisma))
    .$extends(virtualsExtension);

  baseClients.set(schemaName, base);
  clients.set(schemaName, client);
  return client;
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
  if (base) {
    await base.$disconnect().catch(() => {});
  }
}

/**
 * Barcha filial ulanishlarini yopadi (graceful shutdown).
 */
async function disconnectAll() {
  const all = [...baseClients.values()];
  clients.clear();
  baseClients.clear();
  await Promise.all(all.map((c) => c.$disconnect().catch(() => {})));
}

/** Hozir ochiq bo'lgan schema nomlari — diagnostika uchun. */
function openSchemas() {
  return [...clients.keys()];
}

module.exports = {
  getClientForSchema,
  getClientForBranch,
  evictSchema,
  disconnectAll,
  openSchemas,
};
