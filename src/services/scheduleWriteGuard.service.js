/**
 * AMALDAGI DARS JADVALIGA YOZISH — QULF VA REJIM TEKSHIRUVI.
 *
 * Amaldagi jadvalga (`schedules` / `schedule_lessons`) yozadigan HAR BIR yo'l
 * shu yerdan o'tadi:
 *   · platformadagi tahrir (sinf haftasi, bitta kun, o'chirish);
 *   · Google Sheets o'zgarishini qo'llash;
 *   · manbani almashtirish va versiyani tiklash.
 * Sheet tahrirlari, sozlama va moslash qoidalariga yozuv ham shu qulf
 * ostida: ular "qaysi tahrir eng oxirgisi" va "nima qo'llanadi" degan
 * savolga ta'sir qiladi.
 *
 * ⚠️ Kelajakdagi har qanday yangi yozuvchi (masalan rejalashtiruvchi
 * natijasini jadvalga "e'lon qilish") ham `withScheduleWriteLock` +
 * `assertPlatformMode` dan o'tishi SHART — aks holda sheet rejimida jadval
 * aralashib ketadi.
 *
 * ── NIMA UCHUN QULF ──────────────────────────
 *
 * Tekshiruv ("o'qituvchi band emasmi", "rejim platformami") va yozuv bitta
 * tranzaksiyada bo'lmasa, ikki parallel so'rov ikkalasi ham tekshiruvdan
 * o'tib, jadvalni aralashtirib yuborardi. Masalan: admin sinf jadvalini
 * saqlayotgan paytda boshqa odam sheet rejimiga o'tadi — tekshiruvda rejim
 * hali "platform", yozuv esa sheet'dan kelgan jadval ustiga tushadi.
 *
 * Shuning uchun har yozuv tranzaksiyasining BIRINCHI amali — filial bo'yicha
 * `pg_advisory_xact_lock`. Qulf tranzaksiya tugaganda o'zi bo'shaydi; keyingi
 * yozuv avvalgisi tugashini kutadi va tekshiruvni ALLAQACHON yozilgan holat
 * ustida qiladi.
 *
 * ⚠️ Kalitda schema nomi bor (JS tomonda, `requireBranch()` dan): advisory
 * lock butun bazaga umumiy, filiallar esa bitta bazada. SQL'dagi
 * `current_schema()` NULL bo'lsa `hashtext(NULL)` → qulf umuman olinmasdi.
 *
 * ⚠️ `$executeRaw`, `$queryRaw` EMAS: `pg_advisory_xact_lock` `void`
 * qaytaradi va Prisma `$queryRaw` uni o'qiy olmay yiqiladi ("Failed to
 * deserialize column of type 'void'") — local bazada tekshirilgan.
 *
 * ⚠️ Tranzaksiya ichida FAQAT `tx` ishlatiladi. Global `prisma` boshqa
 * ulanishni oladi: filialga 5 ta ulanish, qulf kutayotganlar ham ulanish
 * ushlab turadi — ichkaridan global so'rov hovuzni to'ldirib, hammasini
 * osiltirib qo'yishi mumkin.
 */

const prisma = require("../config/prisma");
const { requireBranch } = require("../config/branchContext");
const { ConflictError } = require("../utils/errors");

const WRITE_LOCK_PREFIX = "study-track:schedule-write:";
const SINGLETON = "singleton";

// Qulfni kutish ham tranzaksiya vaqtiga kiradi: butun maktab jadvalini
// qo'llash bir necha soniya olishi mumkin, uning ortidan kelgan oddiy sinf
// saqlash 5 soniyalik (Prisma sukuti) chegarada yiqilmasligi kerak.
const WRITE_TX_OPTIONS = { timeout: 60000, maxWait: 15000 };

// Qulfni cheksiz kutmaslik: 20 soniyada olinmasa "band" deb qaytadi.
const LOCK_TIMEOUT = "20s";

const MODES = { PLATFORM: "platform", SHEET: "sheet" };

const SHEET_MODE_MESSAGE =
  "Dars jadvali Google Sheets orqali boshqarilmoqda. Platformada tahrirlash o'chirilgan — o'zgartirishni sheet'da qiling va tasdiqlang";

const BUSY_MESSAGE =
  "Dars jadvali hozir boshqa amal bilan yangilanmoqda. Birozdan so'ng qayta urinib ko'ring";

/**
 * Tranzaksiya ichida filial bo'yicha yozuv qulfini oladi.
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 */
async function lockScheduleWrites(tx) {
  const { schemaName } = requireBranch();
  if (!schemaName) throw new Error("Filial schema nomi yo'q — qulf olinmaydi");

  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${WRITE_LOCK_PREFIX + schemaName}))`;
}

/**
 * Rejimni o'qiydi. Qator hali yo'q bo'lsa — `platform` (sukut bo'yicha
 * qiymat; getter uni keyin yaratadi).
 *
 * Tranzaksiya ichida `tx` ni ANIQ uzating; argumentsiz chaqiruv faqat
 * tranzaksiyadan tashqarida (masalan qoralama saqlash, GET /mode).
 *
 * @param {object} [client] - `prisma` yoki tranzaksiya (`tx`)
 * @returns {Promise<"platform"|"sheet">}
 */
async function readSourceMode(client = prisma) {
  const settings = await client.scheduleSyncSettings.findUnique({
    where: { id: SINGLETON },
    select: { mode: true },
  });
  return settings?.mode || MODES.PLATFORM;
}

/**
 * Sheet rejimidagi platforma tahriri uchun xato. 409: so'rovda xato yo'q,
 * jadvalning HOLATI tahrirga yo'l qo'ymaydi.
 * @returns {ConflictError}
 */
function sheetModeError() {
  return new ConflictError(SHEET_MODE_MESSAGE, { reason: "sheet_mode" });
}

/**
 * Platforma rejimini talab qiladi (tranzaksiya ichida, qulfdan keyin).
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 */
async function assertPlatformMode(tx) {
  if ((await readSourceMode(tx)) === MODES.SHEET) throw sheetModeError();
}

/**
 * Qulfni kutish tugagani yoki tranzaksiya vaqti o'tgani — "band", 500 emas.
 * @param {Error} error
 * @returns {boolean}
 */
function isBusyError(error) {
  if (!error || typeof error !== "object") return false;
  if (error.code === "P2010" && error.meta?.code === "55P03") return true; // lock_timeout
  if (error.code === "P2028") return true; // tranzaksiya vaqti o'tdi / yopildi
  if (error.code === "P2034") return true; // yozuv to'qnashuvi / deadlock
  return false;
}

/**
 * Qulf bilan yozuv tranzaksiyasi.
 * @template T
 * @param {(tx: import("@prisma/client").Prisma.TransactionClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withScheduleWriteLock(fn) {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockScheduleWrites(tx);
      return fn(tx);
    }, WRITE_TX_OPTIONS);
  } catch (error) {
    if (isBusyError(error)) throw new ConflictError(BUSY_MESSAGE, { reason: "busy" });
    throw error;
  }
}

module.exports = {
  MODES,
  SHEET_MODE_MESSAGE,
  lockScheduleWrites,
  readSourceMode,
  sheetModeError,
  assertPlatformMode,
  withScheduleWriteLock,
};
