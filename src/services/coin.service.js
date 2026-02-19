const User = require("../models/user.model");
const Grade = require("../models/grade.model");
const WeeklyStats = require("../models/weeklystats.model");
const CoinSettings = require("../models/coinSettings.model");
const CoinTransaction = require("../models/coinTransaction.model");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────

async function getSettings() {
  return CoinSettings.getSettings();
}

async function updateSettings(updates, updatedBy) {
  const settings = await CoinSettings.getSettings();
  if (updates.dailyCoinPercentage !== undefined)
    settings.dailyCoinPercentage = updates.dailyCoinPercentage;
  if (updates.schoolRankBonus !== undefined)
    settings.schoolRankBonus = updates.schoolRankBonus;
  if (updates.classRankBonus !== undefined)
    settings.classRankBonus = updates.classRankBonus;
  settings.updatedBy = updatedBy;
  return settings.save();
}

// ─────────────────────────────────────────────
// DAILY DISTRIBUTION
// ─────────────────────────────────────────────

async function distributeDailyCoins(targetDate) {
  const settings = await CoinSettings.getSettings();
  const { dailyCoinPercentage } = settings;

  const date = targetDate || new Date();

  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const students = await User.find({ role: "student", isActive: true });

  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  for (const student of students) {
    try {
      const alreadyDistributed = await CoinTransaction.findOne({
        student: student._id,
        type: "daily",
        date: { $gte: startOfDay, $lte: endOfDay },
      });

      if (alreadyDistributed) {
        skippedCount++;
        continue;
      }

      const grades = await Grade.find({
        student: student._id,
        date: { $gte: startOfDay, $lte: endOfDay },
      });

      if (grades.length === 0) {
        skippedCount++;
        continue;
      }

      const dailyGradeSum = grades.reduce((sum, g) => sum + g.grade, 0);
      const coinAmount = Math.floor((dailyGradeSum * dailyCoinPercentage) / 100);

      if (coinAmount <= 0) {
        skippedCount++;
        continue;
      }

      const updatedUser = await User.findByIdAndUpdate(
        student._id,
        { $inc: { coinBalance: coinAmount } },
        { new: true },
      );

      const description = `Kunlik baho uchun: ${dailyGradeSum} ball × ${dailyCoinPercentage}% = ${coinAmount} coin`;

      await CoinTransaction.create({
        student: student._id,
        amount: coinAmount,
        type: "daily",
        description,
        balanceAfter: updatedUser.coinBalance,
        meta: {
          dailyGradeSum,
          coinPercentage: dailyCoinPercentage,
        },
        date: startOfDay,
      });

      successCount++;
    } catch (err) {
      logger.error(
        `[CoinService] Daily coin error for student ${student._id}: ${err.message}`,
      );
      errorCount++;
    }
  }

  logger.info(
    `[CoinService] Daily distribution: ${successCount} success, ${skippedCount} skipped, ${errorCount} errors`,
  );
  return { successCount, skippedCount, errorCount };
}

// ─────────────────────────────────────────────
// WEEKLY BONUS DISTRIBUTION
// ─────────────────────────────────────────────

