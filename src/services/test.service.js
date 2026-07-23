const prisma = require("../config/prisma");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");

/**
 * Test muallifi ekanligini tekshiradi.
 */
function _assertTestOwner(test, teacherId) {
  if (test.teacherId.toString() !== teacherId.toString()) {
    throw new ForbiddenError("Bu test sizga tegishli emas");
  }
}

/**
 * O'qituvchining testlarini sahifalash bilan oladi.
 * V3: testlar endi mavsumga bog'liq emas, faqat o'qituvchi bo'yicha filtr.
 */
async function listTests(req, teacherId) {
  const { page, limit, skip } = getPaginationParams(req);
  const { search } = req.query;

  const filter = { teacherId, isActive: true };
  if (search) filter.title = { contains: search, mode: "insensitive" };

  const [tests, total] = await Promise.all([
    prisma.test.findMany({
      where: filter,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.test.count({ where: filter }),
  ]);

  // Har test uchun biriktiruvlar va savollar sonini qo'shish (preview)
  const testIds = tests.map((t) => t.id);
  const [bindingsAgg, questionsAgg] = await Promise.all([
    prisma.testBinding.groupBy({
      by: ["testId"],
      where: { testId: { in: testIds }, isActive: true },
      _count: { _all: true },
    }),
    prisma.question.groupBy({
      by: ["testId"],
      where: { testId: { in: testIds }, isActive: true },
      _count: { _all: true },
    }),
  ]);
  const bindingCountMap = new Map(
    bindingsAgg.map((b) => [b.testId, b._count._all]),
  );
  const questionCountMap = new Map(
    questionsAgg.map((q) => [q.testId, q._count._all]),
  );

  const enriched = tests.map((t) => ({
    ...t,
    bindingCount: bindingCountMap.get(t.id) || 0,
    questionCountActual: questionCountMap.get(t.id) || 0,
  }));

  return formatPaginationResponse(enriched, total, page, limit);
}

/**
 * Testni ID bo'yicha oladi.
 */
async function getTestById(id, user) {
  const test = await prisma.test.findUnique({ where: { id } });

  if (!test || !test.isActive) {
    throw new NotFoundError("Test topilmadi");
  }

  // teacher — soft ref (relation emas), qo'lda yuklab populate shaklini saqlaymiz
  const teacher = await prisma.user.findUnique({
    where: { id: test.teacherId },
    select: { id: true, firstName: true, lastName: true },
  });
  test.teacher = teacher
    ? { id: teacher.id, firstName: teacher.firstName, lastName: teacher.lastName }
    : null;

  if (
    user.role === "teacher" &&
    test.teacherId.toString() !== user.id.toString()
  ) {
    throw new ForbiddenError("Bu test sizga tegishli emas");
  }

  return test;
}

/**
 * Yangi test yaratadi (V3 - minimal: title + questionCount + timeLimitMinutes).
 * Mavsum/fan/sinflar bu yerda yo'q - TestBinding orqali keyinroq biriktiriladi.
 */
async function createTest(data, teacherId) {
  const { title, questionCount, timeLimitMinutes } = data;

  if (!title) {
    throw new BadRequestError("Test nomi majburiy");
  }

  const test = await prisma.test.create({
    data: {
      teacherId,
      title,
      questionCount: questionCount !== undefined ? Number(questionCount) : 30,
      timeLimitMinutes:
        timeLimitMinutes !== undefined ? Number(timeLimitMinutes) : 30,
    },
  });

  return test;
}

/**
 * Testni yangilaydi (title, questionCount, timeLimitMinutes).
 * questionCount o'zgartirilsa, faol biriktiruvlarning mavjud savollar soniga
 * mosligi tekshiriladi.
 */
async function updateTest(id, data, teacherId) {
  const test = await prisma.test.findUnique({ where: { id } });
  if (!test || !test.isActive) {
    throw new NotFoundError("Test topilmadi");
  }
  _assertTestOwner(test, teacherId);

  const { title, questionCount, timeLimitMinutes } = data;

  const update = {};

  if (title !== undefined) update.title = title;
  if (timeLimitMinutes !== undefined) {
    update.timeLimitMinutes = Number(timeLimitMinutes);
  }
  if (questionCount !== undefined) {
    // Avtomatik ko'rinish modeli: questionCount savollardan ko'p bo'lsa, test
    // shunchaki o'quvchilarga ko'rinmaydi - alohida cheklov shart emas.
    update.questionCount = Number(questionCount);
  }

  const updated = await prisma.test.update({ where: { id }, data: update });
  return updated;
}

/**
 * Testni o'chiradi. Sessiyalar mavjud bo'lsa soft delete.
 * Aks holda hard delete + bog'liq savollar va biriktiruvlarni ham.
 */
async function deleteTest(id, teacherId) {
  const test = await prisma.test.findUnique({ where: { id } });
  if (!test || !test.isActive) {
    throw new NotFoundError("Test topilmadi");
  }
  _assertTestOwner(test, teacherId);

  const sessionCount = await prisma.testSession.count({ where: { testId: id } });
  if (sessionCount > 0) {
    await prisma.test.update({ where: { id }, data: { isActive: false } });
    return { deleted: false };
  }

  // Hard delete: barcha bog'liq narsalar
  await Promise.all([
    prisma.question.deleteMany({ where: { testId: id } }),
    prisma.testBinding.deleteMany({ where: { testId: id } }),
  ]);
  await prisma.test.delete({ where: { id } });
  return { deleted: true };
}

module.exports = {
  listTests,
  getTestById,
  createTest,
  updateTest,
  deleteTest,
};
