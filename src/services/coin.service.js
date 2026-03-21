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
  if (updates.minDailyGradeForCoin !== undefined)
    settings.minDailyGradeForCoin = updates.minDailyGradeForCoin;
  settings.updatedBy = updatedBy;
  return settings.save();
}

// ─────────────────────────────────────────────
// DAILY DISTRIBUTION
// ─────────────────────────────────────────────

async function distributeDailyCoins(targetDate) {
  const settings = await CoinSettings.getSettings();
  const { dailyCoinPercentage, minDailyGradeForCoin } = settings;

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

      if (dailyGradeSum < minDailyGradeForCoin) {
        skippedCount++;
        continue;
      }

      const coinAmount = Math.floor(
        (dailyGradeSum * dailyCoinPercentage) / 100,
      );

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

      await _updateDailyCoinStat(coinAmount, startOfDay);

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

  await _updateDailyCoinStat(amount, new Date());
}

// ─────────────────────────────────────────────
// STATISTIKA
// ─────────────────────────────────────────────

async function getCoinStats() {
  const DailyCoinStat = require("../models/dailyCoinStat.model");

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
  thirtyDaysAgo.setHours(0, 0, 0, 0);

  const [totalDistributed, totalStudents, topEarners, dailyStats] =
    await Promise.all([
      CoinTransaction.aggregate([
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      User.countDocuments({ role: "student", isActive: true }),
      User.find({ role: "student", isActive: true })
        .sort({ coinBalance: -1 })
        .limit(10)
        .select("firstName lastName coinBalance classes")
        .populate("classes", "name"),
      DailyCoinStat.find({ date: { $gte: thirtyDaysAgo } })
        .sort({ date: 1 })
        .lean(),
    ]);

  const mapStats = new Map(
    dailyStats.map((stat) => [
      stat.date.toISOString().split("T")[0],
      stat.totalDistributed,
    ]),
  );
  const dailyDistributionFormatted = [];

  for (let i = 0; i <= 29; i++) {
    const iterDate = new Date();
    iterDate.setDate(new Date().getDate() - (29 - i));
    iterDate.setHours(0, 0, 0, 0);
    const dateStr = iterDate.toISOString().split("T")[0];

    dailyDistributionFormatted.push({
      date: dateStr,
      totalDistributed: mapStats.get(dateStr) || 0,
    });
  }

  return {
    totalCoinsDistributed: totalDistributed[0]?.total || 0,
    totalStudents,
    topEarners,
    dailyDistribution: dailyDistributionFormatted,
  };
}

async function _updateDailyCoinStat(amount, date = new Date()) {
  if (amount <= 0) return;
  const DailyCoinStat = require("../models/dailyCoinStat.model");

  const targetDate = new Date(date);
  targetDate.setHours(0, 0, 0, 0);

  await DailyCoinStat.findOneAndUpdate(
    { date: targetDate },
    { $inc: { totalDistributed: amount } },
    { upsert: true, new: true },
  );
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

// ─────────────────────────────────────────────
// QO'LDA TANGA TARQATISH / OLISH
// ─────────────────────────────────────────────

/**
 * filterType va filterValue asosida MongoDB query quradi.
 * @param {string} filterType - "role" | "class" | "gender" | "individual"
 * @param {string} filterValue - filter qiymati
 * @returns {object} MongoDB query
 */
function _buildFilterQuery(filterType, filterValue) {
  const query = { isActive: true };

  switch (filterType) {
    case "role":
      query.role = filterValue;
      break;
    case "class":
      query.classes = filterValue;
      break;
    case "gender":
      query.gender = filterValue;
      break;
    case "individual":
      query._id = filterValue;
      break;
    default:
      throw new Error("Noto'g'ri filter turi");
  }

  return query;
}

/**
 * Filtrlangan foydalanuvchilar ro'yxatini oldindan ko'rish (preview).
 * @param {string} filterType - "role" | "class" | "gender" | "individual"
 * @param {string} filterValue - filter qiymati
 * @returns {Promise<{users: Array, totalCount: number}>}
 */
async function getFilteredUsersPreview(filterType, filterValue) {
  const query = _buildFilterQuery(filterType, filterValue);

  const [users, totalCount] = await Promise.all([
    User.find(query)
      .select("firstName lastName username coinBalance role gender classes")
      .populate("classes", "name")
      .sort({ firstName: 1 })
      .limit(100)
      .lean(),
    User.countDocuments(query),
  ]);

  return { users, totalCount };
}

/**
 * Owner tomonidan qo'lda tanga berish yoki olish.
 * @param {object} params
 * @param {"give"|"take"} params.action - berish yoki olish
 * @param {number} params.amount - miqdor (musbat son)
 * @param {string} params.reason - sabab
 * @param {string} params.filterType - "role" | "class" | "gender" | "individual"
 * @param {string} params.filterValue - filter qiymati
 * @param {string} params.givenBy - owner user ID
 * @returns {Promise<{successCount: number, skippedCount: number, errorCount: number, totalFound: number}>}
 */
async function distributeManualCoins({
  action,
  amount,
  reason,
  filterType,
  filterValue,
  givenBy,
}) {
  const query = _buildFilterQuery(filterType, filterValue);
  const users = await User.find(query).select("_id coinBalance");

  const totalFound = users.length;
  let successCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  const type = action === "give" ? "manual_give" : "manual_take";

  for (const user of users) {
    try {
      let updatedUser;

      if (action === "give") {
        updatedUser = await User.findByIdAndUpdate(
          user._id,
          { $inc: { coinBalance: amount } },
          { new: true },
        );
      } else {
        updatedUser = await User.findOneAndUpdate(
          { _id: user._id, coinBalance: { $gte: amount } },
          { $inc: { coinBalance: -amount } },
          { new: true },
        );

        if (!updatedUser) {
          skippedCount++;
          continue;
        }
      }

      await CoinTransaction.create({
        student: user._id,
        amount,
        type,
        description: reason,
        balanceAfter: updatedUser.coinBalance,
        meta: {
          givenBy,
          reason,
          filterType,
          filterValue,
        },
        date: new Date(),
      });

      if (action === "give") {
        await _updateDailyCoinStat(amount, new Date());
      }

      successCount++;
    } catch (err) {
      logger.error(
        `[CoinService] Manual ${action} error for user ${user._id}: ${err.message}`,
      );
      errorCount++;
    }
  }

  logger.info(
    `[CoinService] Manual ${action}: ${successCount} success, ${skippedCount} skipped, ${errorCount} errors (total: ${totalFound})`,
  );

  return { successCount, skippedCount, errorCount, totalFound };
}

module.exports = {
  getSettings,
  updateSettings,
  distributeDailyCoins,
  distributeWeeklyBonusCoins,
  getCoinStats,
  getStudentTransactions,
  getFilteredUsersPreview,
  distributeManualCoins,
};
