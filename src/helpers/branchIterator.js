/**
 * FILIALLAR BO'YLAB AYLANISH — cron joblar, yig'ma hisobot va monitor uchun.
 *
 * So'rov kontekstida filial `auth.middleware` tomonidan yoqiladi. Cron esa
 * so'rovsiz ishlaydi, ya'ni filialni O'ZI tanlashi kerak: har bir job endi
 * "butun maktab uchun bir marta" emas, "har filial uchun bir martadan"
 * bajariladi.
 *
 * XATOGA MUNOSABAT — mavjud `invoiceGeneration.job.js` uslubi: bitta
 * filialdagi xato qolganlarini TO'XTATMAYDI, faqat log'ga tushadi va
 * natijaga `error` bo'lib qaytadi. Aks holda alifbo bo'yicha birinchi
 * filialdagi buzuq ma'lumot butun tunni "hech narsa ishlamadi" ga aylantirardi.
 */

const { runWithBranch } = require("../config/branchContext");
const branchService = require("../services/branch.service");
const logger = require("../utils/logger");

/**
 * Har bir ishlaydigan filialda KETMA-KET bajaradi.
 *
 * Ketma-ket, chunki cron joblar bazani og'ir yuklaydi (davomat, hisob-faktura)
 * va o'nta filialni bir vaqtda ishga tushirish pool'ni to'ldirardi.
 *
 * @param {(branch: object) => Promise<any>} fn
 * @param {{label?: string}} [options] - log prefiksi ("[InvoiceCron]")
 * @returns {Promise<Array<{branch: object, value?: any, error?: Error}>>}
 */
async function forEachBranch(fn, options = {}) {
  const { label = "[Branch]" } = options;
  const branches = await branchService.listOperational();

  if (branches.length === 0) {
    logger.warn(`${label} Ishlaydigan filial yo'q — o'tkazib yuborildi`);
    return [];
  }

  const results = [];

  for (const branch of branches) {
    try {
      const value = await runWithBranch(branch, () => fn(branch));
      results.push({ branch, value });
    } catch (error) {
      logger.error(`${label} "${branch.name}" filialida xato: ${error.message}`);
      results.push({ branch, error });
    }
  }

  return results;
}

/**
 * Har bir filialda PARALLEL bajaradi va natijalarni yig'adi.
 *
 * Faqat O'QISH uchun: yig'ma dashboard o'nta filialni ketma-ket kutib
 * o'tirmasligi kerak. Yozadigan ish uchun `forEachBranch` ishlatiladi.
 *
 * @param {(branch: object) => Promise<any>} fn
 * @param {{branches?: object[], label?: string}} [options]
 * @returns {Promise<Array<{branch: object, value?: any, error?: Error}>>}
 */
async function mapBranches(fn, options = {}) {
  const { label = "[Branch]" } = options;
  const branches = options.branches ?? (await branchService.listOperational());

  return Promise.all(
    branches.map(async (branch) => {
      try {
        return { branch, value: await runWithBranch(branch, () => fn(branch)) };
      } catch (error) {
        logger.error(`${label} "${branch.name}" filialida xato: ${error.message}`);
        return { branch, error };
      }
    }),
  );
}

/**
 * Filiallar bo'ylab qidiradi va BIRINCHI topilgan natijani qaytaradi.
 *
 * Monitor kodi kabi "qaysi filialdaligi noma'lum, lekin global yagona"
 * qiymatlar uchun. Parallel: filiallar soni o'nlab, ketma-ket qidirish
 * shunchaki sekin bo'lardi.
 *
 * @param {(branch: object) => Promise<any>} fn - topilmasa `null` qaytaradi
 * @returns {Promise<{branch: object, value: any}|null>}
 */
async function findInBranches(fn) {
  const results = await mapBranches(fn, { label: "[BranchSearch]" });
  const hit = results.find((r) => r.value != null && !r.error);
  return hit ? { branch: hit.branch, value: hit.value } : null;
}

/**
 * Cron handler'ini filiallar bo'ylab o'raydi.
 *
 * `cron.schedule("0 6 * * *", branchCron("[InvoiceCron]", async () => {...}))`
 *
 * Bu shunchaki qisqartma emas, MAJBURIY qadam: `config/prisma.js` filial
 * kontekstisiz xato beradi, ya'ni o'ralmagan job birinchi so'rovdayoq
 * yiqiladi. Shu sababli unutib qoldirish jim buzilishga OLIB KELMAYDI.
 *
 * @param {string} label - log prefiksi
 * @param {(branch: object) => Promise<any>} fn
 * @returns {() => Promise<void>}
 */
function branchCron(label, fn) {
  return async () => {
    await forEachBranch(fn, { label });
  };
}

module.exports = { forEachBranch, mapBranches, findInBranches, branchCron };
