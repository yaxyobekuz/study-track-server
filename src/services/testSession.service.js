const TestSession = require("../models/testSession.model");
const Test = require("../models/test.model");
const TestBinding = require("../models/testBinding.model");
const TestSeason = require("../models/testSeason.model");
const Question = require("../models/question.model");
const User = require("../models/user.model");
const TestSettings = require("../models/testSettings.model");
const { distributePoints } = require("../helpers/scoring.helper");
const { gradeSession } = require("./testResult.service");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");

/**
 * Massivni Fisher-Yates algoritmi bilan aralashtiradi (nusxa qaytaradi).
 * @param {Array} array - aralashtiriladigan massiv
 * @returns {Array} aralashtirilgan yangi massiv
 */
function _shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Sessiyadan javob kalitini (correctOptionId) olib tashlaydi.
 * O'quvchiga yuboriladigan har bir javobda chaqirilishi kerak.
 * @param {object} session - TestSession hujjati yoki obyekti
 * @returns {object} kalitsiz sessiya obyekti
 */
function _stripAnswerKey(session) {
  const obj = session.toObject ? session.toObject() : session;
  if (obj.questions) {
    obj.questions = obj.questions.map((q) => {
      const { correctOptionId, ...rest } = q;
      return rest;
    });
  }
  return obj;
}

/**
 * Savol bankidagi savoldan muzlatilgan snapshot yaratadi.
 * @param {object} question - Question hujjati
 * @returns {object} frozen question obyekti
 */
function _freezeQuestion(question) {
  const frozen = {
    question: question._id,
    type: question.type,
    text: question.text,
    image: question.image || null,
    difficulty: question.difficulty || "medium",
    // points qiyinlik bo'yicha distributePoints() da o'rnatiladi
    points: 0,
    options: [],
    correctOptionId: null,
  };

  if (question.type === "standard") {
    const shuffledOptions = _shuffle(question.options);
    frozen.options = shuffledOptions.map((opt) => ({
      optionId: opt._id,
      text: opt.text,
      image: opt.image || null,
    }));
    const correct = question.options.find((opt) => opt.isCorrect);
    frozen.correctOptionId = correct ? correct._id : null;
  }

  return frozen;
}

/**
 * Vaqti tugagan sessiyani yakunlaydi: holatni 'expired' qiladi va baholaydi.
 * Cron job va lazy-expiry tomonidan chaqiriladi.
 * @param {object} session - TestSession hujjati
 * @returns {Promise<object>} baholangan natija
 */
async function finalizeExpiredSession(session) {
  if (session.status !== "in_progress") {
    return null;
  }
  session.status = "expired";
  session.submittedAt = new Date();
  await session.save();
  return gradeSession(session._id);
}

/**
 * O'quvchi uchun yangi test sessiyasini boshlaydi yoki davom etayotganini qaytaradi.
 * V3: biriktirish (TestBinding) asosida ishlaydi.
 *
 * @param {string} bindingId - biriktirish ID
 * @param {string} studentId - o'quvchi ID
 * @returns {Promise<object>} kalitsiz sessiya obyekti
 */
