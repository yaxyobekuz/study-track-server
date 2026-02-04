const cron = require("node-cron");
const Schedule = require("../models/schedule.model");
const Topic = require("../models/topic.model");
const ClassSubjectProgress = require("../models/classSubjectProgress.model");
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
    async () => {
      try {
        // Yakshanba kuni dars yo'q
        if (isSunday()) return;

        const dayName = getCurrentDayUz();
        const now = new Date();
        const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

        // Bugungi jadvallarni topish
        const schedules = await Schedule.find({ day: dayName });

        for (const schedule of schedules) {
          const classId = schedule.class.toString();

          for (const subject of schedule.subjects) {
            // Faqat endTime bor va hozirgi vaqtga teng bo'lgan darslar
            if (subject.endTime && subject.endTime === currentTime) {
              const subjectId = subject.subject.toString();

              // ClassSubjectProgress dan hozirgi mavzu raqamini olish yoki yaratish
              let progress = await ClassSubjectProgress.findOne({
                class: classId,
                subject: subjectId,
              });

              if (!progress) {
                progress = await ClassSubjectProgress.create({
                  class: classId,
                  subject: subjectId,
                  currentTopicNumber: 1,
                });
              }

              const currentTopic = progress.currentTopicNumber;

              // Keyingi mavzu mavjudligini tekshirish
              const nextTopic = await Topic.findOne({
                subject: subjectId,
                order: currentTopic + 1,
              });

              if (nextTopic) {
                progress.currentTopicNumber = currentTopic + 1;
                await progress.save();

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
    },
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
