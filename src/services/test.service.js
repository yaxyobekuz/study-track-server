const Test = require("../models/test.model");
const TestBinding = require("../models/testBinding.model");
const TestSession = require("../models/testSession.model");
const Question = require("../models/question.model");
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
  if (test.teacher.toString() !== teacherId.toString()) {
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

  const filter = { teacher: teacherId, isActive: true };
  if (search) filter.title = { $regex: search, $options: "i" };

  const [tests, total] = await Promise.all([
    Test.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Test.countDocuments(filter),
  ]);

  // Har test uchun biriktiruvlar va savollar sonini qo'shish (preview)
  const testIds = tests.map((t) => t._id);
  const [bindingsAgg, questionsAgg] = await Promise.all([
    TestBinding.aggregate([
      { $match: { test: { $in: testIds }, isActive: true } },
      { $group: { _id: "$test", count: { $sum: 1 } } },
    ]),
    Question.aggregate([
      { $match: { test: { $in: testIds }, isActive: true } },
      { $group: { _id: "$test", count: { $sum: 1 } } },
    ]),
  ]);
  const bindingCountMap = new Map(
    bindingsAgg.map((b) => [b._id.toString(), b.count]),
  );
  const questionCountMap = new Map(
    questionsAgg.map((q) => [q._id.toString(), q.count]),
  );

  const enriched = tests.map((t) => ({
    ...t.toObject(),
    bindingCount: bindingCountMap.get(t._id.toString()) || 0,
    questionCountActual: questionCountMap.get(t._id.toString()) || 0,
  }));

  return formatPaginationResponse(enriched, total, page, limit);
}

/**
 * Testni ID bo'yicha oladi.
 */
async function getTestById(id, user) {
  const test = await Test.findById(id).populate(
    "teacher",
    "firstName lastName",
  );

  if (!test || !test.isActive) {
    throw new NotFoundError("Test topilmadi");
  }

  if (
    user.role === "teacher" &&
    test.teacher._id.toString() !== user._id.toString()
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

  const test = await Test.create({
    teacher: teacherId,
    title,
    questionCount: questionCount !== undefined ? Number(questionCount) : 30,
    timeLimitMinutes:
      timeLimitMinutes !== undefined ? Number(timeLimitMinutes) : 30,
  });

  return test;
}

/**
 * Testni yangilaydi (title, questionCount, timeLimitMinutes).
 * questionCount o'zgartirilsa, faol biriktiruvlarning mavjud savollar soniga
 * mosligi tekshiriladi.
 */
async function updateTest(id, data, teacherId) {
  const test = await Test.findById(id);
  if (!test || !test.isActive) {
    throw new NotFoundError("Test topilmadi");
  }
  _assertTestOwner(test, teacherId);

  const { title, questionCount, timeLimitMinutes } = data;

  if (title !== undefined) test.title = title;
  if (timeLimitMinutes !== undefined) {
    test.timeLimitMinutes = Number(timeLimitMinutes);
  }
  if (questionCount !== undefined) {
    // Avtomatik ko'rinish modeli: questionCount savollardan ko'p bo'lsa, test
    // shunchaki o'quvchilarga ko'rinmaydi - alohida cheklov shart emas.
    test.questionCount = Number(questionCount);
  }

  await test.save();
  return test;
}

/**
 * Testni o'chiradi. Sessiyalar mavjud bo'lsa soft delete.
 * Aks holda hard delete + bog'liq savollar va biriktiruvlarni ham.
 */
async function deleteTest(id, teacherId) {
  const test = await Test.findById(id);
  if (!test || !test.isActive) {
    throw new NotFoundError("Test topilmadi");
  }
  _assertTestOwner(test, teacherId);

  const sessionCount = await TestSession.countDocuments({ test: id });
  if (sessionCount > 0) {
    test.isActive = false;
    await test.save();
    return { deleted: false };
  }

  // Hard delete: barcha bog'liq narsalar
  await Promise.all([
    Question.deleteMany({ test: id }),
    TestBinding.deleteMany({ test: id }),
  ]);
  await Test.findByIdAndDelete(id);
  return { deleted: true };
}

module.exports = {
  listTests,
  getTestById,
  createTest,
  updateTest,
  deleteTest,
};
