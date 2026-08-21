const cron = require("node-cron");
const { branchCron } = require("../helpers/branchIterator");
const prisma = require("../config/prisma");
const { isHoliday: checkHoliday } = require("../services/holiday.service");
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

  const { isHoliday } = await checkHoliday(today);
  if (isHoliday) {
    logger.info("[StudentAttendanceCron] Bugun bayram kuni, o'tkazib yuborildi");
    return;
  }

  // Bugun darsi bor sinflar to'plami ("classId|dayName")
  const lessonDays = await getLessonDayMap();

  const students = await prisma.user.findMany({
    where: { isActive: true, role: "student" },
    select: {
      id: true,
      classes: { select: { classId: true } },
    },
  });

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
      const existing = await prisma.studentAttendance.findFirst({
        where: {
          studentId: student.id,
          date: today,
        },
      });

      if (existing) {
        skipped++;
        continue;
      }

      // O'quvchining bugun darsi bor birinchi sinfini topamiz.
      // Jadvalga ko'ra darsi bo'lmagan o'quvchi absent belgilanmaydi.
      const classId = (student.classes || [])
        .map((c) => c.classId)
        .find((c) => lessonDays.has(`${c}|${dayName}`));

      if (!classId) {
        skippedNoLesson++;
        continue;
      }

      await prisma.studentAttendance.create({
        data: {
          studentId: student.id,
          classId: classId,
          date: today,
          status: "absent",
          autoMarked: true,
        },
      });

      marked++;
    } catch (error) {
      errors++;
      logger.error(`[StudentAttendanceCron] ${student.id} uchun xato:`, error);
    }
  }

  logger.info(
    `[StudentAttendanceCron] Tugadi: ${marked} absent belgilandi, ${skipped} o'tkazib yuborildi, ${skippedNoLesson} darsi yo'q, ${errors} xato`
  );
}

async function startStudentAttendanceAbsentCron() {
  cron.schedule(
    "55 23 * * *",
    branchCron("[StudentAttendanceCron]", async (branch) => {
      logger.info("[StudentAttendanceCron] O'quvchilar absent belgilash boshlandi...");
      try {
        await runStudentAbsentMarking();
      } catch (error) {
        logger.error("[StudentAttendanceCron] Cron xatosi:", error);
      }
    }),
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
