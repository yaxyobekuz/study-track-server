/**
 * FILIAL client'i — joriy filial kontekstiga qarab tanlanadigan PrismaClient.
 *
 * Bu modul **79 ta faylda** `require("../config/prisma")` bilan olinadi.
 * Filiallashtirishda import yo'li ATAYLAB o'zgartirilmadi: shu bitta fayl
 * Proxy'ga aylantirilgani uchun 79 fayl va ulardagi 1000+ so'rov joyi
 * tegilmasdan qoldi.
 *
 * ISHLASH TARTIBI:
 *
 *   so'rov keladi
 *     → middleware/branch.middleware.js filialni aniqlaydi
 *     → runWithBranch(branch, next)          [config/branchContext.js]
 *     → service `prisma.user.findMany()` deydi
 *     → shu Proxy AsyncLocalStorage'dan filialni oladi
 *     → branchRegistry o'sha schema'ning client'ini qaytaradi
 *
 * Natijada `prisma.user.findMany()` HECH QACHON boshqa filialning ma'lumotini
 * qaytara olmaydi: ajratish so'rov shartida emas, ULANISH darajasida.
 *
 * ⚠️ Kontekstdan tashqarida (bootstrap, migratsiya skriptlari, cron passining
 * o'zi) bu Proxy'ga murojaat qilish XATO beradi — `requireBranch()` jim
 * qolmaydi. Cron uchun `helpers/branchIterator.js`, bir martalik skriptlar
 * uchun `branchRegistry.getClientForSchema()` ishlatiladi.
 *
 * Platforma ma'lumoti (rollar, tariflar, chegirmalar, filiallar reyestri,
 * o'zgarishlar tarixi) uchun — `config/platformPrisma.js`.
 */

const { requireBranch } = require("./branchContext");
const { getClientForBranch } = require("./branchRegistry");

/** Joriy filialning client'i. */
function currentClient() {
  return getClientForBranch(requireBranch());
}

// Proxy target — bo'sh funksiya EMAS, bo'sh obyekt: `prisma` hech qachon
// chaqirilmaydi, faqat maydonlari o'qiladi (`prisma.user`, `prisma.$transaction`).
const prisma = new Proxy(
  {},
  {
    get(_target, prop, receiver) {
      // `require()` va util.inspect bularni so'raydi — client'ni bekorga
      // yaratmaslik (va kontekstsiz joyda xato bermaslik) uchun oldindan rad etamiz.
      if (prop === "then" || prop === Symbol.toStringTag) return undefined;

      const client = currentClient();
      const value = Reflect.get(client, prop, receiver === prisma ? client : receiver);

      // `$transaction`, `$queryRaw`, `$executeRawUnsafe` — hammasi client'ga
      // bog'langan bo'lishi shart, aks holda ichkarida `this` yo'qoladi.
      return typeof value === "function" ? value.bind(client) : value;
    },

    has(_target, prop) {
      return Reflect.has(currentClient(), prop);
    },

    ownKeys() {
      return Reflect.ownKeys(currentClient());
    },

    getOwnPropertyDescriptor(_target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(currentClient(), prop);
      // Proxy invariant: mavjud bo'lmagan target uchun descriptor `configurable`
      // bo'lishi shart.
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  },
);

module.exports = prisma;
