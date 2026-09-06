const prisma = require("../config/prisma");
const { ROLES } = require("../utils/constants");
const { hasRole } = require("../utils/permissions");
const { getTestSettings } = require("./settings.service");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");

/**
 * Natija yakuniy ballini qayta hisoblaydi va holatini yangilaydi.
 * V2: clamp olib tashlandi. finalScore = autoGraded + manualGraded + Σextra.
 *
 * @param {object} result - TestResult obyekti (extraPoints/perQuestion massivlari bilan)
 * @returns {object} { finalScore, passed, status } — yangilangan qiymatlar
 */
function _recomputeFinalScore(result) {
  const extraSum = result.extraPoints.reduce(
    (sum, ep) => sum + (ep.amount || 0),
    0,
  );
  const finalScore =
    (result.autoGradedScore || 0) +
    (result.manualGradedScore || 0) +
    extraSum;

  // O'tish holati: finalScore >= o'tish bali (gradingMin)
  const passed = finalScore >= (result.gradingMin ?? 0);

  // Holatni perQuestion bo'yicha aniqlash
  const pending = result.perQuestion.filter((pq) => pq.status === "pending");
  let status;
  if (pending.length === 0) {
    status = "graded";
  } else if (pending.length === result.perQuestion.length) {
    status = "pending";
  } else {
    status = "partially_graded";
  }

  return { finalScore, passed, status };
}

/**
 * Sessiyani baholaydi: variantli savollarni avtomatik, ochiq savollarni
 * 'pending' holatda qoldiradi. TestResult yaratadi yoki yangilaydi.
 * Submit yoki expire da chaqiriladi.
 * @param {string} sessionId - session ID
 * @returns {Promise<object>} yaratilgan/yangilangan TestResult
 */
