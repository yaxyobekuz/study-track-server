/**
 * SINF GURUHLARI — KECHKI SINXRON (03:30, Asia/Tashkent).
 *
 * ⚠️ NIMA UCHUN KERAK, hodisadan keyingi sinxron bo'lsa ham: hodisa
 * o'tkazib yuborilishi mumkin (server qayta ishga tushdi, debounce
 * taymeri jarayon yopilishida yo'qoldi, yangi yo'l `requestSync` ni
 * chaqirishni unutdi). Bunday xato HECH QANDAY XATO BERMAYDI — guruh
 * jimgina noto'g'ri bo'lib qoladi va buni hech kim sezmaydi. Kechki
 * to'liq solishtirish esa o'zini O'ZI tuzatadi.
 *
 * ⚠️ `branchCron` MAJBURIY: a'zolar FILIAL ma'lumotidan o'qiladi
 * (`UserClass`, `ScheduleLesson`, `ClassLeader`, `TutorGroup`), suhbat
 * esa platformada. Kontekstsiz birinchi so'rov "Filial konteksti yo'q"
 * xatosi bilan yiqilardi (root `CLAUDE.md`).
 *
 * ⚠️ 03:30 — moliya (03:00) va inventar (03:20) tekshiruvlaridan KEYIN,
 * qurilma supurgisi (03:40) dan OLDIN: kechasi og'ir joblar bir-birining
 * ulanishlarini yeb qo'ymasligi uchun.
 */

const cron = require("node-cron");

const { branchCron } = require("../helpers/branchIterator");
const classChatService = require("../services/classChat.service");
const logger = require("../utils/logger");

/** Cron jobni belgilaydi. Har kuni 03:30 (Asia/Tashkent). */
function startClassChatSyncCron() {
  cron.schedule(
    "30 3 * * *",
    branchCron("[ClassChatSyncCron]", async (branch) => {
      try {
        const result = await classChatService.syncAllInBranch();
        if (result.added || result.removed || result.roleChanged || result.failed) {
          logger.info(
            `[ClassChatSync] ${branch.name}: ${result.classes} sinf — ` +
              `+${result.added} / -${result.removed} / rol ${result.roleChanged}` +
              (result.failed ? ` / xato ${result.failed}` : ""),
          );
        }
      } catch (error) {
        logger.error(`[ClassChatSync] ${branch.name}: cron xatosi`, error);
      }
    }),
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  logger.info("Sinf guruhlari sinxroni cron job belgilandi: Har kuni 03:30 (Asia/Tashkent)");
}

module.exports = { startClassChatSyncCron };
