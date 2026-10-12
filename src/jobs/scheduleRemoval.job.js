/**
 * KECHIKTIRILGAN JADVAL O'CHIRISH (05:40, Asia/Tashkent).
 *
 * Sinf boshqa filialga ko'chirilganda uning dars jadvali manbada DARHOL
 * o'chirilmaydi — `pending_schedule_removals` navbatiga qo'yiladi va shu
 * job uni KEYINGI OY BOSHIDA bajaradi.
 *
 * ⚠️ NIMA UCHUN KECHIKTIRILADI: `ScheduleLesson` — sanasiz haftalik
 * shablon, soatbay oylik esa uni butun oyga yoyib hisoblaydi. Oy o'rtasida
 * o'chirilsa, shu oyda ALLAQACHON O'TILGAN darslar ham o'qituvchi
 * oyligidan tushib ketardi (`education.md` §8). Oy oxirigacha qoldirish
 * ortiqcha to'lovga olib kelmaydi: ko'chishdan keyingi darslarga baho
 * qo'yilmaydi va ular "o'tilmagan" bo'lib soatga kirmaydi.
 *
 * ⚠️ SINF QAYTIB KELGAN BO'LSA O'CHIRILMAYDI: navbat qatori yozilgandan
 * keyin sinfga o'quvchi qaytarilgan bo'lsa (yoki u umuman bo'shamagan
 * bo'lsa), jadval HAQIQATDA ishlatilmoqda — qator `cancelled` bo'ladi va
 * sababi yoziladi. Avtomat o'chirish odamning keyingi qarorini bosib
 * o'tmasligi kerak.
 *
 * ⚠️ 05:40 — moliya (03:00), inventar (03:20) va qurilma (03:40)
 * tekshiruvlaridan KEYIN, hisob-faktura/oylik passidan (06:00) OLDIN:
 * jadval o'chishi o'sha kungi oylik hisobiga ulgurishi kerak.
 *
 * Job HECH QACHON jarayonni yiqitmaydi — har filial o'z `try/catch` ida.
 */

const cron = require("node-cron");

const prisma = require("../config/prisma");
const { branchCron } = require("../helpers/branchIterator");
const { getBranch } = require("../config/branchContext");
const logger = require("../utils/logger");
const { currentMonthKey, formatMonthKey } = require("../helpers/month.helpers");
const {
  withScheduleWriteLock,
  assertPlatformMode,
} = require("../services/scheduleWriteGuard.service");

/**
 * Bitta filial uchun pass.
 * @returns {Promise<{removed: number, cancelled: number, pending: number}>}
 */
async function runScheduleRemovalPass() {
  const branch = getBranch();
  const tag = `[ScheduleRemoval] ${branch ? branch.name : "?"}`;

  const due = await prisma.pendingScheduleRemoval.findMany({
    where: { status: "pending", effectiveMonth: { lte: currentMonthKey() } },
    orderBy: [{ effectiveMonth: "asc" }, { createdAt: "asc" }],
  });
  if (due.length === 0) return { removed: 0, cancelled: 0, pending: 0 };

  let removed = 0;
  let cancelled = 0;
  let pending = 0;

  for (const row of due) {
    try {
      // Sinf yana ishlatilmoqdami? Ishlatilayotgan jadvalni avtomat
      // o'chirish odamning keyingi qarorini bosib o'tardi.
      const members = await prisma.userClass.count({
        where: { classId: row.classId, user: { role: "student", isArchived: false } },
      });
      if (members > 0) {
        await prisma.pendingScheduleRemoval.update({
          where: { id: row.id },
          data: {
            status: "cancelled",
            processedAt: new Date(),
            failReason: `Sinfda yana ${members} ta o'quvchi bor — jadval o'chirilmadi`,
          },
        });
        cancelled += 1;
        continue;
      }

      const deleted = await withScheduleWriteLock(async (tx) => {
        await assertPlatformMode(tx);
        const lessons = await tx.scheduleLesson.count({
          where: { schedule: { classId: row.classId } },
        });
        // `schedule_lessons` → `onDelete: Cascade`
        await tx.schedule.deleteMany({ where: { classId: row.classId } });
        return lessons;
      });

      await prisma.pendingScheduleRemoval.update({
        where: { id: row.id },
        data: {
          status: "done",
          processedAt: new Date(),
          failReason: "",
          lessonCount: deleted,
        },
      });
      removed += 1;
      logger.info(
        `${tag} "${row.className}" sinfining ${deleted} ta darsi jadvaldan olib tashlandi ` +
          `(${formatMonthKey(row.effectiveMonth)} dan, ko'chirish=${row.transferId ?? "—"})`,
      );
    } catch (error) {
      // Navbatda QOLADI va ertaga qayta uriniladi (sheet rejimi, qulf band).
      // Jim yo'qolmasligi uchun sabab qatorga yoziladi.
      pending += 1;
      await prisma.pendingScheduleRemoval
        .update({
          where: { id: row.id },
          data: { failReason: error.message?.slice(0, 500) ?? "noma'lum xato" },
        })
        .catch(() => {});
      logger.warn(`${tag} "${row.className}" jadvali o'chirilmadi: ${error.message}`);
    }
  }

  if (removed || cancelled || pending) {
    logger.info(
      `${tag} ${removed} ta jadval o'chirildi, ${cancelled} ta bekor qilindi, ` +
        `${pending} ta navbatda qoldi`,
    );
  }
  return { removed, cancelled, pending };
}

/** Cron jobni belgilaydi. Har kuni 05:40 (Asia/Tashkent). */
function startScheduleRemovalCron() {
  cron.schedule(
    "40 5 * * *",
    branchCron("[ScheduleRemovalCron]", async (branch) => {
      try {
        await runScheduleRemovalPass();
      } catch (error) {
        logger.error(`[ScheduleRemoval] ${branch.name}: cron xatosi`, error);
      }
    }),
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  logger.info(
    "Kechiktirilgan jadval o'chirish cron job belgilandi: Har kuni 05:40 (Asia/Tashkent)",
  );
}

module.exports = { startScheduleRemovalCron, runScheduleRemovalPass };
