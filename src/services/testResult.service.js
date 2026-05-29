const TestResult = require("../models/testResult.model");
const TestSession = require("../models/testSession.model");
const Test = require("../models/test.model");
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
 * @param {object} result - TestResult hujjati
 */
function _recomputeFinalScore(result) {
  const extraSum = result.extraPoints.reduce(
    (sum, ep) => sum + (ep.amount || 0),
    0,
  );
  result.finalScore =
    (result.autoGradedScore || 0) +
    (result.manualGradedScore || 0) +
    extraSum;

  // Holatni perQuestion bo'yicha aniqlash
  const pending = result.perQuestion.filter((pq) => pq.status === "pending");
  if (pending.length === 0) {
    result.status = "graded";
  } else if (pending.length === result.perQuestion.length) {
    result.status = "pending";
  } else {
    result.status = "partially_graded";
  }
}

/**
 * Sessiyani baholaydi: variantli savollarni avtomatik, ochiq savollarni
 * 'pending' holatda qoldiradi. TestResult yaratadi yoki yangilaydi.
 * Submit yoki expire da chaqiriladi.
 * @param {string} sessionId - session ID
 * @returns {Promise<object>} yaratilgan/yangilangan TestResult
 */
async function gradeSession(sessionId) {
  // Javob kalitini ham olish uchun select bilan
  const session = await TestSession.findById(sessionId).select(
    "+questions.correctOptionId",
  );
  if (!session) {
    throw new NotFoundError("Session topilmadi");
  }

  const test = await Test.findById(session.test);
  if (!test) {
    throw new NotFoundError("Test topilmadi");
  }

  // Javoblarni savol bo'yicha xaritalash
  const answerMap = new Map();
  for (const ans of session.answers) {
    answerMap.set(ans.question.toString(), ans);
  }

  let autoGradedScore = 0;
  const perQuestion = [];

  for (const q of session.questions) {
    const qId = q.question.toString();
    const answer = answerMap.get(qId);

    if (q.type === "standard") {
      const isCorrect =
        answer &&
        answer.selectedOptionId &&
        q.correctOptionId &&
        answer.selectedOptionId.toString() === q.correctOptionId.toString();
      const awarded = isCorrect ? q.points : 0;
      autoGradedScore += awarded;
      perQuestion.push({
        question: q.question,
        awardedPoints: awarded,
        maxPoints: q.points,
        gradedBy: null,
        status: "graded",
        feedback: undefined,
      });
    } else {
      // Ochiq savol - o'qituvchi qo'lda baholaydi
      perQuestion.push({
        question: q.question,
        awardedPoints: 0,
        maxPoints: q.points,
        gradedBy: null,
        status: "pending",
        feedback: undefined,
      });
    }
  }

  // Mavjud natijani topish yoki yangi yaratish
  let result = await TestResult.findOne({ session: sessionId });
  if (!result) {
    // V3: binding ma'lumotini olish (subject denormalizatsiya uchun)
    const TestBinding = require("../models/testBinding.model");
    const binding = await TestBinding.findById(session.binding);
    const bindingClass =
      binding && binding.classes && binding.classes.length > 0
        ? binding.classes[0]
        : undefined;
    const bindingSubject = binding ? binding.subject : undefined;

    result = new TestResult({
      session: sessionId,
      binding: session.binding,
      test: session.test,
      student: session.student,
      season: session.season,
      class: bindingClass,
      subject: bindingSubject,
    });
  }

  result.autoGradedScore = autoGradedScore;
  result.manualGradedScore = 0;
  result.perQuestion = perQuestion;
  // extraPoints saqlanib qoladi (agar oldindan mavjud bo'lsa)

  _recomputeFinalScore(result);
  await result.save();

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

  const result = await TestResult.findById(resultId);
  if (!result) {
    throw new NotFoundError("Natija topilmadi");
  }

  const test = await Test.findById(result.test);
  if (!test) {
    throw new NotFoundError("Test topilmadi");
  }
  if (test.teacher.toString() !== teacherId.toString()) {
    throw new ForbiddenError("Bu test sizga tegishli emas");
  }

  const pq = result.perQuestion.find(
    (item) => item.question.toString() === questionId.toString(),
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

  pq.awardedPoints = points;
  pq.status = "graded";
  pq.gradedBy = teacherId;
  if (feedback !== undefined) pq.feedback = feedback;

  // Qo'lda baholangan ballarni qayta yig'ish
  // (auto baholangan savollar gradeSession da hisoblangan, bu yerda
  //  faqat o'qituvchi tomonidan baholangan savollar yig'iladi)
  result.manualGradedScore = result.perQuestion
    .filter((item) => item.gradedBy)
    .reduce((sum, item) => sum + (item.awardedPoints || 0), 0);

  _recomputeFinalScore(result);
  await result.save();

  return result;
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

  const result = await TestResult.findById(resultId);
  if (!result) {
    throw new NotFoundError("Natija topilmadi");
  }

  const test = await Test.findById(result.test);
  if (!test) {
    throw new NotFoundError("Test topilmadi");
  }
  if (test.teacher.toString() !== teacherId.toString()) {
    throw new ForbiddenError("Bu test sizga tegishli emas");
  }

  result.extraPoints.push({
    amount: Number(amount),
    reason,
    addedBy: teacherId,
    addedAt: new Date(),
  });

  _recomputeFinalScore(result);
  await result.save();

  return result;
}

/**
 * O'quvchining natijalarini oladi.
 * @param {string} studentId - o'quvchi ID
 * @param {string} [seasonId] - mavsum ID (ixtiyoriy filtr)
 * @returns {Promise<Array>} natijalar
 */
async function getResultsForStudent(studentId, seasonId) {
  const filter = { student: studentId };
  if (seasonId) filter.season = seasonId;

  return TestResult.find(filter)
    .populate("test", "title type minScore maxScore")
    .populate("season", "name")
    .populate("subject", "name")
    .populate("class", "name")
    .sort({ createdAt: -1 });
}

/**
 * Natijani ID bo'yicha oladi. O'quvchi o'zinikini, o'qituvchi o'z testiniki ko'ra oladi.
 * @param {string} id - natija ID
 * @param {object} user - so'rov yuborgan foydalanuvchi
 * @returns {Promise<object>} natija
 */
async function getResultById(id, user) {
  const result = await TestResult.findById(id)
    .populate("test", "title type minScore maxScore teacher")
    .populate("season", "name")
    .populate("subject", "name")
    .populate("class", "name")
    .populate("student", "firstName lastName")
    .populate("session")
    .populate("perQuestion.gradedBy", "firstName lastName")
    .populate("extraPoints.addedBy", "firstName lastName");

  if (!result) {
    throw new NotFoundError("Natija topilmadi");
  }

  if (user.role === "student") {
    if (result.student._id.toString() !== user._id.toString()) {
      throw new ForbiddenError("Bu natija sizga tegishli emas");
    }
  } else if (user.role === "teacher") {
    if (result.test.teacher.toString() !== user._id.toString()) {
      throw new ForbiddenError("Bu natija sizning testingizga tegishli emas");
    }
  }

  return result;
}

/**
 * Test bo'yicha barcha natijalarni sahifalash bilan oladi (test muallifi uchun).
 * @param {object} req - Express request object
 * @param {string} testId - test ID
 * @param {string} teacherId - o'qituvchi ID
 * @returns {Promise<object>} sahifalangan javob
 */
async function getResultsForTest(req, testId, teacherId) {
  const test = await Test.findById(testId);
  if (!test) {
    throw new NotFoundError("Test topilmadi");
  }
  if (test.teacher.toString() !== teacherId.toString()) {
    throw new ForbiddenError("Bu test sizga tegishli emas");
  }

  const { page, limit, skip } = getPaginationParams(req);
  const { status } = req.query;

  const filter = { test: testId };
  if (status && status !== "all") filter.status = status;

  const [results, total] = await Promise.all([
    TestResult.find(filter)
      .populate("student", "firstName lastName")
      .populate("session", "status startedAt submittedAt attemptNumber")
      .sort({ finalScore: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit),
    TestResult.countDocuments(filter),
  ]);

  return formatPaginationResponse(results, total, page, limit);
}

module.exports = {
  gradeSession,
  gradeOpenAnswer,
  addExtraPoints,
  getResultsForStudent,
  getResultById,
  getResultsForTest,
};
