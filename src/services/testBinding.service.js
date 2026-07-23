const prisma = require("../config/prisma");
const { assertTeacherAssigned } = require("./teacherAssignment.service");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");

/**
 * TestBinding yozuvini Mongoose populate shakliga xaritalaydi:
 *  - season/subject: { _id, ... } obyekt (yoki null)
 *  - classes: [{ _id, name }] massiv
 *  - reopenGrants: [{ _id, student, grantedBy, grantedAt }] massiv
 *  - test: { _id, ... } (agar berilgan bo'lsa)
 * Scalar ID maydonlar ham (seasonId, subjectId, testId, teacherId) saqlanadi.
 */
function _shapeBinding(binding, { season, subject, test } = {}) {
  const shaped = { ...binding };

  shaped.classes = (binding.classes || []).map((c) => ({
    _id: c.classId,
    name: c.class ? c.class.name : undefined,
  }));

  shaped.reopenGrants = (binding.reopenGrants || []).map((g) => ({
    _id: g.id,
    student: g.studentId,
    grantedBy: g.grantedBy,
    grantedAt: g.grantedAt,
  }));

  if (season !== undefined) shaped.season = season;
  if (subject !== undefined) shaped.subject = subject;
  if (test !== undefined) shaped.test = test;

  return shaped;
}

/**
 * Test muallifligini va biriktiruv ownership ni tekshiradi.
 */
async function _loadBindingOwned(bindingId, teacherId) {
  const binding = await prisma.testBinding.findUnique({
    where: { id: bindingId },
    include: { classes: true, reopenGrants: true },
  });
  if (!binding || !binding.isActive) {
    throw new NotFoundError("Biriktiruv topilmadi");
  }
  if (binding.teacherId.toString() !== teacherId.toString()) {
    throw new ForbiddenError("Bu biriktiruv sizga tegishli emas");
  }
  return binding;
}

async function _loadTestOwned(testId, teacherId) {
  const test = await prisma.test.findUnique({ where: { id: testId } });
  if (!test || !test.isActive) {
    throw new NotFoundError("Test topilmadi");
  }
  if (test.teacherId.toString() !== teacherId.toString()) {
    throw new ForbiddenError("Bu test sizga tegishli emas");
  }
  return test;
}

/**
 * Testning barcha biriktiruvlarini oladi (populate qilingan).
 */
async function listBindingsForTest(testId, teacherId) {
  await _loadTestOwned(testId, teacherId);
  const bindings = await prisma.testBinding.findMany({
    where: { testId, isActive: true },
    orderBy: { createdAt: "desc" },
    include: {
      classes: { include: { class: { select: { name: true } } } },
      reopenGrants: true,
    },
  });

  // season/subject — scalar ref (relation emas), qo'lda yuklaymiz
  const seasonIds = [...new Set(bindings.map((b) => b.seasonId).filter(Boolean))];
  const subjectIds = [...new Set(bindings.map((b) => b.subjectId).filter(Boolean))];
  const [seasons, subjects] = await Promise.all([
    prisma.testSeason.findMany({
      where: { id: { in: seasonIds } },
      select: { id: true, name: true, status: true, startDate: true, endDate: true },
    }),
    prisma.subject.findMany({
      where: { id: { in: subjectIds } },
      select: { id: true, name: true },
    }),
  ]);
  const seasonMap = new Map(
    seasons.map((s) => [
      s.id,
      { _id: s.id, name: s.name, status: s.status, startDate: s.startDate, endDate: s.endDate },
    ]),
  );
  const subjectMap = new Map(
    subjects.map((s) => [s.id, { _id: s.id, name: s.name }]),
  );

  return bindings.map((b) =>
    _shapeBinding(b, {
      season: seasonMap.get(b.seasonId) || null,
      subject: subjectMap.get(b.subjectId) || null,
    }),
  );
}

/**
 * Yangi biriktiruv yaratadi.
 */