async function gradeSession(sessionId) {
  // Javob kalitini ham olish uchun questions va answers bilan
  const session = await prisma.testSession.findUnique({
    where: { id: sessionId },
    include: { questions: true, answers: true },
  });
  if (!session) {
    throw new NotFoundError("Session topilmadi");
  }

  const test = await prisma.test.findUnique({ where: { id: session.testId } });
  if (!test) {
    throw new NotFoundError("Test topilmadi");
  }

  // Javoblarni savol bo'yicha xaritalash
  const answerMap = new Map();
  for (const ans of session.answers) {
    answerMap.set(ans.questionId, ans);
  }

  let autoGradedScore = 0;
  const perQuestion = [];

  for (const q of session.questions) {
    const qId = q.questionId;
    const answer = answerMap.get(qId);

    if (q.type === "standard") {
      const isCorrect =
        answer &&
        answer.selectedOptionId &&
        q.correctOptionId &&
        answer.selectedOptionId === q.correctOptionId;
      const awarded = isCorrect ? q.points : 0;
      autoGradedScore += awarded;
      perQuestion.push({
        questionId: q.questionId,
        awardedPoints: awarded,
        maxPoints: q.points,
        gradedBy: null,
        status: "graded",
        feedback: null,
      });
    } else {
      // Ochiq savol - o'qituvchi qo'lda baholaydi
      perQuestion.push({
        questionId: q.questionId,
        awardedPoints: 0,
        maxPoints: q.points,
        gradedBy: null,
        status: "pending",
        feedback: null,
      });
    }
  }

  // Mavjud natijani topish yoki yangi yaratish
  let result = await prisma.testResult.findUnique({
    where: { sessionId },
    include: { extraPoints: true, perQuestion: true },
  });

  if (!result) {
    // V3: binding ma'lumotini olish (subject denormalizatsiya uchun)
    const binding = await prisma.testBinding.findUnique({
      where: { id: session.bindingId },
      include: { classes: true },
    });
    const bindingClass =
      binding && binding.classes && binding.classes.length > 0
        ? binding.classes[0].classId
        : null;
    const bindingSubject = binding ? binding.subjectId : undefined;

    // Ball shkalasini sessiyadan olish (eski sessiyalar uchun joriy sozlamadan)
    let gradingMin;
    let gradingMax;
    if (session.gradingMin != null && session.gradingMax != null) {
      gradingMin = session.gradingMin;
      gradingMax = session.gradingMax;
    } else {
      const settings = await getTestSettings();
      gradingMin = settings.minScore;
      gradingMax = settings.maxScore;
    }

    const draft = {
      autoGradedScore,
      manualGradedScore: 0,
      gradingMin,
      gradingMax,
      extraPoints: [],
      perQuestion,
    };
    const { finalScore, passed, status } = _recomputeFinalScore(draft);

    result = await prisma.testResult.create({
      data: {
        sessionId,
        bindingId: session.bindingId,
        testId: session.testId,
        studentId: session.studentId,
        seasonId: session.seasonId,
        classId: bindingClass,
        subjectId: bindingSubject,
        autoGradedScore,
        manualGradedScore: 0,
        gradingMin,
        gradingMax,
        finalScore,
        passed,
        status,
        perQuestion: {
          create: perQuestion.map((pq, index) => ({
            questionId: pq.questionId,
            awardedPoints: pq.awardedPoints,
            maxPoints: pq.maxPoints,
            gradedBy: pq.gradedBy,
            status: pq.status,
            feedback: pq.feedback,
            position: index,
          })),
        },
      },
      include: { extraPoints: true, perQuestion: true },
    });

    return result;
  }

  // Mavjud natija — perQuestion ni qayta yaratamiz, extraPoints saqlanadi
  // Ball shkalasini sessiyadan olish (eski sessiyalar uchun joriy sozlamadan)
  let gradingMin = result.gradingMin;
  let gradingMax = result.gradingMax;
  if (session.gradingMin != null && session.gradingMax != null) {
    gradingMin = session.gradingMin;
    gradingMax = session.gradingMax;
  } else if (result.gradingMin == null || result.gradingMax == null) {
    const settings = await getTestSettings();
    gradingMin = settings.minScore;
    gradingMax = settings.maxScore;
  }

  const draft = {
    autoGradedScore,
    manualGradedScore: 0,
    gradingMin,
    // extraPoints saqlanib qoladi (agar oldindan mavjud bo'lsa)
    extraPoints: result.extraPoints,
    perQuestion,
  };
  const { finalScore, passed, status } = _recomputeFinalScore(draft);

  await prisma.testResultPerQuestion.deleteMany({ where: { resultId: result.id } });

  result = await prisma.testResult.update({
    where: { id: result.id },
    data: {
      gradingMin,
      gradingMax,
      autoGradedScore,
      manualGradedScore: 0,
      finalScore,
      passed,
      status,
      perQuestion: {
        create: perQuestion.map((pq, index) => ({
          questionId: pq.questionId,
          awardedPoints: pq.awardedPoints,
          maxPoints: pq.maxPoints,
          gradedBy: pq.gradedBy,
          status: pq.status,
          feedback: pq.feedback,
          position: index,
        })),
      },
    },
    include: { extraPoints: true, perQuestion: true },
  });

  return result;
}

/**
 * Ochiq savol javobini qo'lda baholaydi (test muallifi tomonidan).
 * @param {string} resultId - natija ID
 * @param {string} questionId - savol ID
 * @param {string} teacherId - o'qituvchi ID
 * @param {object} data - { awardedPoints, feedback }
 * @returns {Promise<object>} yangilangan natija
 */
