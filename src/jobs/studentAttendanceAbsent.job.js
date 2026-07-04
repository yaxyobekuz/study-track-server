const cron = require("node-cron");
const User = require("../models/user.model");
const StudentAttendance = require("../models/studentAttendance.model");
const Holiday = require("../models/holiday.model");
const logger = require("../utils/logger");
const { getTodayNormalized } = require("../services/attendance.service");
const { getLessonDayMap } = require("../services/schedule.service");
const { DAYS_UZ } = require("../utils/constants");

async function runStudentAbsentMarking() {
  const today = getTodayNormalized();

  // Normallashgan sananing UTC kuni = Toshkent hafta kuni
  const dayName = DAYS_UZ[today.getUTCDay()];

  // Yakshanba - dars yo'q, hech kim absent belgilanmaydi
  if (today.getUTCDay() === 0) {
    logger.info("[StudentAttendanceCron] Bugun yakshanba, o'tkazib yuborildi");
    return;
  }

  const { isHoliday } = await Holiday.isHoliday(today);
  if (isHoliday) {
    logger.info("[StudentAttendanceCron] Bugun bayram kuni, o'tkazib yuborildi");
    return;
  }

  // Bugun darsi bor sinflar to'plami ("classId|dayName")
  const lessonDays = await getLessonDayMap();

  const students = await User.find(
    { isActive: true, role: "student" },
    "_id classes"
  ).lean();

  if (students.length === 0) {
    logger.info("[StudentAttendanceCron] Faol o'quvchilar topilmadi");
    return;
  }

  let marked = 0;
  let skipped = 0;
  let skippedNoLesson = 0;
  let errors = 0;

  for (const student of students) {
    try {
      const existing = await StudentAttendance.findOne({
        student: student._id,
        date: today,
      });

      if (existing) {
        skipped++;
        continue;
      }

      // O'quvchining bugun darsi bor birinchi sinfini topamiz.
      // Jadvalga ko'ra darsi bo'lmagan o'quvchi absent belgilanmaydi.
      const classId = (student.classes || []).find((c) =>
        lessonDays.has(`${c}|${dayName}`)
      );

      if (!classId) {
        skippedNoLesson++;
        continue;
      }

      await StudentAttendance.create({
        student: student._id,
        class: classId,
        date: today,
        status: "absent",
        autoMarked: true,
      });

      marked++;
    } catch (error) {
      errors++;
      logger.error(`[StudentAttendanceCron] ${student._id} uchun xato:`, error);
    }
  }

  logger.info(
    `[StudentAttendanceCron] Tugadi: ${marked} absent belgilandi, ${skipped} o'tkazib yuborildi, ${skippedNoLesson} darsi yo'q, ${errors} xato`
  );
}

async function startStudentAttendanceAbsentCron() {
  cron.schedule(
    "55 23 * * *",
    async () => {
      logger.info("[StudentAttendanceCron] O'quvchilar absent belgilash boshlandi...");
      try {
        await runStudentAbsentMarking();
      } catch (error) {
        logger.error("[StudentAttendanceCron] Cron xatosi:", error);
      }
    },
    {
      scheduled: true,
      timezone: "Asia/Tashkent",
    }
  );

  logger.info(
    "O'quvchilar davomat absent cron job belgilandi: Har kuni 23:55 (Asia/Tashkent)"
  );
}

module.exports = { startStudentAttendanceAbsentCron };
