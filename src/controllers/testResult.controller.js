const asyncHandler = require("../middleware/async.middleware");
const testResultService = require("../services/testResult.service");

/**
 * O'quvchining natijalarini olish
 * GET /api/test-results/my
 */
const getMyResults = asyncHandler(async (req, res) => {
  const results = await testResultService.getResultsForStudent(
    req.user._id,
    req.query.season,
  );
  res.json({
    success: true,
    data: results,
  });
});

/**
 * Bitta natijani olish
 * GET /api/test-results/:id
 */
const getResultById = asyncHandler(async (req, res) => {
  const result = await testResultService.getResultById(
    req.params.id,
    req.user,
  );
  res.json({
    success: true,
    data: result,
  });
});

/**
 * Test bo'yicha natijalarni olish (o'qituvchi - o'z testiniki)
 * GET /api/test-results/by-test/:testId
 */
const getResultsByTest = asyncHandler(async (req, res) => {
  const result = await testResultService.getResultsForTest(
    req,
    req.params.testId,
    req.user._id,
  );
  res.json(result);
});

/**
 * Ochiq savol javobini baholash
 * PATCH /api/test-results/:id/grade
 */
const gradeOpenAnswer = asyncHandler(async (req, res) => {
  const { questionId, awardedPoints, feedback } = req.body;
  const result = await testResultService.gradeOpenAnswer(
    req.params.id,
    questionId,
    req.user._id,
    { awardedPoints, feedback },
  );
  res.json({
    success: true,
    data: result,
    message: "Javob baholandi",
  });
});

/**
 * Natijaga qo'shimcha ball qo'shish
 * PATCH /api/test-results/:id/extra-points
 */
const addExtraPoints = asyncHandler(async (req, res) => {
  const result = await testResultService.addExtraPoints(
    req.params.id,
    req.user._id,
    req.body,
  );
  res.json({
    success: true,
    data: result,
    message: "Qo'shimcha ball qo'shildi",
  });
});

module.exports = {
  getMyResults,
  getResultById,
  getResultsByTest,
  gradeOpenAnswer,
  addExtraPoints,
};
