/**
 * PLATFORMA client'i — filiallardan yuqoridagi qatlam.
 *
 * Qaysi ma'lumot shu client orqali o'qiladi:
 *   - `Branch`            — filiallar reyestri
 *   - `UserDirectory`     — username → filial (login yo'naltirgichi)
 *   - `TelegramDirectory` — telegramId → filial (bot uchun)
 *   - `Role`              — rollar va boshlang'ich ruxsatlar (UMUMIY)
 *   - `Tariff` / `TariffVersion` / `Discount` — narx katalogi (UMUMIY)
 *   - `Changelog*`        — o'zgarishlar tarixi (UMUMIY)
 *
 * Filial ma'lumoti uchun `config/prisma.js` ishlatiladi — u joriy filialga
 * qarab client tanlaydi. Ikkalasini ARALASHTIRMANG: platformada `user`
 * modeli yo'q, filialda esa `branch` modeli yo'q, shuning uchun xato
 * "undefined is not a function" bo'lib darhol chiqadi.
 *
 * ⚠️ DECIMAL: bu client o'z runtime nusxasini olib yuradi. Filial client'idan
 * kelgan `Prisma.Decimal` bu yerga (va aksincha) YOZILMAYDI — summa
 * `helpers/money.helpers.js` dagi `formatAmount()` bilan STRING'ga
 * aylantirilib beriladi.
 *
 * ⚠️ POOL SHU YERDA CHEKLANADI. Bu client `buildSchemaUrl` dan O'TMAYDI
 * (ulanish satri `PLATFORM_DATABASE_URL` dan to'g'ridan-to'g'ri keladi),
 * ya'ni filial client'lariga qo'yilgan `connection_limit` unga tegmaydi va
 * Prisma standartiga (CPU×2+1) tushib qolardi: 16 yadroli mashinada 33 ta
 * ulanish, ustiga 6 filial × 5 = 30 → `max_connections = 100` ga pgAdmin va
 * ikkinchi dev nusxasi bilan birga sig'masdi ("remaining connection slots
 * are reserved for roles with the SUPERUSER attribute"). Platforma faqat
 * kataloglarni o'qiydi — pool filialdagidek kichik bo'lishi yetarli.
 */

const { PrismaClient, Prisma } = require("../generated/platform");
const { config } = require("./env.config");
const { buildAutoIdExtension } = require("./prismaExtensions");

/**
 * Ulanish satriga `connection_limit` qo'yadi (allaqachon aniq ko'rsatilgan
 * bo'lsa — TEGMAYDI: `PLATFORM_DATABASE_URL` da qo'lda berilgan qiymat
 * ustun turadi).
 */
const withPoolLimit = (url, limit) => {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("connection_limit")) {
      parsed.searchParams.set("connection_limit", String(limit));
    }
    if (!parsed.searchParams.has("pool_timeout")) {
      parsed.searchParams.set("pool_timeout", String(config.dbPoolTimeout));
    }
    return parsed.toString();
  } catch {
    return url; // noto'g'ri URL — validateEnv baribir xato beradi
  }
};

const basePlatformPrisma = new PrismaClient({
  datasourceUrl: withPoolLimit(config.platformDatabaseUrl, config.platformConnectionLimit),
  log: config.isDevelopment ? ["warn", "error"] : ["error"],
});

const platformPrisma = basePlatformPrisma.$extends(buildAutoIdExtension(Prisma));

// `$disconnect` kengaytirilgan obyektda ham bor, lekin graceful shutdown
// asosiy client'ni yopishi kerakligi aniq ko'rinib tursin.
platformPrisma.$disconnectBase = () => basePlatformPrisma.$disconnect();

module.exports = platformPrisma;
