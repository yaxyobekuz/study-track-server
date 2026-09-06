/**
 * XAVFSIZLIK SUPURGISI — kechasi 03:40.
 *
 * Uch ish qiladi va uchalasi ham FAQAT TARTIBGA SOLADI, hech kimni
 * bloklamaydi (`security.service.js` doktrinasi: qayd etadi, to'xtatmaydi):
 *
 *   1. MUDDATI O'TGAN SEANSLARNI YOPADI. Token 30 kun amal qiladi va
 *      hech kim uni "yopmaydi" — qator `active` bo'lib qolaveradi. Bu
 *      raqamni buzardi: "hozir 400 ta ochiq seans" degan yozuv aslida
 *      "oxirgi 30 kunda 400 marta kirilgan" degani bo'lardi.
 *
 *      ⚠️ O'CHIRMAYDI, YOPADI. Seans tarixi — xavfsizlik tarixi: "bu
 *      odam o'sha kuni qaysi qurilmadan kirgan edi" degan savolga javob
 *      faqat qator saqlangandagina bo'ladi.
 *
 *   2. ESKI OGOHLANTIRISHLARNI YOPADI. 30 kundan beri ochiq turgan
 *      ogohlantirish — bu "hech kim qaramadi" degani va ro'yxatni
 *      ko'mib tashlaydi. `resolved` emas, `acknowledged`: "tizim yopdi"
 *      bilan "odam ko'rdi" ni ajratib turish kerak.
 *
 *   3. ESKI KIRISH URINISHLARINI TOZALAYDI (180 kundan eskisi). Bu
 *      jadval eng tez o'sadigan jadval: har login, har xato, har
 *      429. Xavfsizlik tahlili uchun yarim yil yetarli, undan eskisi
 *      esa faqat joy egallaydi.
 *
 * ⚠️ FILIAL BO'YICHA AYLANMAYDI (`branchCron` YO'Q). Xavfsizlik
 * jadvallari PLATFORMADA — bitta o'tish hammasini qamrab oladi. Filial
 * bo'yicha aylansak, har filialda BIR XIL qatorlarni qayta-qayta
 * yangilagan bo'lardik.
 */

const cron = require("node-cron");
const platformPrisma = require("../config/platformPrisma");
const securityService = require("../services/security.service");
const logger = require("../utils/logger");

/** Ochiq ogohlantirish shuncha kundan keyin avtomatik yopiladi. */
const ALERT_STALE_DAYS = 30;

/** Kirish urinishlari shuncha kundan keyin o'chiriladi. */
const ATTEMPT_RETENTION_DAYS = 180;

/**
 * Bitta supurish passi.
 *
 * @returns {Promise<{expired: number, staleAlerts: number, purged: number}>}
 */
async function runSecuritySweep() {
  const now = Date.now();

  // ── 1. Muddati o'tgan seanslar ────────────────────────────────────
  const expired = await securityService.expireStaleSessions();

  // ── 2. Uzoq ochiq turgan ogohlantirishlar ─────────────────────────
  const staleBefore = new Date(now - ALERT_STALE_DAYS * 24 * 3600 * 1000);
  const { count: staleAlerts } = await platformPrisma.securityAlert.updateMany({
    where: { status: "open", lastSeenAt: { lt: staleBefore } },
    data: { status: "acknowledged", acknowledgedAt: new Date() },
  });

  // ── 3. Eski urinishlarni tozalash ─────────────────────────────────
  const purgeBefore = new Date(now - ATTEMPT_RETENTION_DAYS * 24 * 3600 * 1000);
  const { count: purged } = await platformPrisma.loginAttempt.deleteMany({
    where: { createdAt: { lt: purgeBefore } },
  });

  if (expired || staleAlerts || purged) {
    logger.info(
      `[SecuritySweep] ${expired} ta seans yopildi, ` +
        `${staleAlerts} ta ogohlantirish avtomatik belgilandi, ` +
        `${purged} ta eski urinish tozalandi`,
    );
  }

  return { expired, staleAlerts, purged };
}

/** Cron jobni belgilaydi. Har kuni 03:40 (Asia/Tashkent). */
function startSecuritySweepCron() {
  cron.schedule(
    "40 3 * * *",
    async () => {
      try {
        await runSecuritySweep();
      } catch (error) {
        logger.error("[SecuritySweep] cron xatosi", error);
      }
    },
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  logger.info(
    "Xavfsizlik supurgisi cron job belgilandi: Har kuni 03:40 (Asia/Tashkent)",
  );
}

module.exports = { startSecuritySweepCron, runSecuritySweep };
