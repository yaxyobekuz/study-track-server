const cron = require("node-cron");
const User = require("../models/user.model");
const Attendance = require("../models/attendance.model");
const ExcuseRequest = require("../models/excuseRequest.model");
const Holiday = require("../models/holiday.model");
const logger = require("../utils/logger");
const {
  getTodayNormalized,
  getEffectiveSchedule,
  isPenaltyPaused,
  createAttendancePenalty,
  getDayOfWeekTashkent,
} = require("../services/attendance.service");
const AttendanceSettings = require("../models/attendanceSettings.model");

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
  const { isHoliday } = await Holiday.isHoliday(today);
  if (isHoliday) {
    logger.info("[AttendanceCron] Bugun bayram kuni, o'tkazib yuborildi");
    return;
  }

  const settings = await AttendanceSettings.getSettings();

  // Barcha aktiv, non-student, non-owner foydalanuvchilar
  const users = await User.find({
    isActive: true,
    role: { $nin: ["owner", "student"] },
  }).lean();

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
      const existingRecord = await Attendance.findOne({ user: user._id, date: today });
      if (existingRecord) {
        skipped++;
        continue;
      }

      // Tasdiqlangan excuse bor bo'lsa
      const approvedExcuse = await ExcuseRequest.findOne({
        user: user._id,
        date: today,
        status: "approved",
      });

      const status = approvedExcuse ? "excused" : "absent";

      const record = await Attendance.create({
        user: user._id,
        date: today,
        status,
        autoMarked: true,
        createdBy: ownerUser._id,
      });

      if (status === "absent") {
        markedAbsent++;

        // Ish vaqti umuman sozlanmagan rol/foydalanuvchi uchun jarima yozilmaydi
        const hasWorkSchedule = !!schedule.workStartTime;
        const penaltyPaused = isPenaltyPaused(settings, user._id, user.role);
        if (hasWorkSchedule && !penaltyPaused && settings.absentPenaltyPoints > 0) {
          const dateStr = today.toISOString().split("T")[0];
          const penalty = await createAttendancePenalty(
            user._id,
            ownerUser._id,
            `Kelmaganlik uchun: ${dateStr}`,
            settings.absentPenaltyPoints
          );
          record.penaltyApplied = true;
          record.penaltyRef = penalty._id;
          await record.save();
        }
      } else {
        markedExcused++;
      }
    } catch (error) {
      errors++;
      logger.error(`[AttendanceCron] ${user._id} foydalanuvchi uchun xato:`, error);
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
        const ownerUser = await User.findOne({ role: "owner" }).select("_id").lean();
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
