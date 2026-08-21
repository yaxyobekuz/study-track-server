/**
 * JORIY FILIAL KONTEKSTI — butun filiallashtirishning o'zagi.
 *
 * `AsyncLocalStorage` so'rov (yoki cron passi) boshida filialni "yoqadi" va u
 * shu zanjirdagi BARCHA async chaqiruvlarga o'zi tarqaladi. Shu sababli
 * `config/prisma.js` har chaqiruvda qaysi filial bazasiga borishni biladi va
 * 79 ta service faylining birortasida `branchId` filtri yozilmaydi.
 *
 * NIMA UCHUN parametr sifatida uzatilmaydi: filialni har service funksiyasiga
 * argument qilib berish 1000+ chaqiruv joyini o'zgartirishni va — eng
 * yomoni — bitta joyda UNUTIB QOLDIRISH imkoniyatini anglatardi. Unutilgan
 * filtr esa "boshqa filial ma'lumoti ko'rinib qoldi" degan jim buzilish.
 *
 * Kontekst quyidagilar bo'ylab tarqaladi: `await`, `.then/.catch`,
 * `setTimeout`, `setImmediate`, Express middleware zanjiri. Tarqalmaydigan
 * yagona holat — kontekstdan TASHQARIDA yaratilgan singletonlar (masalan
 * `messageQueue.service.js` dagi navbat ishlovchisi), shuning uchun ular
 * `runWithBranch` bilan ATAYLAB o'raladi.
 */

const { AsyncLocalStorage } = require("node:async_hooks");
const { InternalServerError } = require("../utils/errors");

const storage = new AsyncLocalStorage();

/**
 * Berilgan filial kontekstida funksiyani bajaradi.
 *
 * @template T
 * @param {{id: string, code: string, name: string, schemaName: string}} branch
 * @param {() => T} fn
 * @returns {T}
 */
function runWithBranch(branch, fn) {
  if (!branch || !branch.id || !branch.schemaName) {
    throw new InternalServerError("Filial konteksti noto'g'ri");
  }
  return storage.run({ branch }, fn);
}

/**
 * Joriy filial yoki `null` (kontekstdan tashqarida — masalan bootstrap).
 * @returns {object|null}
 */
function getBranch() {
  return storage.getStore()?.branch ?? null;
}

/**
 * Joriy filial; bo'lmasa xato. `config/prisma.js` shuni ishlatadi, ya'ni
 * kontekstsiz bazaga murojaat qilish JIM emas, BALAND xato beradi.
 *
 * @returns {object}
 */
function requireBranch() {
  const branch = getBranch();
  if (!branch) {
    throw new InternalServerError(
      "Filial konteksti yo'q: bazaga murojaat `runWithBranch()` ichida bo'lishi kerak " +
        "(cron uchun helpers/branchIterator.js, so'rov uchun middleware/branch.middleware.js)",
    );
  }
  return branch;
}

/**
 * Filialsiz (platforma darajasidagi) ish uchun kontekstni tozalaydi.
 * Masalan: bir filial ichidan platforma reyestriga yozadigan kod
 * xatolik bilan filial client'ini olib qo'ymasligi kerak.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function runWithoutBranch(fn) {
  return storage.run({ branch: null }, fn);
}

module.exports = { runWithBranch, runWithoutBranch, getBranch, requireBranch };