async function createBinding(testId, data, teacherId) {
  const test = await _loadTestOwned(testId, teacherId);
  const { season, subject, classes } = data;

  if (!season || !subject) {
    throw new BadRequestError("Mavsum va fan majburiy");
  }

  const [seasonDoc, subjectDoc] = await Promise.all([
    prisma.testSeason.findUnique({ where: { id: season } }),
    prisma.subject.findUnique({ where: { id: subject } }),
  ]);
  if (!seasonDoc) throw new NotFoundError("Mavsum topilmadi");
  if (!subjectDoc) throw new NotFoundError("Fan topilmadi");

  const classIds = Array.isArray(classes) ? classes : [];

  // Har sinf uchun biriktirilganligi tekshiriladi
  for (const classId of classIds) {
    await assertTeacherAssigned(teacherId, season, classId, subject);
  }

  // Agar sinflar berilmagan bo'lsa, kamida o'qituvchining shu mavsum+fan
  // bo'yicha biror sinfi borligini tekshirish (umuman biriktiriluvchan bo'lishi uchun)
  if (classIds.length === 0) {
    const hasAssignment = await prisma.teacherAssignment.findFirst({
      where: {
        seasonId: season,
        subjectId: subject,
        teacherId,
        isActive: true,
      },
      select: { id: true },
    });
    if (!hasAssignment) {
      throw new ForbiddenError(
        "Siz ushbu mavsum va fan bo'yicha hech qaysi sinfga biriktirilmagansiz",
      );
    }
  }

  const binding = await prisma.testBinding.create({
    data: {
      testId: test.id,
      teacherId,
      seasonId: season,
      subjectId: subject,
      classes: { create: classIds.map((classId) => ({ classId })) },
    },
    include: { classes: true, reopenGrants: true },
  });

  return _shapeBinding(binding);
}

/**
 * Biriktiruvni yangilaydi (sinflar, mavsum, fan).
 */
async function updateBinding(id, data, teacherId) {
  const binding = await _loadBindingOwned(id, teacherId);
  const { season, subject, classes } = data;

  const update = {};
  // Yangilanishdan keyingi mavsum/fan (assertTeacherAssigned uchun)
  const effectiveSeason = season !== undefined ? season : binding.seasonId;
  const effectiveSubject = subject !== undefined ? subject : binding.subjectId;

  if (season !== undefined) update.seasonId = season;
  if (subject !== undefined) update.subjectId = subject;

  if (classes !== undefined) {
    const classIds = Array.isArray(classes) ? classes : [];
    for (const classId of classIds) {
      await assertTeacherAssigned(
        teacherId,
        effectiveSeason,
        classId,
        effectiveSubject,
      );
    }
    update.classes = {
      deleteMany: {},
      create: classIds.map((classId) => ({ classId })),
    };
  }

  const updated = await prisma.testBinding.update({
    where: { id },
    data: update,
    include: { classes: true, reopenGrants: true },
  });
  return _shapeBinding(updated);
}

/**
 * Biriktiruvni o'chiradi. Sessiyalar bo'lsa soft, aks holda hard.
 */
async function deleteBinding(id, teacherId) {
  await _loadBindingOwned(id, teacherId);

  const sessionCount = await prisma.testSession.count({
    where: { bindingId: id },
  });
  if (sessionCount > 0) {
    await prisma.testBinding.update({
      where: { id },
      data: { isActive: false, status: "closed" },
    });
    return { deleted: false };
  }

  await prisma.testBinding.delete({ where: { id } });
  return { deleted: true };
}

/**
 * O'qituvchi (test muallifi) o'quvchiga qayta urinishga ruxsat beradi.
 */
async function reopenSessionForStudent(bindingId, studentId, teacherId) {
  await _loadBindingOwned(bindingId, teacherId);

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, role: true },
  });
  if (!student || student.role !== "student") {
    throw new NotFoundError("O'quvchi topilmadi");
  }

  const inProgress = await prisma.testSession.findFirst({
    where: {
      bindingId,
      studentId,
      status: "in_progress",
    },
  });
  if (inProgress) {
    throw new BadRequestError(
      "O'quvchining davom etayotgan sessiyasi bor, avval u yakunlanishi kerak",
    );
  }

  const finishedCount = await prisma.testSession.count({
    where: { bindingId, studentId },
  });
  if (finishedCount === 0) {
    throw new BadRequestError(
      "O'quvchi bu biriktiruvni hali boshlamagan, qayta urinish ruxsati shart emas",
    );
  }

  await prisma.testBindingReopenGrant.create({
    data: {
      bindingId,
      studentId,
      grantedBy: teacherId,
      grantedAt: new Date(),
    },
  });

  const binding = await prisma.testBinding.findUnique({
    where: { id: bindingId },
    include: { classes: true, reopenGrants: true },
  });

  return { binding: _shapeBinding(binding) };
}

/**
 * O'quvchi topshira oladigan biriktiruvlarni qaytaradi.
 * student.classes ∩ binding.classes, test savollari yetarli, mavsum faol va vaqti to'g'ri.
 */
