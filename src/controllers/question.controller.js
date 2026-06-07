const asyncHandler = require("../middleware/async.middleware");
const questionService = require("../services/question.service");

/**
 * Berilgan test'ning savollar ro'yxati (o'qituvchi - o'z testi).
 * GET /api/tests/:testId/questions
 */
const getQuestionsForTest = asyncHandler(async (req, res) => {
  const questions = await questionService.listQuestionsForTest(
    req.params.testId,
    req.user._id,
  );
  res.json({
    success: true,
    data: questions,
  });
});

/**
 * Test ichida yangi savol yaratish (multipart).
 * POST /api/tests/:testId/questions
 */
const createQuestion = asyncHandler(async (req, res) => {
  const question = await questionService.createQuestion(
    req.params.testId,
    req.body,
    req.files,
    req.user._id,
  );
  res.status(201).json({
    success: true,
    data: question,
  });
});

/**
 * Savollarni tartiblash.
 * PATCH /api/tests/:testId/questions/reorder
 */
const reorderQuestions = asyncHandler(async (req, res) => {
  await questionService.reorderQuestions(
    req.params.testId,
    req.body.orderedIds,
    req.user._id,
  );
  res.json({
    success: true,
    message: "Tartib yangilandi",
  });
});

/**
 * Savolni yangilash (multipart).
 * PUT /api/questions/:id
 */
const updateQuestion = asyncHandler(async (req, res) => {
  const question = await questionService.updateQuestion(
    req.params.id,
    req.body,
    req.files,
    req.user._id,
  );
  res.json({
    success: true,
    data: question,
  });
});

/**
 * Savolni o'chirish (soft delete).
 * DELETE /api/questions/:id
 */
const deleteQuestion = asyncHandler(async (req, res) => {
  await questionService.deactivateQuestion(req.params.id, req.user._id);
  res.json({
    success: true,
    message: "Savol o'chirildi",
  });
});

/**
 * Testning barcha savollarini o'chirish (soft delete).
 * DELETE /api/tests/:testId/questions
 */
const deleteAllQuestionsForTest = asyncHandler(async (req, res) => {
  const result = await questionService.deactivateAllQuestions(
    req.params.testId,
    req.user._id,
  );
  res.json({
    success: true,
    data: result,
    message: "Barcha savollar o'chirildi",
  });
});

module.exports = {
  getQuestionsForTest,
  createQuestion,
  reorderQuestions,
  updateQuestion,
  deleteQuestion,
  deleteAllQuestionsForTest,
};
