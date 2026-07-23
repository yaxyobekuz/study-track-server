const prisma = require("../config/prisma");
const { getTestSettings } = require("./settings.service");
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
 * @param {object} session - TestSession obyekti (questions/answers bilan)
 * @returns {object} kalitsiz sessiya obyekti
 */
function _stripAnswerKey(session) {
  const obj = { ...session };
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
 * @param {object} question - Question obyekti (options bilan)
 * @returns {object} frozen question obyekti (child create shakli uchun tayyor)
 */
function _freezeQuestion(question) {
  const frozen = {
    questionId: question.id,
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
      optionId: opt.id,
      text: opt.text,
      image: opt.image || null,
    }));
    const correct = question.options.find((opt) => opt.isCorrect);
    frozen.correctOptionId = correct ? correct.id : null;
  }

  return frozen;
}

/**
 * Sessiyani to'liq (questions+options, answers bilan) qayta yuklaydi.
 * @param {string} sessionId
 * @returns {Promise<object|null>}
 */
async function _loadFullSession(sessionId) {
  return prisma.testSession.findUnique({
    where: { id: sessionId },
    include: {
      questions: { orderBy: { position: "asc" }, include: { options: { orderBy: { position: "asc" } } } },
      answers: true,
    },
  });
}

/**
 * Vaqti tugagan sessiyani yakunlaydi: holatni 'expired' qiladi va baholaydi.
 * Cron job va lazy-expiry tomonidan chaqiriladi.
 * @param {object} session - TestSession obyekti
 * @returns {Promise<object>} baholangan natija
 */
async function finalizeExpiredSession(session) {
  if (session.status !== "in_progress") {
    return null;
  }
  await prisma.testSession.update({
    where: { id: session.id },
    data: { status: "expired", submittedAt: new Date() },
  });
  return gradeSession(session.id);
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
  const binding = await prisma.testBinding.findUnique({
    where: { id: bindingId },
    include: { classes: true, reopenGrants: true },
  });
  if (!binding || !binding.isActive) {
    throw new NotFoundError("Biriktiruv topilmadi");
  }
  const test = await prisma.test.findUnique({ where: { id: binding.testId } });
  if (!test || !test.isActive) {
    throw new NotFoundError("Test topilmadi");
  }

  // Test savollari yetarli bo'lsa (faol savol soni >= questionCount) ko'rinadi
  const activeCount = await prisma.question.count({
    where: { testId: test.id, isActive: true },
  });
  if (activeCount < test.questionCount) {
    throw new ForbiddenError("Bu test hali o'quvchilar uchun tayyor emas");
  }

  // Mavsum tekshiruvi - o'quvchi faqat boshlanish va tugash vaqti oralig'ida ishlay oladi
  const season = await prisma.testSeason.findUnique({ where: { id: binding.seasonId } });
  if (!season || !season.isActive) {
    throw new ForbiddenError("Test mavsumi faol emas");
  }
  if (season.finalizedAt) {
    throw new ForbiddenError("Test mavsumi to'liq yakunlangan");
  }
  const now = new Date();
  if (now < season.startDate) {
    throw new ForbiddenError("Test mavsumi hali boshlanmagan");
  }
  if (now > season.endDate) {
    throw new ForbiddenError("Test mavsumi yakunlangan");
  }

  // O'quvchi biriktiruv sinflaridan birortasiga tegishli ekanligini tekshirish
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    include: { classes: { select: { classId: true } } },
  });
  if (!student) {
    throw new NotFoundError("O'quvchi topilmadi");
  }
  const bindingClassIds = (binding.classes || []).map((c) => c.classId.toString());
  const studentClassIds = (student.classes || []).map((c) => c.classId.toString());
  const intersects = studentClassIds.some((sc) =>
    bindingClassIds.includes(sc),
  );
  if (!intersects) {
    throw new ForbiddenError(
      "Siz ushbu biriktiruvga tegishli sinflarning birortasida emassiz",
    );
  }

  // Mavjud sessiyalar (biriktiruv bo'yicha)
  const sessions = await prisma.testSession.findMany({
    where: { bindingId, studentId },
    orderBy: { attemptNumber: "asc" },
    include: {
      questions: { orderBy: { position: "asc" }, include: { options: { orderBy: { position: "asc" } } } },
      answers: true,
    },
  });

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
    (g) => g.studentId.toString() === studentId.toString(),
  ).length;
  const allowedAttempts = 1 + grantsCount;

  if (attemptsCount >= allowedAttempts) {
    throw new ForbiddenError(
      "Siz bu testni allaqachon topshirgansiz. Qayta urinish uchun o'qituvchidan ruxsat so'rang.",
    );
  }

  const attemptNumber = attemptsCount + 1;

  // Test'ga tegishli faol savollarni olish
  const activeQuestions = await prisma.question.findMany({
    where: { testId: test.id, isActive: true },
    include: { options: true },
  });
  if (activeQuestions.length < test.questionCount) {
    throw new BadRequestError(
      `Test'da yetarli faol savol yo'q (${activeQuestions.length}/${test.questionCount})`,
    );
  }

  const selected = _shuffle(activeQuestions).slice(0, test.questionCount);
  const frozenQuestions = selected.map(_freezeQuestion);

  // Tizimdagi max ballni savollarga qiyinlik bo'yicha taqsimlash
  const settings = await getTestSettings();
  distributePoints(frozenQuestions, settings.maxScore);

  const expiresAt = new Date(
    now.getTime() + test.timeLimitMinutes * 60 * 1000,
  );

  await prisma.testSession.create({
    data: {
      bindingId,
      testId: test.id,
      studentId,
      seasonId: binding.seasonId,
      attemptNumber,
      status: "in_progress",
      startedAt: now,
      expiresAt,
      gradingMin: settings.minScore,
      gradingMax: settings.maxScore,
      questions: {
        create: frozenQuestions.map((fq, qIndex) => ({
          questionId: fq.questionId,
          type: fq.type,
          text: fq.text,
          image: fq.image,
          difficulty: fq.difficulty,
          points: fq.points,
          correctOptionId: fq.correctOptionId,
          position: qIndex,
          options: {
            create: fq.options.map((opt, oIndex) => ({
              optionId: opt.optionId,
              text: opt.text,
              image: opt.image,
              position: oIndex,
            })),
          },
        })),
      },
    },
  });

  const session = await _loadFullSession(
    (
      await prisma.testSession.findFirst({
        where: { bindingId, studentId, attemptNumber },
        select: { id: true },
      })
    ).id,
  );

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

  const session = await prisma.testSession.findFirst({
    where: { id: sessionId, studentId },
    include: {
      questions: { include: { options: true } },
      answers: true,
    },
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
    (q) => q.questionId.toString() === questionId.toString(),
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
    (a) => a.questionId.toString() === questionId.toString(),
  );
  if (existing) {
    await prisma.testSessionAnswer.update({
      where: { id: existing.id },
      data: {
        selectedOptionId: question.type === "standard" ? selectedOptionId : null,
        textAnswer: question.type === "open" ? textAnswer : null,
        answeredAt: new Date(),
      },
    });
  } else {
    await prisma.testSessionAnswer.create({
      data: {
        sessionId,
        questionId,
        selectedOptionId: question.type === "standard" ? selectedOptionId : null,
        textAnswer: question.type === "open" ? textAnswer : null,
        answeredAt: new Date(),
      },
    });
  }

  const full = await _loadFullSession(sessionId);
  return _stripAnswerKey(full);
}

