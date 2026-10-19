const prisma = require("../config/prisma");
const { getCoinSettings } = require("../services/settings.service");
const { getCurrentWeekRange } = require("../helpers/statistics.helpers");
const { getNowInUzbekistan } = require("../helpers/date.helpers");
const { COIN_PERIOD_TYPES, earnedDelta } = require("../helpers/coin.helpers");
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
    where: { role: "student", isActive: true, isArchived: false },
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

/**
 * Haftalik bonus coinlarni tarqatadi — g'oliblar TO'G'RIDAN-TO'G'RI `grade`
 * jadvalidan hisoblanadi (WeeklyStats'ga tayanmaydi). Maktab #1 va har bir
 * sinf #1 bonusi beriladi. Idempotent (coinTransaction.meta orqali).
 * @param {{weekStart:Date, weekEnd:Date, weekNumber:number, year:number}} [range]
 */
async function distributeWeeklyBonusCoins(range) {
  const { weekStart, weekEnd, weekNumber, year } =
    range || getCurrentWeekRange();
  const settings = await getCoinSettings();
  const { schoolRankBonus, classRankBonus } = settings;

  // Barcha faol o'quvchilar + sinf a'zoliklari
  const students = await prisma.user.findMany({
    where: { role: "student", isActive: true, isArchived: false },
    select: { id: true, classes: { select: { classId: true } } },
  });

  if (!students.length) {
    logger.info(`[CoinService] No active students for week ${weekNumber}/${year}`);
    return;
  }

  // Haftalik baho yig'indilari (bitta GROUP BY)
  const sumRows = await prisma.grade.groupBy({
    by: ["studentId"],
    where: {
      studentId: { in: students.map((s) => s.id) },
      date: { gte: weekStart, lte: weekEnd },
    },
    _sum: { grade: true },
  });
  const sumById = new Map(sumRows.map((r) => [r.studentId, r._sum.grade || 0]));

  const withSums = students.map((s) => ({
    studentId: s.id,
    classIds: (s.classes || []).map((c) => c.classId),
    totalSum: sumById.get(s.id) || 0,
  }));

  // Eng yuqori ballli (birinchi uchragani — teng bo'lsa) ni topadi
  const topOf = (list) =>
    list.reduce(
      (best, s) => (s.totalSum > (best ? best.totalSum : -1) ? s : best),
      null,
    );

  // ── Maktab #1 bonusi ──
  const schoolTop = topOf(withSums);
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

  // ── Sinf #1 bonusi (bitta o'quvchi bir nechta sinfda bo'lsa ham faqat bir marta) ──
  const allClassIds = [...new Set(withSums.flatMap((s) => s.classIds))];
  const classDocs = await prisma.class.findMany({
    where: { id: { in: allClassIds } },
    select: { id: true, name: true },
  });
  const classNameById = new Map(classDocs.map((c) => [c.id, c.name]));

  const awardedForClassBonus = new Set();
  for (const classId of allClassIds) {
    const members = withSums.filter((s) => s.classIds.includes(classId));
    const classTop = topOf(members);

    if (
      classTop &&
      classTop.totalSum > 0 &&
      !awardedForClassBonus.has(classTop.studentId)
    ) {
      awardedForClassBonus.add(classTop.studentId);
      const className = classNameById.get(classId) || "Noma'lum sinf";

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
    // ⚠️ Filiallararo o'tkazma "tarqatilgan" emas: tanga boshqa filialda
    // berilgan va o'quvchi bilan ko'chgan (`branchTransfer.service.js`)
    prisma.coinTransaction.aggregate({
      where: { type: { not: "branch_transfer" } },
      _sum: { amount: true },
    }),
    prisma.user.aggregate({
      where: { isActive: true, isArchived: false },
      _sum: { coinBalance: true },
    }),
    prisma.user.count({ where: { role: "student", isActive: true, isArchived: false } }),
    prisma.user.findMany({
      where: { role: "student", isActive: true, isArchived: false },
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

// ─────────────────────────────────────────────
// DAVR KESIMIDAGI TANGA (ro'yxatdagi "haftalik" ko'rinish)
// ─────────────────────────────────────────────

/**
 * Ro'yxatlarda tanga qaysi kesimda ko'rsatilishi.
 *
 * `total` — `User.coinBalance`, ya'ni HOZIRGI qoldiq (sarflangani ayrilgan):
 * tizimning sukutdagi ko'rinishi. `week` — JORIY haftada TOPILGAN tanga.
 */
const COIN_PERIODS = Object.freeze({ TOTAL: "total", WEEK: "week" });

/**
 * TANGA HAFTASI — dushanba 00:00 dan YAKSHANBA 23:59:59.999 gacha.
 *
 * Hafta boshi reyting bilan AYNI (dushanba — `getCurrentWeekRange`).
 *
 * ⚠️ YAKSHANBA ATAYLAB ICHIDA. Haftalik maktab/sinf bonusi yakshanba
 * 00:01 da yoziladi (`weeklystats.job.js`) va u endigina tugagan haftaning
 * mukofoti. Oyna dushanba–shanba qilib olinsa, bonus O'ZI MUKOFOT BO'LGAN
 * haftaga ham, keyingisiga ham tushmay, hech qayerda ko'rinmay qolardi —
 * o'quvchining 100 tangasi izsiz yo'qolgandek bo'lardi.
 *
 * Joriy haftada bu oyna `getCurrentWeekRange()` (dushanba–bugun) bilan
 * AYNI natija beradi: kelajak sanali tanga qatori bo'lmaydi.
 *
 * @param {Date} anchor - hafta ichidagi istalgan kun
 * @returns {{from: Date, to: Date}}
 */
function weekBounds(anchor) {
  const dayOfWeek = anchor.getDay(); // 0 = yakshanba
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const from = new Date(anchor);
  from.setDate(anchor.getDate() - daysFromMonday);
  from.setHours(0, 0, 0, 0);

  const to = new Date(from);
  to.setDate(from.getDate() + 6);
  to.setHours(23, 59, 59, 999);

  return { from, to };
}

/**
 * Sanani "YYYY-MM-DD" kalendar kuniga aylantiradi (MAHALLIY — Toshkent).
 *
 * ⚠️ `toISOString()` UTC beradi: dushanba 00:00 Toshkent = yakshanba 19:00
 * UTC, ya'ni hafta boshi "yakshanba" bo'lib ko'rinardi.
 *
 * @param {Date} date
 * @returns {string}
 */
function toDayKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * "YYYY-MM-DD" ni MAHALLIY (Toshkent) kun sifatida o'qiydi.
 *
 * ⚠️ `new Date("2026-10-12")` UTC yarim tunini beradi — hafta chegarasi
 * esa mahalliy `getDay()`/`setHours` bilan hisoblanadi. Ikkisini
 * aralashtirish ba'zi kunlarda haftani bittaga surib yuborardi.
 *
 * @param {string} [value]
 * @returns {Date|null}
 */
function parseWeekAnchor(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;

  const [, year, month, day] = match.map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * So'rovdagi davrni haqiqiy oraliqqa aylantiradi.
 *
 * Noma'lum davr → `null`, ya'ni umumiy qoldiq ko'rinishi: xato yozilgan
 * so'rov parametri ro'yxatni yiqitmasligi kerak.
 *
 * ⚠️ KELAJAK HAFTA BERILMAYDI — joriy haftaga qaytariladi: u yerda hali
 * birorta tanga yo'q va bo'sh ekran "tizim ishlamayapti" bo'lib ko'rinardi
 * (o'quvchi ekranidagi "kelgusi oylar ro'yxatga kirmaydi" bilan AYNI
 * mulohaza, `education.md` §1).
 *
 * ⚠️ QO'SHNI HAFTALARNING LANGARI HAM SHU YERDA hisoblanadi (`prevWeek` /
 * `nextWeek`) va kunlar "YYYY-MM-DD" ko'rinishida qaytadi. Panel sanaga
 * umuman tegmasligi uchun: brauzer boshqa vaqt mintaqasida bo'lsa,
 * instantdan kun olish haftani bir kunga — demak navigator bir haftaga —
 * surib yuborardi.
 *
 * @param {string} [period] - hozircha faqat `week`
 * @param {string} [weekAnchor] - "YYYY-MM-DD", hafta ichidagi istalgan kun
 * @returns {{period: string, from: Date, to: Date, fromDay: string,
 *   toDay: string, prevWeek: string, nextWeek: string|null,
 *   isCurrent: boolean}|null}
 */
function resolveCoinPeriod(period, weekAnchor) {
  if (period !== COIN_PERIODS.WEEK) return null;

  const current = weekBounds(getNowInUzbekistan());
  const anchor = parseWeekAnchor(weekAnchor);
  const picked = anchor ? weekBounds(anchor) : current;

  const isFuture = picked.from.getTime() > current.from.getTime();
  const range = isFuture ? current : picked;
  const isCurrent = range.from.getTime() === current.from.getTime();

  const prev = new Date(range.from);
  prev.setDate(prev.getDate() - 7);
  const next = new Date(range.from);
  next.setDate(next.getDate() + 7);

  return {
    period: COIN_PERIODS.WEEK,
    ...range,
    fromDay: toDayKey(range.from),
    toDay: toDayKey(range.to),
    prevWeek: toDayKey(prev),
    // Joriy haftada "keyingi" YO'Q — kelajakda hali tanga yo'q
    nextWeek: isCurrent ? null : toDayKey(next),
    isCurrent,
  };
}

/**
 * Berilgan o'quvchilar uchun davr ichida TOPILGAN tanga.
 *
 * ⚠️ Yo'nalish TURDAN olinadi (`coin.helpers.js`): summa bazada musbat
 * yotgani uchun oddiy `_sum: { amount }` do'kon xaridini ham kirim deb
 * sanab yuborardi. Shuning uchun guruhlash `(studentId, type)` bo'yicha —
 * bitta so'rov, yo'nalish esa JS tomonda qo'llanadi.
 *
 * ⚠️ Faqat RO'YXATDAGI o'quvchilar uchun chaqiriladi (bitta sahifa): shart
 * `studentId IN (...)` + `date` oralig'i bo'lgani uchun u
 * `(student_id, date)` indeksiga tushadi.
 *
 * @param {string[]} studentIds
 * @param {{from: Date, to: Date}} range
 * @returns {Promise<Map<string, number>>} har o'quvchi uchun summa (0 ham)
 */
async function getEarnedCoinsByStudents(studentIds, { from, to }) {
  const ids = [...new Set((studentIds || []).filter(Boolean))];
  const totals = new Map(ids.map((id) => [id, 0]));
  if (!ids.length) return totals;

  const rows = await prisma.coinTransaction.groupBy({
    by: ["studentId", "type"],
    where: {
      studentId: { in: ids },
      type: { in: [...COIN_PERIOD_TYPES] },
      date: { gte: from, lte: to },
    },
    _sum: { amount: true },
  });

  for (const row of rows) {
    const current = totals.get(row.studentId) ?? 0;
    totals.set(row.studentId, current + earnedDelta(row.type, row._sum.amount));
  }

  return totals;
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
  // Arxivlangan — tizimdan chiqqan: unga tanga ham, "hammaga" ro'yxati ham yo'q
  const where = { isActive: true, isArchived: false };

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
      where: { role: "student", isActive: true, isArchived: false },
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
    prisma.user.count({ where: { role: "student", isActive: true, isArchived: false } }),
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
  COIN_PERIODS,
  resolveCoinPeriod,
  getEarnedCoinsByStudents,
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