async function gradeOpenAnswer(resultId, questionId, teacherId, data) {
  const { awardedPoints, feedback } = data;

  if (awardedPoints === undefined || awardedPoints === null) {
    throw new BadRequestError("Ball miqdori majburiy");
  }

  const result = await prisma.testResult.findUnique({
    where: { id: resultId },
    include: { extraPoints: true, perQuestion: true },
  });
  if (!result) {
    throw new NotFoundError("Natija topilmadi");
  }

  const test = await prisma.test.findUnique({ where: { id: result.testId } });
  if (!test) {
    throw new NotFoundError("Test topilmadi");
  }
  if (test.teacherId !== teacherId.toString()) {
    throw new ForbiddenError("Bu test sizga tegishli emas");
  }

  const pq = result.perQuestion.find(
    (item) => item.questionId === questionId.toString(),
  );
  if (!pq) {
    throw new NotFoundError("Savol natijada topilmadi");
  }

  const points = Number(awardedPoints);
  if (isNaN(points) || points < 0 || points > pq.maxPoints) {
    throw new BadRequestError(
      `Ball 0 dan ${pq.maxPoints} gacha bo'lishi kerak`,
    );
  }

  // perQuestion yozuvini yangilaymiz (mahalliy nusxa va DB)
  pq.awardedPoints = points;
  pq.status = "graded";
  pq.gradedBy = teacherId;
  if (feedback !== undefined) pq.feedback = feedback;

  const pqUpdate = {
    awardedPoints: points,
    status: "graded",
    gradedBy: teacherId,
  };
  if (feedback !== undefined) pqUpdate.feedback = feedback;
  await prisma.testResultPerQuestion.update({
    where: { id: pq.id },
    data: pqUpdate,
  });

  // Qo'lda baholangan ballarni qayta yig'ish
  // (auto baholangan savollar gradeSession da hisoblangan, bu yerda
  //  faqat o'qituvchi tomonidan baholangan savollar yig'iladi)
  const manualGradedScore = result.perQuestion
    .filter((item) => item.gradedBy)
    .reduce((sum, item) => sum + (item.awardedPoints || 0), 0);
  result.manualGradedScore = manualGradedScore;

  const { finalScore, passed, status } = _recomputeFinalScore(result);
  await prisma.testResult.update({
    where: { id: result.id },
    data: { manualGradedScore, finalScore, passed, status },
  });

  return prisma.testResult.findUnique({
    where: { id: result.id },
    include: { extraPoints: true, perQuestion: true },
  });
}

/**
 * Natijaga qo'shimcha ball qo'shadi (test muallifi tomonidan).
 * @param {string} resultId - natija ID
 * @param {string} teacherId - o'qituvchi ID
 * @param {object} data - { amount, reason }
 * @returns {Promise<object>} yangilangan natija
 */
async function addExtraPoints(resultId, teacherId, data) {
  const { amount, reason } = data;

  if (amount === undefined || amount === null) {
    throw new BadRequestError("Ball miqdori majburiy");
  }
  if (!reason) {
    throw new BadRequestError("Qo'shimcha ball sababi majburiy");
  }

  const result = await prisma.testResult.findUnique({
    where: { id: resultId },
    include: { extraPoints: true, perQuestion: true },
  });
  if (!result) {
    throw new NotFoundError("Natija topilmadi");
  }

  const test = await prisma.test.findUnique({ where: { id: result.testId } });
  if (!test) {
    throw new NotFoundError("Test topilmadi");
  }
  if (test.teacherId !== teacherId.toString()) {
    throw new ForbiddenError("Bu test sizga tegishli emas");
  }

  const nextPosition = result.extraPoints.length;
  await prisma.testResultExtraPoint.create({
    data: {
      resultId: result.id,
      amount: Number(amount),
      reason,
      addedBy: teacherId,
      addedAt: new Date(),
      position: nextPosition,
    },
  });

  // Mahalliy nusxaga qo'shib finalScore ni qayta hisoblaymiz
  result.extraPoints.push({ amount: Number(amount) });
  const { finalScore, passed, status } = _recomputeFinalScore(result);
  await prisma.testResult.update({
    where: { id: result.id },
    data: { finalScore, passed, status },
  });

  return prisma.testResult.findUnique({
    where: { id: result.id },
    include: { extraPoints: true, perQuestion: true },
  });
}

/**
 * Natija egaligini tekshirib, natijani qaytaradi (qo'shimcha ball amallari uchun).
 */
async function _loadResultOwnedByTeacher(resultId, teacherId) {
  const result = await prisma.testResult.findUnique({
    where: { id: resultId },
    include: { extraPoints: true, perQuestion: true },
  });
  if (!result) {
    throw new NotFoundError("Natija topilmadi");
  }

  const test = await prisma.test.findUnique({ where: { id: result.testId } });
  if (!test) {
    throw new NotFoundError("Test topilmadi");
  }
  if (test.teacherId !== teacherId.toString()) {
    throw new ForbiddenError("Bu test sizga tegishli emas");
  }

  return result;
}

/**
 * Mavjud qo'shimcha ball yozuvini tahrirlaydi (test muallifi tomonidan).
 * @param {string} resultId - natija ID
 * @param {string} entryId - qo'shimcha ball yozuvi ID
 * @param {string} teacherId - o'qituvchi ID
 * @param {object} data - { amount, reason }
 * @returns {Promise<object>} yangilangan natija
 */