async function listAvailableBindingsForStudent(studentId) {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { classes: { select: { classId: true } } },
  });
  if (!student) {
    throw new NotFoundError("O'quvchi topilmadi");
  }
  const classIds = (student.classes || []).map((c) => c.classId);
  if (classIds.length === 0) return [];

  const now = new Date();
  const activeSeasons = await prisma.testSeason.findMany({
    where: {
      status: "active",
      isActive: true,
      startDate: { lte: now },
      endDate: { gte: now },
    },
    select: { id: true },
  });
  const seasonIds = activeSeasons.map((s) => s.id);
  if (seasonIds.length === 0) return [];

  const candidateBindings = await prisma.testBinding.findMany({
    where: {
      isActive: true,
      classes: { some: { classId: { in: classIds } } },
      seasonId: { in: seasonIds },
    },
    orderBy: { createdAt: "desc" },
    include: {
      classes: { include: { class: { select: { name: true } } } },
      reopenGrants: true,
    },
  });

  // test/season/subject — scalar ref, qo'lda yuklaymiz (populate o'rniga)
  const candidateTestIds = [
    ...new Set(candidateBindings.map((b) => b.testId).filter(Boolean)),
  ];
  const candidateSeasonIds = [
    ...new Set(candidateBindings.map((b) => b.seasonId).filter(Boolean)),
  ];
  const candidateSubjectIds = [
    ...new Set(candidateBindings.map((b) => b.subjectId).filter(Boolean)),
  ];
  const [testDocs, seasonDocs, subjectDocs] = await Promise.all([
    prisma.test.findMany({
      where: { id: { in: candidateTestIds } },
      select: { id: true, title: true, questionCount: true, timeLimitMinutes: true },
    }),
    prisma.testSeason.findMany({
      where: { id: { in: candidateSeasonIds } },
      select: { id: true, name: true, endDate: true },
    }),
    prisma.subject.findMany({
      where: { id: { in: candidateSubjectIds } },
      select: { id: true, name: true },
    }),
  ]);
  const testMap = new Map(
    testDocs.map((t) => [
      t.id,
      {
        _id: t.id,
        title: t.title,
        questionCount: t.questionCount,
        timeLimitMinutes: t.timeLimitMinutes,
      },
    ]),
  );
  const seasonMap = new Map(
    seasonDocs.map((s) => [s.id, { _id: s.id, name: s.name, endDate: s.endDate }]),
  );
  const subjectMap = new Map(
    subjectDocs.map((s) => [s.id, { _id: s.id, name: s.name }]),
  );

  // Faqat savollari yetarli (faol savol soni >= test.questionCount) testlar
  // o'quvchilarga avtomatik ko'rinadi.
  const testIds = [
    ...new Set(
      candidateBindings
        .map((b) => testMap.get(b.testId)?._id)
        .filter(Boolean),
    ),
  ];
  const questionCounts = await prisma.question.groupBy({
    by: ["testId"],
    where: { testId: { in: testIds }, isActive: true },
    _count: { _all: true },
  });
  const activeCountMap = new Map(
    questionCounts.map((q) => [q.testId, q._count._all]),
  );

  // populate shaklidagi biriktiruvlar (test/season/subject/classes obyekt)
  const shapedBindings = candidateBindings.map((b) =>
    _shapeBinding(b, {
      test: testMap.get(b.testId) || null,
      season: seasonMap.get(b.seasonId) || null,
      subject: subjectMap.get(b.subjectId) || null,
    }),
  );

  const bindings = shapedBindings.filter((b) => {
    if (!b.test) return false;
    const activeCount = activeCountMap.get(b.test._id) || 0;
    return activeCount >= (b.test.questionCount || 0);
  });

  // O'quvchining shu biriktiruvlardagi sessiyalari
  const bindingIds = bindings.map((b) => b.id);
  const sessions = await prisma.testSession.findMany({
    where: { bindingId: { in: bindingIds }, studentId },
    select: { bindingId: true, attemptNumber: true, status: true },
  });

  const sessionMap = new Map();
  for (const s of sessions) {
    const key = s.bindingId;
    const current = sessionMap.get(key) || {
      maxAttempt: 0,
      hasInProgress: false,
    };
    current.maxAttempt = Math.max(current.maxAttempt, s.attemptNumber);
    if (s.status === "in_progress") current.hasInProgress = true;
    sessionMap.set(key, current);
  }

  return bindings
    .filter((b) => {
      const info = sessionMap.get(b.id);
      if (!info) return true;
      if (info.hasInProgress) return true;
      // Reopen grant bormi?
      const grantsForStudent = (b.reopenGrants || []).filter(
        (g) => g.student.toString() === studentId.toString(),
      ).length;
      const allowedAttempts = 1 + grantsForStudent;
      return info.maxAttempt < allowedAttempts;
    })
    .map((b) => {
      const info = sessionMap.get(b.id);
      return {
        ...b,
        nextAttemptNumber: info ? info.maxAttempt + 1 : 1,
        hasInProgress: info ? info.hasInProgress : false,
      };
    });
}

module.exports = {
  listBindingsForTest,
  createBinding,
  updateBinding,
  deleteBinding,
  reopenSessionForStudent,
  listAvailableBindingsForStudent,
};
