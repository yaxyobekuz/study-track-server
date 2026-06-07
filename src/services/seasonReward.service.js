const mongoose = require("mongoose");
const TestSeason = require("../models/testSeason.model");
const TestResult = require("../models/testResult.model");
const TestBinding = require("../models/testBinding.model");
const TeacherAssignment = require("../models/teacherAssignment.model");
const User = require("../models/user.model");
const Class = require("../models/class.model");
const CoinTransaction = require("../models/coinTransaction.model");
const logger = require("../utils/logger");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");

/**
 * Mavsumdagi o'quvchilar statistikasini hisoblaydi.
 * Stat metrikasi: barcha test natijalari (`finalScore`) yig'indisi.
 *
 * @param {string} seasonId
 * @param {object} [filter] - { classId, subjectId } (ixtiyoriy filterlar)
 * @returns {Promise<Array>} sorted array: { student, totalScore, resultCount, classes, rank }
 */
async function getSeasonStats(seasonId, filter = {}) {
  const season = await TestSeason.findById(seasonId);
  if (!season) throw new NotFoundError("Mavsum topilmadi");

  const match = { season: new mongoose.Types.ObjectId(seasonId) };
  if (filter.subjectId) {
    match.subject = new mongoose.Types.ObjectId(filter.subjectId);
  }

  // O'quvchi bo'yicha agregat
  const grouped = await TestResult.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$student",
        totalScore: { $sum: "$finalScore" },
        resultCount: { $sum: 1 },
      },
    },
    { $sort: { totalScore: -1 } },
  ]);

  // O'quvchi ma'lumotlarini olib kelish
  const studentIds = grouped.map((g) => g._id);
  let users = await User.find({ _id: { $in: studentIds } })
    .select("firstName lastName username classes")
    .populate("classes", "name");

  // Sinf filtri
  if (filter.classId) {
    const cid = filter.classId.toString();
    users = users.filter((u) =>
      (u.classes || []).some((c) => c._id.toString() === cid),
    );
  }
  const userMap = new Map(users.map((u) => [u._id.toString(), u]));

  // Yakuniy ro'yxat
  let rows = grouped
    .filter((g) => userMap.has(g._id.toString()))
    .map((g) => {
      const u = userMap.get(g._id.toString());
      return {
        student: {
          _id: u._id,
          firstName: u.firstName,
          lastName: u.lastName,
          username: u.username,
          classes: u.classes,
        },
        totalScore: g.totalScore,
        resultCount: g.resultCount,
      };
    });

  // Rank (umumiy)
  rows = rows.map((r, idx) => ({ ...r, rank: idx + 1 }));

  return rows;
}

/**
 * Sinf bo'yicha mavsum statistikasi (rank sinf ichida).
 */
async function getClassStats(seasonId, classId) {
  const rows = await getSeasonStats(seasonId, { classId });
  // Rank sinf ichida
  return rows.map((r, idx) => ({ ...r, classRank: idx + 1 }));
}

/**
 * O'quvchining o'z mavsum stati.
 */
async function getMyStats(seasonId, studentId) {
  const all = await getSeasonStats(seasonId);
  const me = all.find((r) => r.student._id.toString() === studentId.toString());
  if (!me) {
    return { student: null, totalScore: 0, resultCount: 0, rank: null };
  }
  // Sinf rank ham qo'shimcha
  const myClassIds = (me.student.classes || []).map((c) => c._id.toString());
  let classRank = null;
  if (myClassIds.length > 0) {
    const classRows = await getClassStats(seasonId, myClassIds[0]);
    const mc = classRows.find(
      (r) => r.student._id.toString() === studentId.toString(),
    );
    classRank = mc ? mc.classRank : null;
  }
  return { ...me, classRank };
}

/**
 * Mavsumning absolyut darajalarini belgilash (faqat owner).
 */
