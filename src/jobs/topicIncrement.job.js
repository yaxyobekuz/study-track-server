const cron = require("node-cron");
const { branchCron } = require("../helpers/branchIterator");
const prisma = require("../config/prisma");
const { getCurrentDayUz, isSunday } = require("../helpers/date.helpers");
const logger = require("../utils/logger");

/**
 * Har minutda ishlaydi va tugash vaqti kelgan darslar uchun mavzuni oshiradi.
 *
 * MUHIM: Har bir sinf+fan uchun faqat BITTA global mavzu raqami bor.
 * Bir kunda bir xil fan bir necha marta bo'lsa, HAR BIR dars tugaganda
 * mavzu 1 taga oshiriladi.
 *
 * Masalan: Rus tili 5-soat va 6-soatda bo'lsa:
 * - 5-soat tugadi → mavzu 4 → 5
 * - 6-soat tugadi → mavzu 5 → 6
 */
function startTopicIncrementCron() {
  cron.schedule(
    "* * * * *",
    branchCron("[TopicCron]", async (branch) => {
      try {
        // Yakshanba kuni dars yo'q
        if (isSunday()) return;

        const dayName = getCurrentDayUz();
        const now = new Date();
        const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

        // Bugungi jadvallarni topish
        const schedules = await prisma.schedule.findMany({
          where: { day: dayName },
          include: { lessons: true },
        });

        for (const schedule of schedules) {
          const classId = schedule.classId.toString();

          for (const subject of schedule.lessons) {
            // Faqat endTime bor va hozirgi vaqtga teng bo'lgan darslar
            if (subject.endTime && subject.endTime === currentTime) {
              const subjectId = subject.subjectId.toString();

              // ClassSubjectProgress dan hozirgi mavzu raqamini olish yoki yaratish
              let progress = await prisma.classSubjectProgress.findUnique({
                where: { classId_subjectId: { classId, subjectId } },
              });

              if (!progress) {
                progress = await prisma.classSubjectProgress.create({
                  data: {
                    classId,
                    subjectId,
                    currentTopicNumber: 1,
                  },
                });
              }

              const currentTopic = progress.currentTopicNumber;

              // Keyingi mavzu mavjudligini tekshirish
              const nextTopic = await prisma.topic.findUnique({
                where: {
                  subjectId_order: { subjectId, order: currentTopic + 1 },
                },
              });

              if (nextTopic) {
                await prisma.classSubjectProgress.update({
                  where: { id: progress.id },
                  data: { currentTopicNumber: currentTopic + 1 },
                });

                logger.info(
                  `[TopicCron] Incremented topic for class ${classId}, ` +
                    `subject ${subjectId}: ${currentTopic} → ${currentTopic + 1}`
                );
              }
            }
          }
        }
      } catch (error) {
        logger.error(`[TopicCron] Error: ${error.message}`);
      }
    }),
    {
      scheduled: true,
      timezone: "Asia/Tashkent",
    }
  );

  logger.info(
    "Topic increment cron job scheduled: Every minute (Asia/Tashkent)"
  );
}

module.exports = { startTopicIncrementCron };
