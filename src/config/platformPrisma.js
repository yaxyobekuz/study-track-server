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
 */

const { PrismaClient, Prisma } = require("../generated/platform");
const { config } = require("./env.config");
const { buildAutoIdExtension } = require("./prismaExtensions");

const basePlatformPrisma = new PrismaClient({
  datasourceUrl: config.platformDatabaseUrl,
  log: config.isDevelopment ? ["warn", "error"] : ["error"],
});

const platformPrisma = basePlatformPrisma.$extends(buildAutoIdExtension(Prisma));

// `$disconnect` kengaytirilgan obyektda ham bor, lekin graceful shutdown
// asosiy client'ni yopishi kerakligi aniq ko'rinib tursin.
platformPrisma.$disconnectBase = () => basePlatformPrisma.$disconnect();

module.exports = platformPrisma;
