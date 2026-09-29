/**
 * QURILMA NAZORATI — KECHKI SUPURGI (03:40, Asia/Tashkent).
 *
 * Uchta ish qiladi va uchalasi ham FAQAT TOZALAYDI — hech biri chekovni
 * o'zgartirmaydi:
 *
 *   1. Muddati o'tgan vaqtinchalik ochishlarni `expired` qiladi.
 *      ⚠️ Bu FAQAT RO'YXAT UCHUN: hisob-kitob baribir `endsAt` ga qaraydi
 *      (`activeUnlocks`), ya'ni job ishlamay qolsa ham ochish o'z
 *      vaqtida tugaydi va telefon ochiq qolib ketmaydi.
 *   2. Muddati o'tgan biriktirish kodlarini bekor qiladi.
 *      ⚠️ Kod baribir `expiresAt` bo'yicha rad etiladi (`enroll`) —
 *      bu ham ro'yxat gigiyenasi.
 *   3. `usageRetentionDays` dan eski foydalanish qatorlarini O'CHIRADI.
 *      ⚠️ BU ESA HAQIQIY MAJBURIYAT, gigiyena emas: bolaning ekran
 *      vaqtini cheksiz saqlash asossiz ma'lumot to'plash bo'lardi
 *      (`devices.md` §8).
 *
 * ⚠️ 03:40 — moliya (03:00) va inventar (03:20) tekshiruvlaridan KEYIN,
 * hisob-faktura/oylik passidan (06:00) OLDIN: kechasi bir vaqtda ishlagan
 * og'ir joblar bir-birining ulanishlarini yeb qo'ymasligi uchun.
 *
 * ⚠️ Job HECH QACHON jarayonni yiqitmaydi (`CLAUDE.md` qoidasi) — har
 * filial o'z `try/catch` ida.
 */

const cron = require("node-cron");

const prisma = require("../config/prisma");
const { branchCron } = require("../helpers/branchIterator");
const { getBranch } = require("../config/branchContext");
const logger = require("../utils/logger");
const { getDeviceSettings } = require("../services/settings.service");
const deviceUnlockService = require("../services/deviceUnlock.service");
const { tashkentDayDate } = require("../helpers/devicePolicy.helpers");

/**
 * Bitta filial uchun supurgi passi.
 * @returns {Promise<{expiredUnlocks:number, revokedCodes:number, prunedUsage:number}>}
 */
async function runDeviceSweepPass() {
  const branch = getBranch();
  const tag = `[DeviceSweep] ${branch ? branch.name : "?"}`;

  const settings = await getDeviceSettings();

  // 1) Muddati o'tgan ochishlar
  const { expired } = await deviceUnlockService.expireOverdue();

  // 2) Muddati o'tgan, ishlatilmagan kodlar
  const { count: revokedCodes } = await prisma.deviceEnrollmentCode.updateMany({
    where: { usedAt: null, revokedAt: null, expiresAt: { lte: new Date() } },
    data: { revokedAt: new Date() },
  });

  // 3) Saqlash muddatidan eski hisobot qatorlari
  //
  // ⚠️ Chegara KUN aniqligida hisoblanadi (`@db.Date` — faqat `getUTC*`):
  // instant bilan taqqoslansa, chegaradagi kun taymzonaga qarab bir kunga
  // siljib ketardi (`dates.md` §4).
  const retentionDays = Math.max(7, settings.usageRetentionDays || 180);
  const cutoff = new Date(tashkentDayDate(new Date()).getTime() - retentionDays * 86400000);

  const { count: prunedUsage } = await prisma.deviceUsageDay.deleteMany({
    where: { day: { lt: cutoff } },
  });

  if (expired || revokedCodes || prunedUsage) {
    logger.info(
      `${tag} ${expired} ta ochish yopildi, ${revokedCodes} ta kod bekor qilindi, ` +
        `${prunedUsage} ta eski hisobot qatori o'chirildi (saqlash: ${retentionDays} kun)`,
    );
  }

  return { expiredUnlocks: expired, revokedCodes, prunedUsage };
}

/** Cron jobni belgilaydi. Har kuni 03:40 (Asia/Tashkent). */
function startDeviceSweepCron() {
  cron.schedule(
    "40 3 * * *",
    branchCron("[DeviceSweepCron]", async (branch) => {
      try {
        await runDeviceSweepPass();
      } catch (error) {
        logger.error(`[DeviceSweep] ${branch.name}: cron xatosi`, error);
      }
    }),
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  logger.info("Qurilma nazorati supurgi cron job belgilandi: Har kuni 03:40 (Asia/Tashkent)");
}

module.exports = { startDeviceSweepCron, runDeviceSweepPass };
