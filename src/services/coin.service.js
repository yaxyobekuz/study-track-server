const prisma = require("../config/prisma");
const { getCoinSettings } = require("../services/settings.service");
const logger = require("../utils/logger");

// ─────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────

async function getSettings() {
  return getCoinSettings();
}

async function updateSettings(updates, updatedBy) {
  const data = {};
  if (updates.dailyCoinPercentage !== undefined)
    data.dailyCoinPercentage = updates.dailyCoinPercentage;
  if (updates.schoolRankBonus !== undefined)
    data.schoolRankBonus = updates.schoolRankBonus;
  if (updates.classRankBonus !== undefined)
    data.classRankBonus = updates.classRankBonus;
  if (updates.minDailyGradeForCoin !== undefined)
    data.minDailyGradeForCoin = updates.minDailyGradeForCoin;
  data.updatedBy = updatedBy;

  return prisma.coinSettings.update({
    where: { id: "singleton" },
    data,
  });
}

// ─────────────────────────────────────────────
// DAILY DISTRIBUTION
// ─────────────────────────────────────────────

async function distributeDailyCoins(targetDate) {
  const settings = await getCoinSettings();
  const { dailyCoinPercentage, minDailyGradeForCoin } = settings;

  const date = targetDate || new Date();

  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  // 1. Get all active students
  const students = await prisma.user.findMany({
    where: { role: "student", isActive: true },
    select: { id: true, coinBalance: true },
  });

  if (students.length === 0) {
    return { successCount: 0, skippedCount: 0, errorCount: 0 };
  }

  const studentIds = students.map((s) => s.id);

  // 2. Batch: find students who already received daily coins today
  const alreadyRows = await prisma.coinTransaction.findMany({
    where: {
      studentId: { in: studentIds },
      type: "daily",
      date: { gte: startOfDay, lte: endOfDay },
    },
    distinct: ["studentId"],
    select: { studentId: true },
  });

  const alreadySet = new Set(alreadyRows.map((r) => r.studentId));

  // 3. Batch: aggregate daily grade sums for all students
  const gradeAgg = await prisma.grade.groupBy({
    by: ["studentId"],
    where: {
      studentId: { in: studentIds },
      date: { gte: startOfDay, lte: endOfDay },
    },
    _sum: { grade: true },
  });

  const gradeMap = new Map();
  for (const item of gradeAgg) {
    gradeMap.set(item.studentId, item._sum.grade);
  }

  // 4. Calculate eligible students and coin amounts
  const balanceMap = new Map(
    students.map((s) => [s.id, s.coinBalance || 0]),
  );

  const balanceUpdates = [];
  const transactions = [];
  let successCount = 0;
  let skippedCount = 0;
  let totalCoins = 0;

  for (const student of students) {
    const sid = student.id;

    if (alreadySet.has(sid)) {
      skippedCount++;
      continue;
    }

    const dailyGradeSum = gradeMap.get(sid);

    if (!dailyGradeSum || dailyGradeSum < minDailyGradeForCoin) {
      skippedCount++;
      continue;
    }

    const coinAmount = Math.floor((dailyGradeSum * dailyCoinPercentage) / 100);

    if (coinAmount <= 0) {
      skippedCount++;
      continue;
    }

    const newBalance = (balanceMap.get(sid) || 0) + coinAmount;

    balanceUpdates.push({ studentId: student.id, coinAmount });

    transactions.push({
      studentId: student.id,
      amount: coinAmount,
      type: "daily",
      description: `Kunlik baho uchun: ${dailyGradeSum} ball × ${dailyCoinPercentage}% = ${coinAmount} coin`,
      balanceAfter: newBalance,
      meta: {
        dailyGradeSum,
        coinPercentage: dailyCoinPercentage,
      },
      date: startOfDay,
    });

    totalCoins += coinAmount;
    successCount++;
  }

  // 5. Batch write: update balances and insert transactions
  let errorCount = 0;

  if (balanceUpdates.length > 0) {
    try {
      await prisma.$transaction([
        ...balanceUpdates.map((op) =>
          prisma.user.update({
            where: { id: op.studentId },
            data: { coinBalance: { increment: op.coinAmount } },
          }),
        ),
        prisma.coinTransaction.createMany({ data: transactions }),
      ]);
      await _updateDailyCoinStat(totalCoins, startOfDay);
    } catch (err) {
      logger.error(`[CoinService] Daily batch write error: ${err.message}`);
      errorCount = successCount;
      successCount = 0;
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
  const settings = await getCoinSettings();
  const { schoolRankBonus, classRankBonus } = settings;

  const allStats = await prisma.weeklyStats.findMany({
    where: { weekNumber, year },
    include: {
      classes: { include: { class: { select: { id: true, name: true } } } },
    },
  });

  if (!allStats.length) {
    logger.info(
      `[CoinService] No weekly stats found for week ${weekNumber}/${year}`,
    );
    return;
  }

  // `student` — scalar String (user ID), `classes` — junction → cls.class
  const normalized = allStats.map((stat) => ({
    ...stat,
    studentId: stat.student,
    classList: (stat.classes || []).map((uc) => uc.class),
  }));

  // ── Maktab #1 bonusi ──
  const sortedBySchool = [...normalized].sort(
    (a, b) => b.totalSum - a.totalSum,
  );

  const schoolTop = sortedBySchool[0];
  if (schoolTop && schoolTop.totalSum > 0) {
    await _awardBonus({
      studentId: schoolTop.studentId,
      amount: schoolRankBonus,
      type: "weekly_school_bonus",
      description: "Haftalik maktab reytingida 1-o'rin bonusi",
      weekNumber,
      year,
    });
  }

  // ── Sinf #1 bonusi (faqat bitta, nechta sinfda bo'lsa ham) ──
  const allClassIds = new Set();
  normalized.forEach((stat) => {
    (stat.classList || []).forEach((cls) => allClassIds.add(cls.id));
  });

  const awardedForClassBonus = new Set();

  for (const classId of allClassIds) {
    const classStats = normalized
      .filter((stat) =>
        (stat.classList || []).some((c) => c.id === classId),
      )
      .sort((a, b) => b.totalSum - a.totalSum);

    if (!classStats.length) continue;

    const classTop = classStats[0];
    const studentIdStr = classTop.studentId;

    if (classTop.totalSum > 0 && !awardedForClassBonus.has(studentIdStr)) {
      awardedForClassBonus.add(studentIdStr);

      const classObj = (classTop.classList || []).find(
        (c) => c.id === classId,
      );
      const className = classObj?.name || "Noma'lum sinf";

      await _awardBonus({
        studentId: classTop.studentId,
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
  const metaFilters = [
    { meta: { path: ["weekNumber"], equals: weekNumber } },
    { meta: { path: ["year"], equals: year } },
  ];
  if (classId) {
    metaFilters.push({ meta: { path: ["classId"], equals: classId } });
  }

  const alreadyAwarded = await prisma.coinTransaction.findFirst({
    where: {
      studentId,
      type,
      AND: metaFilters,
    },
  });

  if (alreadyAwarded) {
    logger.info(
      `[CoinService] Bonus already awarded: ${type} for student ${studentId}, week ${weekNumber}`,
    );
    return;
  }

  const updatedUser = await prisma.user.update({
    where: { id: studentId },
    data: { coinBalance: { increment: amount } },
  });

  await prisma.coinTransaction.create({
    data: {
      studentId,
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
    },
  });

  await _updateDailyCoinStat(amount, new Date());
}

// ─────────────────────────────────────────────
// STATISTIKA
// ─────────────────────────────────────────────

async function getCoinStats() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
  thirtyDaysAgo.setHours(0, 0, 0, 0);

  const [
    totalDistributedAgg,
    availableCoinsAgg,
    totalStudents,
    topEarners,
    dailyStats,
  ] = await Promise.all([
    prisma.coinTransaction.aggregate({ _sum: { amount: true } }),
    prisma.user.aggregate({
      where: { isActive: true },
      _sum: { coinBalance: true },
    }),
    prisma.user.count({ where: { role: "student", isActive: true } }),
    prisma.user.findMany({
      where: { role: "student", isActive: true },
      orderBy: { coinBalance: "desc" },
      take: 10,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        coinBalance: true,
        classes: { include: { class: { select: { id: true, name: true } } } },
      },
    }),
    prisma.dailyCoinStat.findMany({
      where: { date: { gte: thirtyDaysAgo } },
      orderBy: { date: "asc" },
    }),
  ]);

  // classes junction'ni eski `classes: [{ name }]` shakliga tekislaymiz
  const topEarnersFlat = topEarners.map((u) => ({
    ...u,
    fullName: u.lastName ? `${u.firstName} ${u.lastName}` : u.firstName,
    classes: (u.classes || []).map((uc) => uc.class),
  }));

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
    totalCoinsDistributed: totalDistributedAgg._sum.amount || 0,
    availableCoins: availableCoinsAgg._sum.coinBalance || 0,
    totalStudents,
    topEarners: topEarnersFlat,
    dailyDistribution: dailyDistributionFormatted,
  };
}

async function _updateDailyCoinStat(amount, date = new Date()) {
  if (amount <= 0) return;

  const targetDate = new Date(date);
  targetDate.setHours(0, 0, 0, 0);

  await prisma.dailyCoinStat.upsert({
    where: { date: targetDate },
    create: { date: targetDate, totalDistributed: amount },
    update: { totalDistributed: { increment: amount } },
  });
}

async function getStudentTransactions(studentId, page = 1, limit = 20) {
  const skip = (page - 1) * limit;

  const [transactions, total] = await Promise.all([
    prisma.coinTransaction.findMany({
      where: { studentId },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    prisma.coinTransaction.count({ where: { studentId } }),
  ]);

  return {
    transactions,
    pagination: {
      page,
      limit,
      total,
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
 * filterType va filterValue asosida Prisma where quradi.
 * @param {string} filterType - "role" | "class" | "gender" | "individual"
 * @param {string} filterValue - filter qiymati
 * @returns {object} Prisma where
 */
function _buildFilterQuery(filterType, filterValue) {
  const where = { isActive: true };

  switch (filterType) {
    case "role":
      where.role = filterValue;
      break;
    case "class":
      where.classes = { some: { classId: filterValue } };
      break;
    case "gender":
      where.gender = filterValue;
      break;
    case "individual":
      where.id = filterValue;
      break;
    default:
      throw new Error("Noto'g'ri filter turi");
  }

  return where;
}

/**
 * Filtrlangan foydalanuvchilar ro'yxatini oldindan ko'rish (preview).
 * @param {string} filterType - "role" | "class" | "gender" | "individual"
 * @param {string} filterValue - filter qiymati
 * @returns {Promise<{users: Array, totalCount: number}>}
 */
async function getFilteredUsersPreview(filterType, filterValue) {
  const where = _buildFilterQuery(filterType, filterValue);

  const [users, totalCount] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        username: true,
        coinBalance: true,
        role: true,
        gender: true,
        classes: { include: { class: { select: { id: true, name: true } } } },
      },
      orderBy: { firstName: "asc" },
      take: 100,
    }),
    prisma.user.count({ where }),
  ]);

  const usersFlat = users.map((u) => ({
    ...u,
    classes: (u.classes || []).map((uc) => uc.class),
  }));

  return { users: usersFlat, totalCount };
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
  const where = _buildFilterQuery(filterType, filterValue);
  const users = await prisma.user.findMany({
    where,
    select: { id: true, coinBalance: true },
  });

  const totalFound = users.length;
  const type = action === "give" ? "manual_give" : "manual_take";
  const now = new Date();

  if (totalFound === 0) {
    return { successCount: 0, skippedCount: 0, errorCount: 0, totalFound: 0 };
  }

  let balanceUpdates = [];
  let transactions = [];
  let skippedCount = 0;

  for (const user of users) {
    const currentBalance = user.coinBalance || 0;

    if (action === "take" && currentBalance < amount) {
      skippedCount++;
      continue;
    }

    const delta = action === "give" ? amount : -amount;
    const newBalance = currentBalance + delta;

    balanceUpdates.push({
      // take'da atomik shart: balans yetarli bo'lgandagina yangilanadi
      where:
        action === "take"
          ? { id: user.id, coinBalance: { gte: amount } }
          : { id: user.id },
      delta,
    });

    transactions.push({
      studentId: user.id,
      amount,
      type,
      description: reason,
      balanceAfter: newBalance,
      meta: {
        givenBy,
        reason,
        filterType,
        filterValue,
      },
      date: now,
    });
  }

  let successCount = 0;
  let errorCount = 0;

  if (balanceUpdates.length > 0) {
    try {
      const results = await prisma.$transaction([
        ...balanceUpdates.map((op) =>
          prisma.user.updateMany({
            where: op.where,
            data: { coinBalance: { increment: op.delta } },
          }),
        ),
        prisma.coinTransaction.createMany({ data: transactions }),
      ]);

      // updateMany natijalaridan haqiqiy modifiedCount (createMany oxirgi element)
      const modifiedCount = results
        .slice(0, balanceUpdates.length)
        .reduce((sum, r) => sum + (r.count || 0), 0);

      successCount = modifiedCount || balanceUpdates.length;

      if (action === "give") {
        await _updateDailyCoinStat(amount * successCount, now);
      }
    } catch (err) {
      logger.error(
        `[CoinService] Manual ${action} batch error: ${err.message}`,
      );
      errorCount = balanceUpdates.length;
    }
  }

  logger.info(
    `[CoinService] Manual ${action}: ${successCount} success, ${skippedCount} skipped, ${errorCount} errors (total: ${totalFound})`,
  );

  return { successCount, skippedCount, errorCount, totalFound };
}

async function getCoinLeaderboard(page = 1, limit = 50) {
  const skip = (page - 1) * limit;

  const [students, total] = await Promise.all([
    prisma.user.findMany({
      where: { role: "student", isActive: true },
      orderBy: { coinBalance: "desc" },
      skip,
      take: limit,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        coinBalance: true,
        premiumIsActive: true,
        premiumExpiresAt: true,
        displayName: true,
        nameColor: true,
        emojiBadgeId: true,
        classes: { include: { class: { select: { id: true, name: true } } } },
        profileImage: { select: { variants: true } },
      },
    }),
    prisma.user.count({ where: { role: "student", isActive: true } }),
  ]);

  const ranked = students.map((student, i) => {
    const classes = (student.classes || []).map((uc) => uc.class);
    const variants = student.profileImage?.variants;
    return {
      rank: skip + i + 1,
      student: {
        ...student,
        classes,
        profilePictureUrl: variants?.sm?.url || null,
      },
    };
  });

  return {
    rankings: ranked,
    pagination: {
      page,
      limit,
      total,
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
  getFilteredUsersPreview,
  distributeManualCoins,
  getCoinLeaderboard,
};