async function startSession(bindingId, studentId) {
  const binding = await TestBinding.findById(bindingId).populate("test");
  if (!binding || !binding.isActive) {
    throw new NotFoundError("Biriktiruv topilmadi");
  }
  const test = binding.test;
  if (!test || !test.isActive) {
    throw new NotFoundError("Test topilmadi");
  }

  // Test savollari yetarli bo'lsa (faol savol soni >= questionCount) ko'rinadi
  const activeCount = await Question.countDocuments({
    test: test._id,
    isActive: true,
  });
  if (activeCount < test.questionCount) {
    throw new ForbiddenError("Bu test hali o'quvchilar uchun tayyor emas");
  }

  // Mavsum tekshiruvi - o'quvchi faqat boshlanish va tugash vaqti oralig'ida ishlay oladi
  const season = await TestSeason.findById(binding.season);
  if (!season || !season.isActive) {
    throw new ForbiddenError("Test mavsumi faol emas");
  }
  const now = new Date();
  if (now < season.startDate) {
    throw new ForbiddenError("Test mavsumi hali boshlanmagan");
  }
  if (now > season.endDate) {
    throw new ForbiddenError("Test mavsumi yakunlangan");
  }

  // O'quvchi biriktiruv sinflaridan birortasiga tegishli ekanligini tekshirish
  const student = await User.findById(studentId).select("classes");
  if (!student) {
    throw new NotFoundError("O'quvchi topilmadi");
  }
  const bindingClassIds = (binding.classes || []).map((c) => c.toString());
  const studentClassIds = (student.classes || []).map((c) => c.toString());
  const intersects = studentClassIds.some((sc) =>
    bindingClassIds.includes(sc),
  );
  if (!intersects) {
    throw new ForbiddenError(
      "Siz ushbu biriktiruvga tegishli sinflarning birortasida emassiz",
    );
  }

  // Mavjud sessiyalar (biriktiruv bo'yicha)
  const sessions = await TestSession.find({
    binding: bindingId,
    student: studentId,
  }).sort({ attemptNumber: 1 });

  // Davom etayotgan sessiya bormi?
  const inProgress = sessions.find((s) => s.status === "in_progress");
  if (inProgress) {
    if (now > inProgress.expiresAt) {
      await finalizeExpiredSession(inProgress);
    } else {
      return _stripAnswerKey(inProgress);
    }
  }

  // Urinishlar sonini hisoblash
  const attemptsCount = sessions.length;
  const grantsCount = (binding.reopenGrants || []).filter(
    (g) => g.student.toString() === studentId.toString(),
  ).length;
  const allowedAttempts = 1 + grantsCount;

  if (attemptsCount >= allowedAttempts) {
    throw new ForbiddenError(
      "Siz bu testni allaqachon topshirgansiz. Qayta urinish uchun o'qituvchidan ruxsat so'rang.",
    );
  }

  const attemptNumber = attemptsCount + 1;

  // Test'ga tegishli faol savollarni olish
  const activeQuestions = await Question.find({
    test: test._id,
    isActive: true,
  });
  if (activeQuestions.length < test.questionCount) {
    throw new BadRequestError(
      `Test'da yetarli faol savol yo'q (${activeQuestions.length}/${test.questionCount})`,
    );
  }

  const selected = _shuffle(activeQuestions).slice(0, test.questionCount);
  const frozenQuestions = selected.map(_freezeQuestion);

  // Tizimdagi max ballni savollarga qiyinlik bo'yicha taqsimlash
  const settings = await TestSettings.getSettings();
  distributePoints(frozenQuestions, settings.maxScore);

  const expiresAt = new Date(
    now.getTime() + test.timeLimitMinutes * 60 * 1000,
  );

  const session = await TestSession.create({
    binding: bindingId,
    test: test._id,
    student: studentId,
    season: binding.season,
    attemptNumber,
    status: "in_progress",
    startedAt: now,
    expiresAt,
    gradingMin: settings.minScore,
    gradingMax: settings.maxScore,
    questions: frozenQuestions,
    answers: [],
  });

  return _stripAnswerKey(session);
}

/**
 * Sessiyaga bitta javobni saqlaydi (upsert).
 * @param {string} sessionId - session ID
 * @param {string} studentId - o'quvchi ID
 * @param {object} data - { questionId, selectedOptionId, textAnswer }
 * @returns {Promise<object>} kalitsiz sessiya obyekti
 */
async function saveAnswer(sessionId, studentId, data) {
  const { questionId, selectedOptionId, textAnswer } = data;

  if (!questionId) {
    throw new BadRequestError("Savol ID majburiy");
  }

  const session = await TestSession.findOne({
    _id: sessionId,
    student: studentId,
  });
  if (!session) {
    throw new NotFoundError("Sessiya topilmadi");
  }

  if (session.status !== "in_progress") {
    throw new ForbiddenError("Bu sessiya yakunlangan");
  }

  // Lazy expiry
  if (new Date() > session.expiresAt) {
    await finalizeExpiredSession(session);
    throw new ForbiddenError("Test vaqti tugadi");
  }

  // Savol sessiyada mavjudligini tekshirish
  const question = session.questions.find(
    (q) => q.question.toString() === questionId.toString(),
  );
  if (!question) {
    throw new BadRequestError("Savol bu sessiyada mavjud emas");
  }

  // Variantli savol uchun tanlangan variant tekshiruvi
  if (question.type === "standard") {
    if (!selectedOptionId) {
      throw new BadRequestError("Variant tanlanmagan");
    }
    const optionExists = question.options.some(
      (opt) => opt.optionId.toString() === selectedOptionId.toString(),
    );
    if (!optionExists) {
      throw new BadRequestError("Tanlangan variant savolda mavjud emas");
    }
  }

  // Javobni upsert qilish
  const existing = session.answers.find(
    (a) => a.question.toString() === questionId.toString(),
  );
  if (existing) {
    existing.selectedOptionId =
      question.type === "standard" ? selectedOptionId : null;
    existing.textAnswer = question.type === "open" ? textAnswer : undefined;
    existing.answeredAt = new Date();
  } else {
    session.answers.push({
      question: questionId,
      selectedOptionId: question.type === "standard" ? selectedOptionId : null,
      textAnswer: question.type === "open" ? textAnswer : undefined,
      answeredAt: new Date(),
    });
  }

  await session.save();
  return _stripAnswerKey(session);
}

