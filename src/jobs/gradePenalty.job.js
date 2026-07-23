const cron = require("node-cron");
const prisma = require("../config/prisma");
const { isHoliday } = require("../services/holiday.service");
const { getGradePenaltySettings } = require("../services/settings.service");
const logger = require("../utils/logger");
const {
  getNowInUzbekistan,
  getDayNameUz,
  getDateRangeForDay,
  isSunday,
} = require("../helpers/date.helpers");

/**
 * Bugungi qo'yilmagan baholar uchun o'qituvchilarga avtomatik jarima beradi.
 * @param {Object} ownerUser
 */
async function runGradePenaltyPass(ownerUser) {
  if (!ownerUser) {
    logger.warn("[GradePenaltyCron] Owner foydalanuvchi topilmadi, o'tkazib yuborildi");
    return;
  }

  const settings = await getGradePenaltySettings();

  if (!settings.isEnabled) {
    logger.info("[GradePenaltyCron] Baho jarima tizimi o'chirilgan, o'tkazib yuborildi");
    return;
  }

  const now = getNowInUzbekistan();

  if (isSunday(now)) {
    logger.info("[GradePenaltyCron] Yakshanba kuni, o'tkazib yuborildi");
    return;
  }

  const { isHoliday: holidayToday } = await isHoliday(now);
  if (holidayToday) {
    logger.info("[GradePenaltyCron] Bayram kuni, o'tkazib yuborildi");
    return;
  }

  const todayDayName = getDayNameUz(now);
  const { startDate, endDate } = getDateRangeForDay(now);
  const dateStr = now.toISOString().split("T")[0];

  const exemptSet = new Set(
    (settings.exemptTeachers || []).map((id) => id.toString()),
  );

  const todaySchedules = await prisma.schedule.findMany({
    where: { day: todayDayName },
    include: { lessons: true },
  });

  // Schedule.classId scalar (relation YO'Q) — sinflarni qo'lda yuklaymiz
  const classIds = [...new Set(todaySchedules.map((s) => s.classId))];
  const classes = await prisma.class.findMany({
    where: { id: { in: classIds } },
    select: { id: true, name: true, isActive: true },
  });
  const classMap = {};
  classes.forEach((c) => {
    classMap[c.id] = c;
  });

  let penalized = 0;
  let skipped = 0;
  let errors = 0;

  for (const schedule of todaySchedules) {
    const scheduleClass = classMap[schedule.classId];
    if (!scheduleClass || !scheduleClass.isActive) continue;

    const studentsInClass = await prisma.user.findMany({
      where: {
        role: "student",
        classes: { some: { classId: schedule.classId } },
        isActive: true,
      },
      select: { id: true },
    });

    const totalStudents = studentsInClass.length;
    if (totalStudents === 0) continue;

    const todayGrades = await prisma.grade.findMany({
      where: {
        classId: schedule.classId,
        date: { gte: startDate, lte: endDate },
      },
    });

    for (const lesson of schedule.lessons) {
      if (!lesson.teacherId) continue;

      const teacherId = lesson.teacherId.toString();

      if (exemptSet.has(teacherId)) {
        skipped++;
        continue;
      }

      const gradedStudentIds = new Set(
        todayGrades
          .filter(
            (g) =>
              g.subjectId.toString() === lesson.subjectId.toString() &&
              g.lessonOrder === lesson.order,
          )
          .map((g) => g.studentId.toString()),
      );

      const missingCount = studentsInClass.filter(
        (s) => !gradedStudentIds.has(s.id.toString()),
      ).length;

      const missingPercent = (missingCount / totalStudents) * 100;

      if (missingPercent < settings.missingThresholdPercent) {
        skipped++;
        continue;
      }

      const penaltyTitle = `Baho qo'ymaslik: ${scheduleClass.name} ${lesson.order}-dars (${dateStr})`;

      const alreadyPenalized = await prisma.penalty.findFirst({
        where: {
          userId: lesson.teacherId,
          title: penaltyTitle,
          isCustom: true,
        },
      });

      if (alreadyPenalized) {
        skipped++;
        continue;
      }

      try {
        await prisma.penalty.create({
          data: {
            userId: lesson.teacherId,
            givenBy: ownerUser.id,
            title: penaltyTitle,
            description: `${missingCount}/${totalStudents} o'quvchiga baho qo'yilmagan (${Math.round(missingPercent)}%)`,
            points: settings.penaltyPoints,
            status: "approved",
            isCustom: true,
            reviewedBy: ownerUser.id,
            reviewedAt: new Date(),
          },
        });

        await prisma.user.update({
          where: { id: lesson.teacherId },
          data: { penaltyPoints: { increment: settings.penaltyPoints } },
        });

        penalized++;
      } catch (error) {
        errors++;
        logger.error(
          `[GradePenaltyCron] O'qituvchi ${teacherId} ga jarima berishda xato:`,
          error,
        );
      }
    }
  }

  logger.info(
    `[GradePenaltyCron] Tugadi: ${penalized} ta jarima berildi, ${skipped} ta o'tkazib yuborildi, ${errors} ta xato`,
  );
}

/**
 * Baho qo'ymaslik jarima cron job ni boshlaydi.
 * Har kuni soat 20:00 da ishga tushadi (Asia/Tashkent)
 */
async function startGradePenaltyCron() {
  cron.schedule(
    "0 20 * * *",
    async () => {
      logger.info("[GradePenaltyCron] Baho qo'ymaslik tekshiruvi boshlandi...");
      try {
        const ownerUser = await prisma.user.findFirst({
          where: { role: "owner" },
          select: { id: true },
        });
        if (!ownerUser) {
          logger.warn("[GradePenaltyCron] Owner topilmadi - jarimalar qo'llanilmaydi");
        }
        await runGradePenaltyPass(ownerUser);
      } catch (error) {
        logger.error("[GradePenaltyCron] Cron xatosi:", error);
      }
    },
    {
      scheduled: true,
      timezone: "Asia/Tashkent",
    },
  );

  logger.info("Baho jarima cron job belgilandi: Har kuni 20:00 (Asia/Tashkent)");
}

module.exports = { startGradePenaltyCron, runGradePenaltyPass };
