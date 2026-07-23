const cron = require("node-cron");
const prisma = require("../config/prisma");
const { isHoliday: checkHoliday } = require("../services/holiday.service");
const logger = require("../utils/logger");
const {
  getTodayNormalized,
  getEffectiveSchedule,
  isPenaltyPaused,
  createAttendancePenalty,
  getDayOfWeekTashkent,
} = require("../services/attendance.service");
const { getAttendanceSettings } = require("../services/settings.service");

/**
 * Kun oxirida davomatsiz qolgan xodimlarni "absent" deb belgilaydi va jarima yozadi.
 * @param {Object} ownerUser
 */
async function runAbsentMarking(ownerUser) {
  if (!ownerUser) {
    logger.warn("[AttendanceCron] Owner foydalanuvchi topilmadi, o'tkazib yuborildi");
    return;
  }

  const today = getTodayNormalized();
  const todayDayOfWeek = getDayOfWeekTashkent();

  // Bugun bayram kunmi?
  const { isHoliday } = await checkHoliday(today);
  if (isHoliday) {
    logger.info("[AttendanceCron] Bugun bayram kuni, o'tkazib yuborildi");
    return;
  }

  const settings = await getAttendanceSettings();

  // Barcha aktiv, non-student, non-owner foydalanuvchilar
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      role: { notIn: ["owner", "student"] },
    },
  });

  if (users.length === 0) {
    logger.info("[AttendanceCron] Tekshiriladigan foydalanuvchi topilmadi");
    return;
  }

  let markedAbsent = 0;
  let markedExcused = 0;
  let skipped = 0;
  let errors = 0;

  for (const user of users) {
    try {
      const schedule = await getEffectiveSchedule(user);

      // Bu foydalanuvchining ish kuni emasa, o'tkazib yuborish
      if (!schedule.workDays.includes(todayDayOfWeek)) {
        skipped++;
        continue;
      }

      // Bugungi yozuv bor bo'lsa (check-in qilgan yoki allaqachon belgilangan), o'tkazib yuborish
      const existingRecord = await prisma.attendance.findFirst({
        where: { userId: user.id, date: today },
      });
      if (existingRecord) {
        skipped++;
        continue;
      }

      // Tasdiqlangan excuse bor bo'lsa
      const approvedExcuse = await prisma.excuseRequest.findFirst({
        where: {
          userId: user.id,
          date: today,
          status: "approved",
        },
      });

      const status = approvedExcuse ? "excused" : "absent";

      const record = await prisma.attendance.create({
        data: {
          userId: user.id,
          date: today,
          status,
          autoMarked: true,
          createdBy: ownerUser.id,
        },
      });

      if (status === "absent") {
        markedAbsent++;

        // Ish vaqti umuman sozlanmagan rol/foydalanuvchi uchun jarima yozilmaydi
        const hasWorkSchedule = !!schedule.workStartTime;
        const penaltyPaused = isPenaltyPaused(settings, user.id, user.role);
        if (hasWorkSchedule && !penaltyPaused && settings.absentPenaltyPoints > 0) {
          const dateStr = today.toISOString().split("T")[0];
          const penalty = await createAttendancePenalty(
            user.id,
            ownerUser.id,
            `Kelmaganlik uchun: ${dateStr}`,
            settings.absentPenaltyPoints
          );
          await prisma.attendance.update({
            where: { id: record.id },
            data: { penaltyApplied: true, penaltyRef: penalty.id },
          });
        }
      } else {
        markedExcused++;
      }
    } catch (error) {
      errors++;
      logger.error(`[AttendanceCron] ${user.id} foydalanuvchi uchun xato:`, error);
    }
  }

  logger.info(
    `[AttendanceCron] Tugadi: ${markedAbsent} absent, ${markedExcused} excused, ${skipped} o'tkazib yuborildi, ${errors} xato`
  );
}

/**
 * Davomat absent cron job ni boshlaydi
 * Har kuni soat 23:45 da ishga tushadi (Asia/Tashkent)
 */
async function startAttendanceAbsentCron() {
  cron.schedule(
    "45 23 * * *",
    async () => {
      logger.info("[AttendanceCron] Davomatsiz xodimlarni belgilash boshlandi...");
      try {
        const ownerUser = await prisma.user.findFirst({
          where: { role: "owner" },
          select: { id: true },
        });
        if (!ownerUser) {
          logger.warn("[AttendanceCron] Owner topilmadi - jarimalar qo'llanilmaydi");
        }
        await runAbsentMarking(ownerUser);
      } catch (error) {
        logger.error("[AttendanceCron] Cron xatosi:", error);
      }
    },
    {
      scheduled: true,
      timezone: "Asia/Tashkent",
    }
  );

  logger.info("Davomat absent cron job belgilandi: Har kuni 23:45 (Asia/Tashkent)");
}

module.exports = { startAttendanceAbsentCron };
