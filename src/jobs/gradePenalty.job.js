const cron = require("node-cron");
const User = require("../models/user.model");
const Grade = require("../models/grade.model");
const Schedule = require("../models/schedule.model");
const Holiday = require("../models/holiday.model");
const Penalty = require("../models/penalty.model");
const GradePenaltySettings = require("../models/gradePenaltySettings.model");
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

  const settings = await GradePenaltySettings.getSettings();

  if (!settings.isEnabled) {
    logger.info("[GradePenaltyCron] Baho jarima tizimi o'chirilgan, o'tkazib yuborildi");
    return;
  }

  const now = getNowInUzbekistan();

  if (isSunday(now)) {
    logger.info("[GradePenaltyCron] Yakshanba kuni, o'tkazib yuborildi");
    return;
  }

  const { isHoliday } = await Holiday.isHoliday(now);
  if (isHoliday) {
    logger.info("[GradePenaltyCron] Bayram kuni, o'tkazib yuborildi");
    return;
  }

  const todayDayName = getDayNameUz(now);
  const { startDate, endDate } = getDateRangeForDay(now);
  const dateStr = now.toISOString().split("T")[0];

  const exemptSet = new Set(
    (settings.exemptTeachers || []).map((id) => id.toString()),
  );

  const todaySchedules = await Schedule.find({ day: todayDayName })
    .populate("class", "name isActive")
    .populate("subjects.subject", "name")
    .populate("subjects.teacher", "_id firstName lastName");

  let penalized = 0;
  let skipped = 0;
  let errors = 0;

  for (const schedule of todaySchedules) {
    if (!schedule.class || !schedule.class.isActive) continue;

    const studentsInClass = await User.find({
      role: "student",
      classes: schedule.class._id,
      isActive: true,
    })
      .select("_id")
      .lean();

    const totalStudents = studentsInClass.length;
    if (totalStudents === 0) continue;

    const todayGrades = await Grade.find({
      class: schedule.class._id,
      date: { $gte: startDate, $lte: endDate },
    }).lean();

    for (const lesson of schedule.subjects) {
      if (!lesson.teacher) continue;

      const teacherId = lesson.teacher._id.toString();

      if (exemptSet.has(teacherId)) {
        skipped++;
        continue;
      }

      const gradedStudentIds = new Set(
        todayGrades
          .filter(
            (g) =>
              g.subject.toString() === lesson.subject._id.toString() &&
              g.lessonOrder === lesson.order,
          )
          .map((g) => g.student.toString()),
      );

      const missingCount = studentsInClass.filter(
        (s) => !gradedStudentIds.has(s._id.toString()),
      ).length;

      const missingPercent = (missingCount / totalStudents) * 100;

      if (missingPercent < settings.missingThresholdPercent) {
        skipped++;
        continue;
      }

      const penaltyTitle = `Baho qo'ymaslik: ${schedule.class.name} ${lesson.order}-dars (${dateStr})`;

      const alreadyPenalized = await Penalty.findOne({
        user: lesson.teacher._id,
        title: penaltyTitle,
        isCustom: true,
      }).lean();

      if (alreadyPenalized) {
        skipped++;
        continue;
      }

      try {
        await Penalty.create({
          user: lesson.teacher._id,
          givenBy: ownerUser._id,
          title: penaltyTitle,
          description: `${missingCount}/${totalStudents} o'quvchiga baho qo'yilmagan (${Math.round(missingPercent)}%)`,
          points: settings.penaltyPoints,
          status: "approved",
          isCustom: true,
          reviewedBy: ownerUser._id,
          reviewedAt: new Date(),
        });

        await User.findByIdAndUpdate(lesson.teacher._id, {
          $inc: { penaltyPoints: settings.penaltyPoints },
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
        const ownerUser = await User.findOne({ role: "owner" }).select("_id").lean();
        if (!ownerUser) {
          logger.warn("[GradePenaltyCron] Owner topilmadi — jarimalar qo'llanilmaydi");
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
