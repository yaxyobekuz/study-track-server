const cron = require("node-cron");
const Task = require("../models/task.model");
const Penalty = require("../models/penalty.model");
const User = require("../models/user.model");
const logger = require("../utils/logger");

async function runPenaltyPass(ownerUser) {
  if (!ownerUser) {
    logger.warn("[TaskPenaltyCron] Owner foydalanuvchi topilmadi, o'tkazib yuborildi");
    return;
  }

  const now = new Date();

  const tasks = await Task.find({
    dueDate: { $lt: now },
    status: { $nin: ["completed", "pending_review", "stopped"] },
    autopenalized: false,
  });

  if (tasks.length === 0) {
    logger.info("[TaskPenaltyCron] Jarima qo'llash uchun topshiriq topilmadi");
    return;
  }

  let penalized = 0;
  let errors = 0;

  for (const task of tasks) {
    try {
      const penalty = await Penalty.create({
        user: task.assignee,
        givenBy: ownerUser._id,
        title: `Topshiriq muddati o'tdi: ${task.title}`,
        description: "Muddati o'tganligi sababli avtomatik jarima",
        points: task.penaltyPoints,
        status: "approved",
        isCustom: true,
        reviewedBy: ownerUser._id,
        reviewedAt: now,
      });

      await User.findByIdAndUpdate(task.assignee, {
        $inc: { penaltyPoints: task.penaltyPoints },
      });

      task.autopenalized = true;
      task.penaltyRef = penalty._id;
      task.statusHistory.push({
        status: task.status,
        reason: "Muddati o'tganligi sababli avtomatik jarima qo'llanildi",
        changedBy: ownerUser._id,
        changedAt: now,
      });

      await task.save();
      penalized++;
    } catch (error) {
      errors++;
      logger.error(`[TaskPenaltyCron] Task ${task._id} ga jarima qo'llashda xato:`, error);
    }
  }

  logger.info(
    `[TaskPenaltyCron] Tugadi: ${penalized} ta topshiriqqa jarima qo'llanildi, ${errors} ta xato`,
  );
}

async function startTaskPenaltyCron() {
  let ownerUser;

  try {
    ownerUser = await User.findOne({ role: "owner" }).select("_id");
    if (!ownerUser) {
      logger.warn("[TaskPenaltyCron] Owner topilmadi — cron ishlaydi lekin jarimalar qo'llanilmaydi");
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