async function setAbsoluteTiers(seasonId, tiers, userId) {
  const season = await TestSeason.findById(seasonId);
  if (!season) throw new NotFoundError("Mavsum topilmadi");

  if (!Array.isArray(tiers)) {
    throw new BadRequestError("Darajalar ro'yxati noto'g'ri");
  }

  for (const t of tiers) {
    if (!t.name || t.minScore === undefined || t.coinReward === undefined) {
      throw new BadRequestError(
        "Har darajada nom, minimal ball va coin miqdori bo'lishi kerak",
      );
    }
  }

  season.absoluteTiers = tiers.map((t) => ({
    name: t.name.trim(),
    minScore: Number(t.minScore),
    coinReward: Number(t.coinReward),
  }));

  await season.save();
  return season;
}

/**
 * Sinf bo'yicha top-N darajalarni belgilash.
 * Owner istalgan sinf, o'qituvchi faqat o'ziga biriktirilgan sinfga.
 */
async function setClassTiers(seasonId, classId, tiers, user) {
  const season = await TestSeason.findById(seasonId);
  if (!season) throw new NotFoundError("Mavsum topilmadi");

  if (user.role !== "owner") {
    // O'qituvchi shu mavsum+sinf bo'yicha biriktirilganligi
    const hasAssignment = await TeacherAssignment.exists({
      season: seasonId,
      class: classId,
      teacher: user._id,
      isActive: true,
    });
    if (!hasAssignment) {
      throw new ForbiddenError(
        "Siz ushbu mavsum va sinf bo'yicha biriktirilmagansiz",
      );
    }
  }

  if (!Array.isArray(tiers)) {
    throw new BadRequestError("Darajalar ro'yxati noto'g'ri");
  }
  for (const t of tiers) {
    if (t.position === undefined || t.coinReward === undefined) {
      throw new BadRequestError(
        "Har darajada o'rin (position) va coin miqdori bo'lishi kerak",
      );
    }
  }

  // Ushbu sinf uchun mavjud darajalarni almashtirish
  season.classTiers = (season.classTiers || []).filter(
    (ct) => ct.class.toString() !== classId.toString(),
  );
  for (const t of tiers) {
    season.classTiers.push({
      class: classId,
      position: Number(t.position),
      coinReward: Number(t.coinReward),
      createdBy: user._id,
    });
  }

  await season.save();
  return season;
}

/**
 * Tarqatish preview - kim qancha coin oladi (DB ga yozilmaydi).
 * Aralash darajalar: bir o'quvchi ham absolyut tier, ham sinf top-N coin olishi mumkin.
 */
async function previewDistribution(seasonId) {
  const season = await TestSeason.findById(seasonId);
  if (!season) throw new NotFoundError("Mavsum topilmadi");

  const stats = await getSeasonStats(seasonId);
  const awards = []; // har bir award: { student, amount, type, tierName, reason, ... }

  // 1) Absolyut darajalar (eng yuqori chegaraga mos keladigan)
  const sortedAbs = [...(season.absoluteTiers || [])].sort(
    (a, b) => b.minScore - a.minScore,
  );
  for (const row of stats) {
    const matched = sortedAbs.find((t) => row.totalScore >= t.minScore);
    if (matched) {
      awards.push({
        student: row.student,
        amount: matched.coinReward,
        type: "season_absolute_reward",
        tierName: matched.name,
        reason: `Mavsum mukofoti: ${matched.name} (${row.totalScore} ball)`,
        seasonTotalScore: row.totalScore,
      });
    }
  }

  // 2) Sinf top-N: har sinfning top-N o'quvchilari
  const classTiersByClass = new Map();
  for (const ct of season.classTiers || []) {
    const key = ct.class.toString();
    if (!classTiersByClass.has(key)) classTiersByClass.set(key, []);
    classTiersByClass.get(key).push(ct);
  }

  for (const [classId, tiers] of classTiersByClass.entries()) {
    const classStats = await getClassStats(seasonId, classId);
    for (const tier of tiers) {
      const winner = classStats[tier.position - 1]; // 1-based
      if (winner) {
        awards.push({
          student: winner.student,
          amount: tier.coinReward,
          type: "season_class_top_reward",
          tierName: `${tier.position}-o'rin`,
          reason: `Sinf bo'yicha ${tier.position}-o'rin (${winner.totalScore} ball)`,
          classId,
          classPosition: tier.position,
          seasonTotalScore: winner.totalScore,
        });
      }
    }
  }

  // O'quvchi bo'yicha guruhlash (xulosa)
  const byStudent = new Map();
  for (const a of awards) {
    const sid = a.student._id.toString();
    if (!byStudent.has(sid)) {
      byStudent.set(sid, {
        student: a.student,
        totalAmount: 0,
        awards: [],
      });
    }
    const entry = byStudent.get(sid);
    entry.totalAmount += a.amount;
    entry.awards.push(a);
  }

  return {
    seasonId: season._id,
    totalCoins: awards.reduce((s, a) => s + a.amount, 0),
    totalAwards: awards.length,
    studentCount: byStudent.size,
    students: [...byStudent.values()].sort((a, b) => b.totalAmount - a.totalAmount),
    distributedAt: season.distributedAt,
    distributedBy: season.distributedBy,
  };
}

