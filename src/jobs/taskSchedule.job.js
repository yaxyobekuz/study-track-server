/**
 * DOIMIY TOPSHIRIQLAR PASSI (05:20, Asia/Tashkent + startup).
 *
 * Har bir faol qoida bo'yicha (`task_schedules`) oldinga qarab topshiriq
 * yozadi: hodisadan `leadDays` (sukut 1 kun) OLDIN. Yaratilishning o'zi
 * xodim uchun eslatma — topshiriq ro'yxatida paydo bo'ladi va push ketadi.
 *
 * ⚠️ 05:20 — moliya (03:00) va qurilma (03:40) tekshiruvlaridan KEYIN,
 * topshiriq jarimasi (soatlik) va oylik passidan (06:00) OLDIN: ertangi
 * topshiriq o'sha kungi ro'yxatlarga ulgurishi kerak.
 *
 * ⚠️ STARTUP'DA HAM ishlaydi: server bir necha soat o'chiq turgan bo'lsa,
 * ertangi topshiriqlar ko'tarilishi bilan yoziladi. Pass IDEMPOTENT —
 * `(schedule, assignee, kun)` yagona indeksi takror yozishga yo'l qo'ymaydi,
 * shuning uchun kuniga necha marta ishlashi muhim emas.
 *
 * ⚠️ O'TGAN hodisalar YOZILMAYDI (`materializeSchedule`): kechagi hodisani
 * bugun yozish xodimga darhol "bajarilmadi" topshiriq va jarima berardi.
 *
 * Job HECH QACHON jarayonni yiqitmaydi — har filial o'z `try/catch` ida.
 */

const cron = require("node-cron");

const logger = require("../utils/logger");
const { branchCron } = require("../helpers/branchIterator");
const { runSchedulePass } = require("../services/taskSchedule.service");

async function runPass(branchName) {
  try {
    const result = await runSchedulePass();
    if (result.created > 0 || result.failed > 0) {
      logger.info(
        `[TaskScheduleCron] ${branchName}: ${result.schedules} ta qoida, ` +
          `${result.created} ta topshiriq yozildi, ${result.failed} ta xato`,
      );
    }
  } catch (error) {
    logger.error(`[TaskScheduleCron] ${branchName}: pass xatosi`, error);
  }
}

/** Cron jobni belgilaydi va startup'da bir marta ishga tushiradi. */
function startTaskScheduleCron() {
  cron.schedule(
    "20 5 * * *",
    branchCron("[TaskScheduleCron]", (branch) => runPass(branch.name)),
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  // Startup passi — kutilmaydi va xatosi serverni ko'tarilishdan to'smaydi
  branchCron("[TaskScheduleCron:startup]", (branch) => runPass(branch.name))().catch(
    (error) => logger.error("[TaskScheduleCron] startup passi yiqildi", error),
  );

  logger.info(
    "Doimiy topshiriqlar cron job belgilandi: Har kuni 05:20 (Asia/Tashkent)",
  );
}

module.exports = { startTaskScheduleCron, runPass };
