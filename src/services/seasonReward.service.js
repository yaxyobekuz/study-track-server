const prisma = require("../config/prisma");
const { ROLES } = require("../utils/constants");
const logger = require("../utils/logger");
const { BadRequestError, NotFoundError } = require("../utils/errors");

/**
 * Mavsumdagi o'quvchilar statistikasini hisoblaydi.
 * Stat metrikasi: o'rtacha ball = (natijalar finalScore yig'indisi) / (biriktirilgan
 * testlar soni). Topshirilmagan biriktirilgan test 0 sifatida hisoblanadi.
 *
 * @param {string} seasonId
 * @param {object} [filter] - { classId, subjectId } (ixtiyoriy filterlar)
 * @returns {Promise<Array>} sorted array:
 *   { student, averageScore, totalScore, resultCount, assignedCount, rank }
 */
async function getSeasonStats(seasonId, filter = {}) {
  const season = await prisma.testSeason.findUnique({ where: { id: seasonId } });
  if (!season) throw new NotFoundError("Mavsum topilmadi");

  const resultWhere = { seasonId };
  if (filter.subjectId) {
    resultWhere.subjectId = filter.subjectId;
  }

  // 1) Natijalar yig'indisi (o'quvchi bo'yicha)
  const grouped = await prisma.testResult.groupBy({
    by: ["studentId"],
    where: resultWhere,
    _sum: { finalScore: true },
    _count: { _all: true },
  });
  const resultMap = new Map(
    grouped.map((g) => [
      g.studentId.toString(),
      { sumScore: g._sum.finalScore || 0, resultCount: g._count._all },
    ]),
  );

  // 2) Mavsumdagi faol biriktirishlar (status ishlatilmaydi)
  const bindingWhere = { seasonId, isActive: true };
  if (filter.subjectId) bindingWhere.subjectId = filter.subjectId;
  const bindings = await prisma.testBinding.findMany({
    where: bindingWhere,
    select: {
      testId: true,
      classes: { select: { classId: true } },
    },
  });

  // 3) "Tayyor" testlar (faol savol soni >= questionCount) - faqat shular biriktirilgan deyiladi
  const testIds = [...new Set(bindings.map((b) => b.testId.toString()))];
  const readyTestIds = new Set();
  if (testIds.length > 0) {
    const tests = await prisma.test.findMany({
      where: { id: { in: testIds }, isActive: true },
      select: { id: true, questionCount: true },
    });
    const counts = await prisma.question.groupBy({
      by: ["testId"],
      where: { testId: { in: tests.map((t) => t.id) }, isActive: true },
      _count: { _all: true },
    });
    const countMap = new Map(
      counts.map((c) => [c.testId.toString(), c._count._all]),
    );
    for (const t of tests) {
      if ((countMap.get(t.id.toString()) || 0) >= t.questionCount) {
        readyTestIds.add(t.id.toString());
      }
    }
  }

  // 4) Sinf -> biriktirilgan (tayyor) testlar to'plami
  const classToTests = new Map();
  const bindingClassIds = new Set();
  for (const b of bindings) {
    const tid = b.testId.toString();
    if (!readyTestIds.has(tid)) continue;
    for (const c of b.classes || []) {
      const cid = c.classId.toString();
      bindingClassIds.add(cid);
      if (!classToTests.has(cid)) classToTests.set(cid, new Set());
      classToTests.get(cid).add(tid);
    }
  }

  // 5) O'quvchilar universumi: biriktirilgan sinflardagilar (natijasi yo'qlar ham) ∪ natijasi borlar
  const userMap = new Map();
  if (bindingClassIds.size > 0) {
    const assignedStudents = await prisma.user.findMany({
      where: {
        role: ROLES.STUDENT,
        isActive: { not: false },
        classes: { some: { classId: { in: [...bindingClassIds] } } },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        username: true,
        classes: { select: { class: { select: { id: true, name: true } } } },
      },
    });
    for (const u of assignedStudents) userMap.set(u.id.toString(), u);
  }
  const missingIds = grouped
    .map((g) => g.studentId)
    .filter((id) => !userMap.has(id.toString()));
  if (missingIds.length > 0) {
    const extra = await prisma.user.findMany({
      where: { id: { in: missingIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        username: true,
        classes: { select: { class: { select: { id: true, name: true } } } },
      },
    });
    for (const u of extra) userMap.set(u.id.toString(), u);
  }

  // 6) Har o'quvchi uchun assignedCount va o'rtacha ball
  let rows = [...userMap.values()].map((u) => {
    const sid = u.id.toString();
    // classes M2M junctiondan { _id, name } shakliga keltiramiz (populate o'rnini bosadi)
    const classes = (u.classes || []).map((uc) => ({
      _id: uc.class.id,
      name: uc.class.name,
    }));
    const assigned = new Set();
    for (const c of classes) {
      const set = classToTests.get(c._id.toString());
      if (set) for (const t of set) assigned.add(t);
    }
    const g = resultMap.get(sid);
    const sumScore = g ? g.sumScore : 0;
    const resultCount = g ? g.resultCount : 0;
    const assignedCount = assigned.size;
    const averageScore = assignedCount > 0 ? sumScore / assignedCount : 0;
    return {
      student: {
        _id: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        username: u.username,
        classes,
      },
      averageScore,
      totalScore: sumScore,
      resultCount,
      assignedCount,
    };
  });

  // Sinf filtri
  if (filter.classId) {
    const cid = filter.classId.toString();
    rows = rows.filter((r) =>
      (r.student.classes || []).some((c) => c._id.toString() === cid),
    );
  }

  // Faqat biriktirilgan yoki natijasi borlarni ko'rsatish
  rows = rows.filter((r) => r.assignedCount > 0 || r.resultCount > 0);

  // Rank (o'rtacha ball bo'yicha)
  rows.sort((a, b) => b.averageScore - a.averageScore);
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
    return {
      student: null,
      averageScore: 0,
      totalScore: 0,
      resultCount: 0,
      assignedCount: 0,
      rank: null,
      classRank: null,
    };
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
 * Maktab bo'yicha o'rin mukofotlarini belgilash (faqat owner).
 * Har tier: { position, coinReward, note? }
 */
async function setSchoolTiers(seasonId, tiers, userId) {
  const season = await prisma.testSeason.findUnique({ where: { id: seasonId } });
  if (!season) throw new NotFoundError("Mavsum topilmadi");

  if (!Array.isArray(tiers)) {
    throw new BadRequestError("Darajalar ro'yxati noto'g'ri");
  }

  for (const t of tiers) {
    if (t.position === undefined || t.coinReward === undefined) {
      throw new BadRequestError(
        "Har o'rinda o'rin (position) va coin miqdori bo'lishi kerak",
      );
    }
  }

  const schoolTiers = tiers.map((t) => ({
    position: Number(t.position),
    coinReward: Number(t.coinReward),
    note: t.note ? String(t.note).trim() : undefined,
  }));

  return prisma.testSeason.update({
    where: { id: seasonId },
    data: { schoolTiers },
  });
}

/**
 * Sinf bo'yicha o'rin mukofotlarini belgilash (faqat owner) - UMUMIY.
 * Belgilangan o'rinlar har bir sinfning top-N o'quvchilariga qo'llanadi.
 * Har tier: { position, coinReward, note? }
 */
async function setClassTiers(seasonId, tiers, userId) {
  const season = await prisma.testSeason.findUnique({ where: { id: seasonId } });
  if (!season) throw new NotFoundError("Mavsum topilmadi");

  if (!Array.isArray(tiers)) {
    throw new BadRequestError("Darajalar ro'yxati noto'g'ri");
  }
  for (const t of tiers) {
    if (t.position === undefined || t.coinReward === undefined) {
      throw new BadRequestError(
        "Har o'rinda o'rin (position) va coin miqdori bo'lishi kerak",
      );
    }
  }

  const classTiers = tiers.map((t) => ({
    position: Number(t.position),
    coinReward: Number(t.coinReward),
    note: t.note ? String(t.note).trim() : undefined,
  }));

  return prisma.testSeason.update({
    where: { id: seasonId },
    data: { classTiers },
  });
}

/**
 * Tarqatish preview - kim qancha coin oladi (DB ga yozilmaydi).
 * Aralash darajalar: bir o'quvchi ham absolyut tier, ham sinf top-N coin olishi mumkin.
 */
async function previewDistribution(seasonId) {
  const season = await prisma.testSeason.findUnique({ where: { id: seasonId } });
  if (!season) throw new NotFoundError("Mavsum topilmadi");

  const stats = await getSeasonStats(seasonId);
  const awards = []; // har bir award: { student, amount, type, tierName, reason, ... }

  // 1) Maktab bo'yicha o'rin mukofotlari (stats o'rtacha bo'yicha saralangan)
  for (const tier of season.schoolTiers || []) {
    const winner = stats[tier.position - 1]; // 1-based
    if (winner) {
      awards.push({
        student: winner.student,
        amount: tier.coinReward,
        type: "season_absolute_reward",
        tierName: `Maktab ${tier.position}-o'rin`,
        reason:
          tier.note ||
          `Maktab bo'yicha ${tier.position}-o'rin (o'rtacha ${winner.averageScore.toFixed(2)} ball)`,
        schoolPosition: tier.position,
        seasonAverageScore: winner.averageScore,
      });
    }
  }

  // 2) Sinf top-N: UMUMIY darajalar har bir sinfning top-N o'quvchilariga
  const classTiers = [...(season.classTiers || [])];
  if (classTiers.length > 0) {
    // Mavsumdagi barcha sinflar (o'quvchilar sinflaridan)
    const classMap = new Map(); // classId -> className
    for (const row of stats) {
      for (const c of row.student.classes || []) {
        classMap.set(c._id.toString(), c.name);
      }
    }

    for (const [classId, className] of classMap.entries()) {
      const classStats = await getClassStats(seasonId, classId);
      for (const tier of classTiers) {
        const winner = classStats[tier.position - 1]; // 1-based
        if (winner) {
          awards.push({
            student: winner.student,
            amount: tier.coinReward,
            type: "season_class_top_reward",
            tierName: `Sinf ${tier.position}-o'rin`,
            reason:
              tier.note ||
              `Sinf bo'yicha ${tier.position}-o'rin (o'rtacha ${winner.averageScore.toFixed(2)} ball)`,
            classId,
            className,
            classPosition: tier.position,
            seasonAverageScore: winner.averageScore,
          });
        }
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
    seasonId: season.id,
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
  const season = await prisma.testSeason.findUnique({ where: { id: seasonId } });
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

    // Idempotentlik: shu mavsum + shu turdagi + (agar mavjud bo'lsa) classId/position bo'yicha mavjudligini tekshirish.
    // meta — JSONB; har bir kalit alohida path filter (eski "meta.x" query'lari o'rnini bosadi).
    const metaConditions = [
      { meta: { path: ["seasonId"], equals: seasonId } },
    ];
    if (award.type === "season_class_top_reward") {
      metaConditions.push({ meta: { path: ["classId"], equals: award.classId } });
      metaConditions.push({
        meta: { path: ["classPosition"], equals: award.classPosition },
      });
    } else {
      metaConditions.push({
        meta: { path: ["tierName"], equals: award.tierName },
      });
    }

    const existing = await prisma.coinTransaction.findFirst({
      where: {
        studentId: sid,
        type: award.type,
        AND: metaConditions,
      },
    });
    if (existing) {
      skipped++;
      continue;
    }

    let updatedUser;
    try {
      updatedUser = await prisma.user.update({
        where: { id: sid },
        data: { coinBalance: { increment: award.amount } },
      });
    } catch (err) {
      if (err.code === "P2025") continue; // o'quvchi topilmadi
      throw err;
    }

    await prisma.coinTransaction.create({
      data: {
        studentId: sid,
        amount: award.amount,
        type: award.type,
        description: award.reason,
        balanceAfter: updatedUser.coinBalance,
        meta: {
          seasonId,
          tierName: award.tierName,
          seasonAverageScore: award.seasonAverageScore,
          ...(award.schoolPosition && { schoolPosition: award.schoolPosition }),
          ...(award.classId && { classId: award.classId }),
          ...(award.classPosition && { classPosition: award.classPosition }),
          givenBy: distributorId,
        },
        date: new Date(),
      },
    });

    distributed++;
  }

  await prisma.testSeason.update({
    where: { id: seasonId },
    data: { distributedAt: new Date(), distributedBy: distributorId },
  });

  logger.info(
    `[SeasonReward] Season ${seasonId} distribution: ${distributed} awards, ${skipped} skipped`,
  );

  return { distributed, skipped, totalAwards: awards.length };
}

module.exports = {
  getSeasonStats,
  getClassStats,
  getMyStats,
  setSchoolTiers,
  setClassTiers,
  previewDistribution,
  distributeCoins,
};
