const cron = require("node-cron");
const { branchCron } = require("../helpers/branchIterator");
const prisma = require("../config/prisma");
const { currentDayDate } = require("../helpers/month.helpers");
const { getGradePenaltySettings } = require("../services/settings.service");
// ⚠️ HISOB BU YERDA EMAS. "Qaysi darsga jarima haqli" degan savolga javob
// `gradePenalty.service.js` da — qayta tekshirish ham o'shani chaqiradi.
// Ikkinchi javob yozilsa, tozalash jarima yozishdan boshqacha ishlardi.
const {
  DAY_SKIP,
  LESSON_SKIP,
  computeDayPenalties,
  penaltyDescription,
} = require("../services/gradePenalty.service");
const logger = require("../utils/logger");

const SKIP_LOG = {
  [DAY_SKIP.DISABLED]: "Baho jarima tizimi o'chirilgan",
  [DAY_SKIP.SUNDAY]: "Yakshanba kuni",
  [DAY_SKIP.HOLIDAY]: "Bayram kuni",
};

/**
 * Bugungi qo'yilmagan baholar uchun o'qituvchilarga avtomatik jarima beradi.
 *
 * ⚠️ IDEMPOTENT: jarima SARLAVHA bo'yicha qidiriladi (dars sarlavhadan
 * tanib olinadi — `gradePenalty.helpers.js`), ya'ni pass kuniga necha marta
 * ishlasa ham takror yozilmaydi.
 *
 * @param {Object} ownerUser
 */
async function runGradePenaltyPass(ownerUser) {
  if (!ownerUser) {
    logger.warn("[GradePenaltyCron] Owner foydalanuvchi topilmadi, o'tkazib yuborildi");
    return;
  }

  const settings = await getGradePenaltySettings();
  const day = currentDayDate();

  const { skip, lessons } = await computeDayPenalties(day, settings);

  if (skip) {
    logger.info(`[GradePenaltyCron] ${SKIP_LOG[skip] ?? skip}, o'tkazib yuborildi`);
    return;
  }

  let penalized = 0;
  let skipped = 0;
  let errors = 0;

  for (const entry of lessons.values()) {
    if (!entry.deserved) {
      skipped++;
      continue;
    }

    try {
      const alreadyPenalized = await prisma.penalty.findFirst({
        where: { userId: entry.teacherId, title: entry.title, isCustom: true },
        select: { id: true },
      });

      if (alreadyPenalized) {
        skipped++;
        continue;
      }

      await prisma.penalty.create({
        data: {
          userId: entry.teacherId,
          givenBy: ownerUser.id,
          title: entry.title,
          description: penaltyDescription(entry),
          points: settings.penaltyPoints,
          status: "approved",
          isCustom: true,
          reviewedBy: ownerUser.id,
          reviewedAt: new Date(),
        },
      });

      await prisma.user.update({
        where: { id: entry.teacherId },
        data: { penaltyPoints: { increment: settings.penaltyPoints } },
      });

      penalized++;
    } catch (error) {
      errors++;
      logger.error(
        `[GradePenaltyCron] O'qituvchi ${entry.teacherId} ga jarima berishda xato:`,
        error,
      );
    }
  }

  // ⚠️ BAHO KUTILGAN O'QUVCHISI YO'Q DARS — JIM QOLMAYDI. Maxraj o'qish
  // davriga tayanadi (`education.md` §3): butun sinfda davr yozilmagan
  // bo'lsa maxraj nolga tushadi va jarima tizimi o'sha sinf uchun
  // o'z-o'zidan o'chib qoladi. Ro'yxat logda ko'rinib tursin.
  const emptyClasses = [
    ...new Set(
      [...lessons.values()]
        .filter((entry) => entry.skip === LESSON_SKIP.NO_STUDENTS)
        .map((entry) => entry.className),
    ),
  ];
  if (emptyClasses.length > 0) {
    logger.warn(
      `[GradePenaltyCron] Baho kutilgan o'quvchi yo'q: ${emptyClasses.join(", ")} — ` +
        "o'qish davrlari to'ldirilganini tekshiring (npm run enrollment:backfill)",
    );
  }

  logger.info(
    `[GradePenaltyCron] Tugadi: ${penalized} ta jarima berildi, ${skipped} ta o'tkazib yuborildi, ${errors} ta xato`,
  );
}

/**
 * Baho qo'ymaslik jarima cron job ni boshlaydi.
 *
 * ⚠️ 22:00 (biznes qarori, 2026-10-20). Ilgari 20:00 edi va baho kun
 * davomida qo'yilishi mumkin bo'lsa ham (`education.md` §7), 20:00 dan
 * keyin qo'yilgani jarimani to'xtatmasdi: o'qituvchi hammani baholab
 * bo'lgan holda jarima olardi.
 */
async function startGradePenaltyCron() {
  cron.schedule(
    "0 22 * * *",
    branchCron("[GradePenaltyCron]", async (branch) => {
      logger.info(`[GradePenaltyCron] ${branch.name}: baho qo'ymaslik tekshiruvi boshlandi...`);
      try {
        const ownerUser = await prisma.user.findFirst({
          where: { role: "owner" },
          select: { id: true },
        });
        if (!ownerUser) {
          logger.warn(`[GradePenaltyCron] ${branch.name}: owner topilmadi — jarimalar qo'llanilmaydi`);
        }
        await runGradePenaltyPass(ownerUser);
      } catch (error) {
        logger.error("[GradePenaltyCron] Cron xatosi:", error);
      }
    }),
    {
      scheduled: true,
      timezone: "Asia/Tashkent",
    },
  );

  logger.info("Baho jarima cron job belgilandi: Har kuni 22:00 (Asia/Tashkent)");
}

module.exports = { startGradePenaltyCron, runGradePenaltyPass };