/**
 * Sessiyani topshiradi va baholaydi.
 * @param {string} sessionId - session ID
 * @param {string} studentId - o'quvchi ID
 * @returns {Promise<object>} { session, result }
 */
async function submitSession(sessionId, studentId) {
  const session = await TestSession.findOne({
    _id: sessionId,
    student: studentId,
  });
  if (!session) {
    throw new NotFoundError("Sessiya topilmadi");
  }

  if (session.status !== "in_progress") {
    throw new ForbiddenError("Bu sessiya allaqachon yakunlangan");
  }

  // Vaqti tugagan bo'lsa ham topshiramiz (saqlangan javoblar bilan)
  session.status = "submitted";
  session.submittedAt = new Date();
  await session.save();

  const result = await gradeSession(session._id);

  return { session: _stripAnswerKey(session), result };
}

/**
 * O'quvchining sessiyalarini oladi.
 * @param {string} studentId - o'quvchi ID
 * @param {string} [seasonId] - mavsum ID (ixtiyoriy filtr)
 * @returns {Promise<Array>} kalitsiz sessiyalar
 */
async function getStudentSessions(studentId, seasonId) {
  const filter = { student: studentId };
  if (seasonId) filter.season = seasonId;

  const sessions = await TestSession.find(filter)
    .populate("test", "title type")
    .populate("season", "name")
    .sort({ createdAt: -1 });

  return sessions.map(_stripAnswerKey);
}

/**
 * O'quvchining bitta sessiyasini oladi (lazy-expiry bilan, kalitsiz).
 * @param {string} sessionId - session ID
 * @param {string} studentId - o'quvchi ID
 * @returns {Promise<object>} kalitsiz sessiya obyekti
 */
async function getSessionForStudent(sessionId, studentId) {
  const session = await TestSession.findOne({
    _id: sessionId,
    student: studentId,
  })
    .populate("test", "title type timeLimitMinutes")
    .populate("season", "name");
  if (!session) {
    throw new NotFoundError("Sessiya topilmadi");
  }

  // Lazy expiry
  if (session.status === "in_progress" && new Date() > session.expiresAt) {
    await finalizeExpiredSession(session);
  }

  return _stripAnswerKey(session);
}

/**
 * Test bo'yicha barcha sessiyalarni oladi (test muallifi uchun).
 * V3: testning barcha biriktiruvlaridagi sessiyalar yig'iladi, har sessiya
 * binding konteksti bilan qaytariladi.
 *
 * @param {string} testId - test ID
 * @param {string} teacherId - o'qituvchi ID
 * @returns {Promise<Array>} kalitsiz sessiyalar
 */
async function getSessionsForTeacher(testId, teacherId) {
  const test = await Test.findById(testId);
  if (!test || !test.isActive) {
    throw new NotFoundError("Test topilmadi");
  }
  if (test.teacher.toString() !== teacherId.toString()) {
    throw new ForbiddenError("Bu test sizga tegishli emas");
  }

  const sessions = await TestSession.find({ test: testId })
    .populate("student", "firstName lastName")
    .populate({
      path: "binding",
      populate: [
        { path: "season", select: "name" },
        { path: "subject", select: "name" },
        { path: "classes", select: "name" },
      ],
    })
    .sort({ createdAt: -1 });

  return sessions.map(_stripAnswerKey);
}

module.exports = {
  startSession,
  saveAnswer,
  submitSession,
  finalizeExpiredSession,
  getStudentSessions,
  getSessionForStudent,
  getSessionsForTeacher,
};