async function editExtraPoints(resultId, entryId, teacherId, data) {
  const { amount, reason } = data;

  if (amount === undefined || amount === null) {
    throw new BadRequestError("Ball miqdori majburiy");
  }
  if (!reason) {
    throw new BadRequestError("Qo'shimcha ball sababi majburiy");
  }

  const result = await _loadResultOwnedByTeacher(resultId, teacherId);

  const entry = result.extraPoints.find((ep) => ep.id === entryId.toString());
  if (!entry) {
    throw new NotFoundError("Qo'shimcha ball yozuvi topilmadi");
  }

  entry.amount = Number(amount);
  entry.reason = reason;

  await prisma.testResultExtraPoint.update({
    where: { id: entry.id },
    data: { amount: Number(amount), reason },
  });

  const { finalScore, passed, status } = _recomputeFinalScore(result);
  await prisma.testResult.update({
    where: { id: result.id },
    data: { finalScore, passed, status },
  });

  return prisma.testResult.findUnique({
    where: { id: result.id },
    include: { extraPoints: true, perQuestion: true },
  });
}

/**
 * Qo'shimcha ball yozuvini o'chiradi (test muallifi tomonidan).
 * @param {string} resultId - natija ID
 * @param {string} entryId - qo'shimcha ball yozuvi ID
 * @param {string} teacherId - o'qituvchi ID
 * @returns {Promise<object>} yangilangan natija
 */
async function deleteExtraPoints(resultId, entryId, teacherId) {
  const result = await _loadResultOwnedByTeacher(resultId, teacherId);

  const entry = result.extraPoints.find((ep) => ep.id === entryId.toString());
  if (!entry) {
    throw new NotFoundError("Qo'shimcha ball yozuvi topilmadi");
  }

  await prisma.testResultExtraPoint.delete({ where: { id: entry.id } });

  // Mahalliy nusxadan o'chirib finalScore ni qayta hisoblaymiz
  result.extraPoints = result.extraPoints.filter((ep) => ep.id !== entry.id);
  const { finalScore, passed, status } = _recomputeFinalScore(result);
  await prisma.testResult.update({
    where: { id: result.id },
    data: { finalScore, passed, status },
  });

  return prisma.testResult.findUnique({
    where: { id: result.id },
    include: { extraPoints: true, perQuestion: true },
  });
}

/**
 * O'quvchining natijalarini oladi.
 * @param {string} studentId - o'quvchi ID
 * @param {string} [seasonId] - mavsum ID (ixtiyoriy filtr)
 * @returns {Promise<Array>} natijalar
 */
async function getResultsForStudent(studentId, seasonId) {
  const where = { studentId };
  if (seasonId) where.seasonId = seasonId;

  const results = await prisma.testResult.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  return _attachRefs(results, {
    test: { select: { id: true, title: true } },
    season: { select: { id: true, name: true } },
    subject: { select: { id: true, name: true } },
    class: { select: { id: true, name: true } },
  });
}

/**
 * Natijani ID bo'yicha oladi. O'quvchi o'zinikini, o'qituvchi o'z testiniki ko'ra oladi.
 * @param {string} id - natija ID
 * @param {object} user - so'rov yuborgan foydalanuvchi
 * @returns {Promise<object>} natija
 */
async function getResultById(id, user) {
  const result = await prisma.testResult.findUnique({
    where: { id },
    include: { extraPoints: true, perQuestion: true },
  });

  if (!result) {
    throw new NotFoundError("Natija topilmadi");
  }

  // test'ni teacher bilan olish (egalikni tekshirish uchun)
  const test = await prisma.test.findUnique({
    where: { id: result.testId },
    select: { id: true, title: true, teacherId: true },
  });

  if (user.role === "student") {
    if (result.studentId !== user.id.toString()) {
      throw new ForbiddenError("Bu natija sizga tegishli emas");
    }
    // Ko'p rollilik — darvoza bilan bir xil savol (`hasRole`)
  } else if (hasRole(user, ROLES.TEACHER)) {
    if ((test?.teacherId || null) !== user.id.toString()) {
      throw new ForbiddenError("Bu natija sizning testingizga tegishli emas");
    }
  }

  const [enriched] = await _attachRefs([result], {
    test: { select: { id: true, title: true, teacherId: true } },
    season: { select: { id: true, name: true } },
    subject: { select: { id: true, name: true } },
    class: { select: { id: true, name: true } },
    student: { select: { id: true, firstName: true, lastName: true } },
    session: { full: true },
    perQuestionGradedBy: { select: { id: true, firstName: true, lastName: true } },
    extraPointsAddedBy: { select: { id: true, firstName: true, lastName: true } },
  });

  return enriched;
}

