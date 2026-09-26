const cron = require("node-cron");
const { branchCron } = require("../helpers/branchIterator");
const { runWeekly, recoverStaleRuns } = require("../services/gradeAnalysis.service");
const logger = require("../utils/logger");

/**
 * BAHOLAR TAHLILI — ikki vazifa.
 *
 * 1) HAFTALIK TAHLIL — har DUSHANBA 07:30 (Asia/Tashkent): o'tgan hafta
 *    (dushanba–yakshanba), butun maktab. Sozlamada o'chirilgan bo'lsa yoki
 *    shu hafta uchun allaqachon yozilgan bo'lsa — o'tkaziladi.
 *    ⚠️ 07:30 — `academicInsight` (07:00) dan keyin: ikkalasi bitta AI
 *    kalitini ishlatadi, bir daqiqaga to'planmasin.
 *    Tahlil FONDA ishlanadi (`createRun` → `setImmediate`): filiallar
 *    ketma-ket aylanadi va bittasining uzoq tahlili qolganlarini
 *    kechiktirmasligi kerak. Bir filialda bir vaqtda bitta tahlil.
 *
 * 2) TIKLASH — har 5 daqiqada: yurak urishi to'xtagan tahlilni qayta
 *    navbatga qo'yadi va navbatda qolganini boshlaydi (deploy tahlilni
 *    o'rtada uzsa, u `running` da abadiy osilib qolardi).
 *
 * ⚠️ `branchCron` MAJBURIY: har filial o'z tahlilini o'z schema'sida oladi.
 */
function startGradeAnalysisCron() {
  cron.schedule(
    "30 7 * * 1",
    branchCron("[GradeAnalysis]", async (branch) => {
      try {
        const result = await runWeekly();
        if (result.skipped) {
          logger.info(`[GradeAnalysis] ${branch.name}: haftalik tahlil o'tkazildi (${result.skipped})`);
        } else {
          logger.info(`[GradeAnalysis] ${branch.name}: haftalik tahlil boshlandi (${result.runId})`);
        }
      } catch (error) {
        logger.error(`[GradeAnalysis] ${branch.name}: haftalik tahlil xatosi — ${error.message}`);
      }
    }),
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  cron.schedule(
    "*/5 * * * *",
    branchCron("[GradeAnalysisRecover]", async (branch) => {
      try {
        const result = await recoverStaleRuns();
        if (result.requeued || result.started) {
          logger.info(
            `[GradeAnalysisRecover] ${branch.name}: qayta navbatga ${result.requeued}, boshlandi ${result.started}`,
          );
        }
      } catch (error) {
        logger.error(`[GradeAnalysisRecover] ${branch.name}: xato — ${error.message}`);
      }
    }),
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  logger.info("Grade analysis cron scheduled: Monday 07:30 weekly + recovery every 5 min (Asia/Tashkent)");
}

module.exports = { startGradeAnalysisCron, start: startGradeAnalysisCron };
