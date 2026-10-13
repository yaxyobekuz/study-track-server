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
 * `mapBranches` bir vaqtda nechta filialni ochishi mumkin.
 *
 * Har filial o'z client'i va o'z pool'i bilan keladi, ya'ni bu son — bitta
 * so'rov baza ulanishlarini necha barobar ko'paytirishi. Cheklanmasa filial
 * qo'shilishi jim ravishda ulanish talabini oshirib boradi.
 */
const MAX_PARALLEL_BRANCHES = 4;

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
 * ⚠️ PARALLELLIK CHEKLANGAN (`MAX_PARALLEL_BRANCHES`). Oldin bu funksiya
 * `Promise.all` bilan HAMMA filialni bir vaqtda ishga tushirardi: har filial
 * o'z client'ini ochib, o'z pool'ini band qilgani uchun bitta admin so'rovi
 * (masalan rollar ro'yxati) filiallar soniga ko'paygan ulanish talab qilardi.
 * Shunday ikki-uch so'rov ustma-ust kelsa rol bo'yicha cheklov tugab,
 * "too many connections for role" chiqardi.
 *
 * @param {(branch: object) => Promise<any>} fn
 * @param {{branches?: object[], label?: string}} [options]
 * @returns {Promise<Array<{branch: object, value?: any, error?: Error}>>}
 */
async function mapBranches(fn, options = {}) {
  const { label = "[Branch]" } = options;
  const branches = options.branches ?? (await branchService.listOperational());

  const results = new Array(branches.length);
  let cursor = 0;

  // Navbat: har "ishchi" ro'yxatdan keyingi filialni olib ketadi, shuning
  // uchun sekin filial o'zidan keyingilarini bloklamaydi (bo'lak-bo'lak
  // bajarishning kamchiligi aynan shu edi).
  const worker = async () => {
    while (cursor < branches.length) {
      const index = cursor++;
      const branch = branches[index];
      try {
        results[index] = {
          branch,
          value: await runWithBranch(branch, () => fn(branch)),
        };
      } catch (error) {
        logger.error(`${label} "${branch.name}" filialida xato: ${error.message}`);
        results[index] = { branch, error };
      }
    }
  };

  const workers = Math.min(MAX_PARALLEL_BRANCHES, branches.length);
  await Promise.all(Array.from({ length: workers }, worker));

  return results;
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