/**
 * Natijani admin (owner) uchun to'liq oladi - to'g'ri javoblar bilan.
 * O'quvchidan farqli, bu yerda frozen savollarning correctOptionId si ham
 * qaytariladi (admin javoblarni tekshirishi uchun).
 * @param {string} id - natija ID
 * @returns {Promise<object>} natija
 */
async function getResultForAdmin(id) {
  const result = await prisma.testResult.findUnique({
    where: { id },
    include: { extraPoints: true, perQuestion: true },
  });

  if (!result) {
    throw new NotFoundError("Natija topilmadi");
  }

  const [enriched] = await _attachRefs([result], {
    test: { select: { id: true, title: true } },
    season: { select: { id: true, name: true } },
    subject: { select: { id: true, name: true } },
    class: { select: { id: true, name: true } },
    student: { select: { id: true, firstName: true, lastName: true, username: true } },
    // admin uchun to'liq sessiya (frozen savollar correctOptionId bilan)
    session: { full: true, withKey: true },
    perQuestionGradedBy: { select: { id: true, firstName: true, lastName: true } },
    extraPointsAddedBy: { select: { id: true, firstName: true, lastName: true } },
  });

  return enriched;
}

/**
 * Test bo'yicha barcha natijalarni sahifalash bilan oladi (test muallifi uchun).
 * @param {object} req - Express request object
 * @param {string} testId - test ID
 * @param {string} teacherId - o'qituvchi ID
 * @returns {Promise<object>} sahifalangan javob
 */