/**
 * Coinlarni tarqatish (idempotent - agar avval tarqatilgan bo'lsa, qayta urinishni bloklash).
 */
async function distributeCoins(seasonId, distributorId, { force = false } = {}) {
  const season = await TestSeason.findById(seasonId);
  if (!season) throw new NotFoundError("Mavsum topilmadi");

  if (season.distributedAt && !force) {
    throw new BadRequestError(
      `Mavsum coinlari allaqachon tarqatilgan (${season.distributedAt.toISOString()}). Qayta tarqatish uchun 'force' parametri kerak.`,
    );
  }

  const preview = await previewDistribution(seasonId);
  const awards = [];
  for (const s of preview.students) {
    for (const a of s.awards) awards.push(a);
  }

  let distributed = 0;
  let skipped = 0;

  for (const award of awards) {
    const sid = award.student._id;

    // Idempotentlik: shu mavsum + shu turdagi + (agar mavjud bo'lsa) classId/position bo'yicha mavjudligini tekshirish
    const dupQuery = {
      student: sid,
      type: award.type,
      "meta.seasonId": seasonId,
    };
    if (award.type === "season_class_top_reward") {
      dupQuery["meta.classId"] = award.classId;
      dupQuery["meta.classPosition"] = award.classPosition;
    } else {
      dupQuery["meta.tierName"] = award.tierName;
    }

    const existing = await CoinTransaction.findOne(dupQuery);
    if (existing) {
      skipped++;
      continue;
    }

    const updatedUser = await User.findByIdAndUpdate(
      sid,
      { $inc: { coinBalance: award.amount } },
      { new: true },
    );
    if (!updatedUser) continue;

    await CoinTransaction.create({
      student: sid,
      amount: award.amount,
      type: award.type,
      description: award.reason,
      balanceAfter: updatedUser.coinBalance,
      meta: {
        seasonId,
        tierName: award.tierName,
        seasonTotalScore: award.seasonTotalScore,
        ...(award.classId && { classId: award.classId }),
        ...(award.classPosition && { classPosition: award.classPosition }),
        givenBy: distributorId,
      },
      date: new Date(),
    });

    distributed++;
  }

  season.distributedAt = new Date();
  season.distributedBy = distributorId;
  await season.save();

  logger.info(
    `[SeasonReward] Season ${seasonId} distribution: ${distributed} awards, ${skipped} skipped`,
  );

  return { distributed, skipped, totalAwards: awards.length };
}

module.exports = {
  getSeasonStats,
  getClassStats,
  getMyStats,
  setAbsoluteTiers,
  setClassTiers,
  previewDistribution,
  distributeCoins,
};