/**
 * Sessiyani topshiradi va baholaydi.
 * @param {string} sessionId - session ID
 * @param {string} studentId - o'quvchi ID
 * @returns {Promise<object>} { session, result }
 */
async function submitSession(sessionId, studentId) {
  const session = await prisma.testSession.findFirst({
    where: { id: sessionId, studentId },
  });
  if (!session) {
    throw new NotFoundError("Sessiya topilmadi");
  }

  if (session.status !== "in_progress") {
    throw new ForbiddenError("Bu sessiya allaqachon yakunlangan");
  }

  // Vaqti tugagan bo'lsa ham topshiramiz (saqlangan javoblar bilan)
  await prisma.testSession.update({
    where: { id: session.id },
    data: { status: "submitted", submittedAt: new Date() },
  });

  const result = await gradeSession(session.id);

  const full = await _loadFullSession(sessionId);
  return { session: _stripAnswerKey(full), result };
}

/**
 * O'quvchining sessiyalarini oladi.
 * @param {string} studentId - o'quvchi ID
 * @param {string} [seasonId] - mavsum ID (ixtiyoriy filtr)
 * @returns {Promise<Array>} kalitsiz sessiyalar
 */
async function getStudentSessions(studentId, seasonId) {
  const where = { studentId };
  if (seasonId) where.seasonId = seasonId;

  const sessions = await prisma.testSession.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      questions: { orderBy: { position: "asc" }, include: { options: { orderBy: { position: "asc" } } } },
      answers: true,
    },
  });

  // test, season — soft ref (relation YO'Q), qo'lda yuklaymiz
  const testIds = [...new Set(sessions.map((s) => s.testId).filter(Boolean))];
  const seasonIds = [...new Set(sessions.map((s) => s.seasonId).filter(Boolean))];
  const [tests, seasons] = await Promise.all([
    prisma.test.findMany({
      where: { id: { in: testIds } },
      select: { id: true, title: true },
    }),
    prisma.testSeason.findMany({
      where: { id: { in: seasonIds } },
      select: { id: true, name: true },
    }),
  ]);
  // "title type" so'ralgan — type Test'da yo'q, faqat mavjud maydonlar tanlanadi
  const testMap = new Map(tests.map((t) => [t.id, t]));
  const seasonMap = new Map(seasons.map((s) => [s.id, s]));

  return sessions.map((s) => {
    const stripped = _stripAnswerKey(s);
    stripped.test = testMap.get(s.testId) || null;
    stripped.season = seasonMap.get(s.seasonId) || null;
    return stripped;
  });
}