async function getResultsForTest(req, testId, teacherId) {
  const test = await prisma.test.findUnique({ where: { id: testId } });
  if (!test) {
    throw new NotFoundError("Test topilmadi");
  }
  if (test.teacherId !== teacherId.toString()) {
    throw new ForbiddenError("Bu test sizga tegishli emas");
  }

  const { page, limit, skip } = getPaginationParams(req);
  const { status } = req.query;

  const where = { testId };
  if (status && status !== "all") where.status = status;

  const [results, total] = await Promise.all([
    prisma.testResult.findMany({
      where,
      orderBy: [{ finalScore: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    prisma.testResult.count({ where }),
  ]);

  const enriched = await _attachRefs(results, {
    student: { select: { id: true, firstName: true, lastName: true } },
    session: {
      select: {
        id: true,
        status: true,
        startedAt: true,
        submittedAt: true,
        attemptNumber: true,
      },
    },
  });

  return formatPaginationResponse(enriched, total, page, limit);
}

/**
 * Natijalarga soft-ref (scalar FK) hujjatlarni qo'lda yuklab xaritalaydi.
 * Populate o'rnini bosadi — relation bo'lmagan ref'lar uchun.
 *
 * @param {Array<object>} results - TestResult obyektlari
 * @param {object} spec - qaysi ref'larni yuklash kerakligini bildiruvchi konfiguratsiya
 * @returns {Promise<Array<object>>} boyitilgan natijalar
 */
async function _attachRefs(results, spec) {
  if (results.length === 0) return results;

  const collect = (key) => [
    ...new Set(results.map((r) => r[key]).filter(Boolean)),
  ];

  // Parallel yuklashlar
  const tasks = {};

  if (spec.test) {
    tasks.test = prisma.test
      .findMany({ where: { id: { in: collect("testId") } }, select: spec.test.select })
      .then((rows) => new Map(rows.map((x) => [x.id, x])));
  }
  if (spec.season) {
    tasks.season = prisma.testSeason
      .findMany({ where: { id: { in: collect("seasonId") } }, select: spec.season.select })
      .then((rows) => new Map(rows.map((x) => [x.id, x])));
  }
  if (spec.subject) {
    tasks.subject = prisma.subject
      .findMany({ where: { id: { in: collect("subjectId") } }, select: spec.subject.select })
      .then((rows) => new Map(rows.map((x) => [x.id, x])));
  }
  if (spec.class) {
    tasks.class = prisma.class
      .findMany({ where: { id: { in: collect("classId") } }, select: spec.class.select })
      .then((rows) => new Map(rows.map((x) => [x.id, x])));
  }
  if (spec.student) {
    tasks.student = prisma.user
      .findMany({ where: { id: { in: collect("studentId") } }, select: spec.student.select })
      .then((rows) => new Map(rows.map((x) => [x.id, x])));
  }
  if (spec.session) {
    tasks.session = prisma.testSession
      .findMany(
        spec.session.full
          ? {
              where: { id: { in: collect("sessionId") } },
              include: { questions: { include: { options: true } }, answers: true },
            }
          : { where: { id: { in: collect("sessionId") } }, select: spec.session.select },
      )
      .then((rows) => {
        // Admin ko'rinishi uchun kalit qoladi, aks holda olib tashlanadi
        const mapped = rows.map((s) =>
          spec.session.full && !spec.session.withKey ? _stripSessionKey(s) : s,
        );
        return new Map(mapped.map((x) => [x.id, x]));
      });
  }

  // gradedBy / addedBy uchun foydalanuvchilarni yig'ish
  if (spec.perQuestionGradedBy) {
    const ids = [
      ...new Set(
        results.flatMap((r) => (r.perQuestion || []).map((pq) => pq.gradedBy).filter(Boolean)),
      ),
    ];
    tasks.perQuestionGradedBy = prisma.user
      .findMany({ where: { id: { in: ids } }, select: spec.perQuestionGradedBy.select })
      .then((rows) => new Map(rows.map((x) => [x.id, x])));
  }
  if (spec.extraPointsAddedBy) {
    const ids = [
      ...new Set(
        results.flatMap((r) => (r.extraPoints || []).map((ep) => ep.addedBy).filter(Boolean)),
      ),
    ];
    tasks.extraPointsAddedBy = prisma.user
      .findMany({ where: { id: { in: ids } }, select: spec.extraPointsAddedBy.select })
      .then((rows) => new Map(rows.map((x) => [x.id, x])));
  }

  const keys = Object.keys(tasks);
  const maps = await Promise.all(keys.map((k) => tasks[k]));
  const byName = {};
  keys.forEach((k, i) => {
    byName[k] = maps[i];
  });

  return results.map((r) => {
    const out = { ...r };
    if (byName.test) out.test = byName.test.get(r.testId) || null;
    if (byName.season) out.season = byName.season.get(r.seasonId) || null;
    if (byName.subject) out.subject = byName.subject.get(r.subjectId) || null;
    if (byName.class) out.class = r.classId ? byName.class.get(r.classId) || null : null;
    if (byName.student) out.student = byName.student.get(r.studentId) || null;
    if (byName.session) out.session = byName.session.get(r.sessionId) || null;
    if (byName.perQuestionGradedBy) {
      out.perQuestion = (r.perQuestion || []).map((pq) => ({
        ...pq,
        gradedBy: pq.gradedBy ? byName.perQuestionGradedBy.get(pq.gradedBy) || null : null,
      }));
    }
    if (byName.extraPointsAddedBy) {
      out.extraPoints = (r.extraPoints || []).map((ep) => ({
        ...ep,
        addedBy: ep.addedBy ? byName.extraPointsAddedBy.get(ep.addedBy) || null : null,
      }));
    }
    return out;
  });
}

/**
 * To'liq yuklangan sessiyadan frozen savollar javob kalitini (correctOptionId)
 * olib tashlaydi (o'quvchiga ko'rsatiladigan ko'rinish uchun).
 */
function _stripSessionKey(session) {
  if (!session.questions) return session;
  return {
    ...session,
    questions: session.questions.map((q) => {
      const { correctOptionId, ...rest } = q;
      return rest;
    }),
  };
}

module.exports = {
  gradeSession,
  gradeOpenAnswer,
  addExtraPoints,
  editExtraPoints,
  deleteExtraPoints,
  getResultsForStudent,
  getResultById,
  getResultForAdmin,
  getResultsForTest,
};
