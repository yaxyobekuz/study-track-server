const cron = require("node-cron");
const prisma = require("../config/prisma");
const logger = require("../utils/logger");

async function runPenaltyPass(ownerUser) {
  if (!ownerUser) {
    logger.warn("[TaskPenaltyCron] Owner foydalanuvchi topilmadi, o'tkazib yuborildi");
    return;
  }

  const now = new Date();

  const tasks = await prisma.task.findMany({
    where: {
      dueDate: { lt: now },
      status: { notIn: ["completed", "pending_review", "stopped"] },
      autopenalized: false,
    },
  });

  if (tasks.length === 0) {
    logger.info("[TaskPenaltyCron] Jarima qo'llash uchun topshiriq topilmadi");
    return;
  }

  let penalized = 0;
  let errors = 0;

  for (const task of tasks) {
    try {
      const penalty = await prisma.penalty.create({
        data: {
          userId: task.assignee,
          givenBy: ownerUser.id,
          title: `Topshiriq muddati o'tdi: ${task.title}`,
          description: "Muddati o'tganligi sababli avtomatik jarima",
          points: task.penaltyPoints,
          status: "approved",
          isCustom: true,
          reviewedBy: ownerUser.id,
          reviewedAt: now,
        },
      });

      await prisma.user.update({
        where: { id: task.assignee },
        data: { penaltyPoints: { increment: task.penaltyPoints } },
      });

      const historyCount = await prisma.taskStatusHistory.count({
        where: { taskId: task.id },
      });

      await prisma.$transaction([
        prisma.task.update({
          where: { id: task.id },
          data: { autopenalized: true, penaltyRef: penalty.id },
        }),
        prisma.taskStatusHistory.create({
          data: {
            taskId: task.id,
            status: task.status,
            reason: "Muddati o'tganligi sababli avtomatik jarima qo'llanildi",
            changedBy: ownerUser.id,
            changedAt: now,
            position: historyCount,
          },
        }),
      ]);

      penalized++;
    } catch (error) {
      errors++;
      logger.error(`[TaskPenaltyCron] Task ${task.id} ga jarima qo'llashda xato:`, error);
    }
  }

  logger.info(
    `[TaskPenaltyCron] Tugadi: ${penalized} ta topshiriqqa jarima qo'llanildi, ${errors} ta xato`,
  );
}

async function startTaskPenaltyCron() {
  let ownerUser;

  try {
    ownerUser = await prisma.user.findFirst({
      where: { role: "owner" },
      select: { id: true },
    });
    if (!ownerUser) {
      logger.warn("[TaskPenaltyCron] Owner topilmadi - cron ishlaydi lekin jarimalar qo'llanilmaydi");
    }
  } catch (error) {
    logger.error("[TaskPenaltyCron] Owner yuklashda xato:", error);
  }

  cron.schedule(
    "0 * * * *",
    async () => {
      logger.info("[TaskPenaltyCron] Muddati o'tgan topshiriqlar tekshirilmoqda...");
      try {
        await runPenaltyPass(ownerUser);
      } catch (error) {
        logger.error("[TaskPenaltyCron] Cron xatosi:", error);
      }
    },
    {
      scheduled: true,
      timezone: "Asia/Tashkent",
    },
  );

  logger.info("Topshiriq jarima cron job belgilandi: Har soatda bir marta (Asia/Tashkent)");
}

module.exports = { startTaskPenaltyCron };
