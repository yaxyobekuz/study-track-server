const cron = require("node-cron");
const { branchCron } = require("../helpers/branchIterator");
const { generateWeeklyInsight } = require("../services/academicInsight.service");
const logger = require("../utils/logger");

/**
 * HAFTALIK AI TAHLIL — har DUSHANBA 07:00 (Asia/Tashkent).
 *
 * ⚠️ Dushanba erta tong ATAYLAB: hafta boshlanishidan oldin reja tayyor
 * bo'lsin. Juma kuni yozilsa, vazifalar "shu hafta" degan ma'nosini
 * yo'qotardi — `dueLabel` ("Payshanbagacha") kelasi haftaga tegishli
 * bo'lib qolardi.
 *
 * ⚠️ `branchCron` MAJBURIY: `config/prisma.js` filial kontekstisiz xato
 * beradi, ya'ni o'ralmagan job birinchi so'rovdayoq yiqilardi. Har filial
 * O'Z tahlilini oladi — raqamlar ham, matn ham filialning o'ziniki.
 *
 * ⚠️ Servis model xatosini O'ZI yutadi (`source: "rules"` bilan yozadi),
 * shuning uchun bu yerdagi `try/catch` faqat baza xatosi uchun: bitta
 * filialdagi muammo qolgan filiallarni to'xtatmaydi.
 */
function startAcademicInsightCron() {
  cron.schedule(
    "0 7 * * 1",
    branchCron("[AcademicInsight]", async (branch) => {
      try {
        logger.info(`[AcademicInsight] ${branch.name}: haftalik tahlil boshlandi`);

        const result = await generateWeeklyInsight();

        logger.info(
          `[AcademicInsight] ${branch.name}: tugadi (manba: ${result.source}, ${result.actions.length} ta vazifa)`,
        );
      } catch (error) {
        logger.error(`[AcademicInsight] ${branch.name}: xato — ${error.message}`);
      }
    }),
    {
      scheduled: true,
      timezone: "Asia/Tashkent",
    },
  );

  logger.info(
    "Academic insight cron job scheduled: Every Monday at 07:00 (Asia/Tashkent)",
  );
}

module.exports = { startAcademicInsightCron, start: startAcademicInsightCron };