/**
 * O'quvchining bitta sessiyasini oladi (lazy-expiry bilan, kalitsiz).
 * @param {string} sessionId - session ID
 * @param {string} studentId - o'quvchi ID
 * @returns {Promise<object>} kalitsiz sessiya obyekti
 */
async function getSessionForStudent(sessionId, studentId) {
  let session = await prisma.testSession.findFirst({
    where: { id: sessionId, studentId },
    include: {
      questions: { orderBy: { position: "asc" }, include: { options: { orderBy: { position: "asc" } } } },
      answers: true,
    },
  });
  if (!session) {
    throw new NotFoundError("Sessiya topilmadi");
  }

  // Lazy expiry
  if (session.status === "in_progress" && new Date() > session.expiresAt) {
    await finalizeExpiredSession(session);
    session = await _loadFullSession(sessionId);
  }

  const stripped = _stripAnswerKey(session);

  // test, season — soft ref, qo'lda yuklaymiz (title timeLimitMinutes / name)
  const [test, season] = await Promise.all([
    prisma.test.findUnique({
      where: { id: session.testId },
      select: { id: true, title: true, timeLimitMinutes: true },
    }),
    prisma.testSeason.findUnique({
      where: { id: session.seasonId },
      select: { id: true, name: true },
    }),
  ]);
  stripped.test = test || null;
  stripped.season = season || null;

  return stripped;
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
  const test = await prisma.test.findUnique({ where: { id: testId } });
  if (!test || !test.isActive) {
    throw new NotFoundError("Test topilmadi");
  }
  if (test.teacherId.toString() !== teacherId.toString()) {
    throw new ForbiddenError("Bu test sizga tegishli emas");
  }

  const sessions = await prisma.testSession.findMany({
    where: { testId },
    orderBy: { createdAt: "desc" },
    include: {
      questions: { orderBy: { position: "asc" }, include: { options: { orderBy: { position: "asc" } } } },
      answers: true,
    },
  });

  // student, binding (+season/subject/classes) — soft ref, qo'lda yuklaymiz
  const studentIds = [...new Set(sessions.map((s) => s.studentId).filter(Boolean))];
  const bindingIds = [...new Set(sessions.map((s) => s.bindingId).filter(Boolean))];

  const [students, bindings] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: studentIds } },
      select: { id: true, firstName: true, lastName: true },
    }),
    prisma.testBinding.findMany({
      where: { id: { in: bindingIds } },
      include: { classes: true },
    }),
  ]);

  // binding'lar uchun season/subject/class'larni yuklab xaritalash
  const seasonIds = [...new Set(bindings.map((b) => b.seasonId).filter(Boolean))];
  const subjectIds = [...new Set(bindings.map((b) => b.subjectId).filter(Boolean))];
  const classIds = [
    ...new Set(bindings.flatMap((b) => b.classes.map((c) => c.classId)).filter(Boolean)),
  ];
  const [seasons, subjects, classes] = await Promise.all([
    prisma.testSeason.findMany({
      where: { id: { in: seasonIds } },
      select: { id: true, name: true },
    }),
    prisma.subject.findMany({
      where: { id: { in: subjectIds } },
      select: { id: true, name: true },
    }),
    prisma.class.findMany({
      where: { id: { in: classIds } },
      select: { id: true, name: true },
    }),
  ]);

  const studentMap = new Map(students.map((s) => [s.id, s]));
  const seasonMap = new Map(seasons.map((s) => [s.id, s]));
  const subjectMap = new Map(subjects.map((s) => [s.id, s]));
  const classMap = new Map(classes.map((c) => [c.id, c]));
  const bindingMap = new Map(
    bindings.map((b) => [
      b.id,
      {
        ...b,
        season: seasonMap.get(b.seasonId) || null,
        subject: subjectMap.get(b.subjectId) || null,
        classes: b.classes.map((c) => classMap.get(c.classId)).filter(Boolean),
      },
    ]),
  );

  return sessions.map((s) => {
    const stripped = _stripAnswerKey(s);
    stripped.student = studentMap.get(s.studentId) || null;
    stripped.binding = bindingMap.get(s.bindingId) || null;
    return stripped;
  });
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