async function distributeWeeklyBonusCoins(weekNumber, year) {
  const settings = await CoinSettings.getSettings();
  const { schoolRankBonus, classRankBonus } = settings;

  const allStats = await WeeklyStats.find({ weekNumber, year }).populate(
    "student classes",
  );

  if (!allStats.length) {
    logger.info(
      `[CoinService] No weekly stats found for week ${weekNumber}/${year}`,
    );
    return;
  }

  // ── Maktab #1 bonusi ──
  const sortedBySchool = [...allStats].sort(
    (a, b) => b.simpleStats.totalSum - a.simpleStats.totalSum,
  );

  const schoolTop = sortedBySchool[0];
  if (schoolTop && schoolTop.simpleStats.totalSum > 0) {
    await _awardBonus({
      studentId: schoolTop.student._id,
      amount: schoolRankBonus,
      type: "weekly_school_bonus",
      description: "Haftalik maktab reytingida 1-o'rin bonusi",
      weekNumber,
      year,
    });
  }

  // ── Sinf #1 bonusi (faqat bitta, nechta sinfda bo'lsa ham) ──
  const allClassIds = new Set();
  allStats.forEach((stat) => {
    (stat.classes || []).forEach((cls) => allClassIds.add(cls._id.toString()));
  });

  const awardedForClassBonus = new Set();

  for (const classId of allClassIds) {
    const classStats = allStats
      .filter((stat) =>
        (stat.classes || []).some((c) => c._id.toString() === classId),
      )
      .sort((a, b) => b.simpleStats.totalSum - a.simpleStats.totalSum);

    if (!classStats.length) continue;

    const classTop = classStats[0];
    const studentIdStr = classTop.student._id.toString();

    if (
      classTop.simpleStats.totalSum > 0 &&
      !awardedForClassBonus.has(studentIdStr)
    ) {
      awardedForClassBonus.add(studentIdStr);

      const classObj = (classTop.classes || []).find(
        (c) => c._id.toString() === classId,
      );
      const className = classObj?.name || "Noma'lum sinf";

      await _awardBonus({
        studentId: classTop.student._id,
        amount: classRankBonus,
        type: "weekly_class_bonus",
        description: `Haftalik sinf reytingida 1-o'rin bonusi (${className} sinfi)`,
        weekNumber,
        year,
        classId,
        className,
      });
    }
  }

  logger.info(
    `[CoinService] Weekly bonuses distributed for week ${weekNumber}/${year}`,
  );
}

async function _awardBonus({
  studentId,
  amount,
  type,
  description,
  weekNumber,
  year,
  classId,
  className,
}) {
  const query = {
    student: studentId,
    type,
    "meta.weekNumber": weekNumber,
    "meta.year": year,
  };
  if (classId) query["meta.classId"] = classId;

  const alreadyAwarded = await CoinTransaction.findOne(query);

  if (alreadyAwarded) {
    logger.info(
      `[CoinService] Bonus already awarded: ${type} for student ${studentId}, week ${weekNumber}`,
    );
    return;
  }

  const updatedUser = await User.findByIdAndUpdate(
    studentId,
    { $inc: { coinBalance: amount } },
    { new: true },
  );

  await CoinTransaction.create({
    student: studentId,
    amount,
    type,
    description,
    balanceAfter: updatedUser.coinBalance,
    meta: {
      weekNumber,
      year,
      ...(classId && { classId, className }),
    },
    date: new Date(),
  });
}

// ─────────────────────────────────────────────
// STATISTIKA
// ─────────────────────────────────────────────

async function getCoinStats() {
  const [totalDistributed, totalStudents, topEarners] = await Promise.all([
    CoinTransaction.aggregate([
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    User.countDocuments({ role: "student", isActive: true }),
    User.find({ role: "student", isActive: true })
      .sort({ coinBalance: -1 })
      .limit(10)
      .select("firstName lastName coinBalance classes")
      .populate("classes", "name"),
  ]);

  return {
    totalCoinsDistributed: totalDistributed[0]?.total || 0,
    totalStudents,
    topEarners,
  };
}

async function getStudentTransactions(studentId, page = 1, limit = 20) {
  const skip = (page - 1) * limit;

  const [transactions, total] = await Promise.all([
    CoinTransaction.find({ student: studentId })
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    CoinTransaction.countDocuments({ student: studentId }),
  ]);

  return {
    transactions,
    pagination: {
      page,
      limit,
      totalItems: total,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPrevPage: page > 1,
    },
  };
}

module.exports = {
  getSettings,
  updateSettings,
  distributeDailyCoins,
  distributeWeeklyBonusCoins,
  getCoinStats,
  getStudentTransactions,
};
