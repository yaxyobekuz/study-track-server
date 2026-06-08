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
 * Mavsum bo'yicha o'quvchining natijalari (admin)
 * GET /api/test-results/season/:seasonId/student/:studentId
 */
const getStudentSeasonResults = asyncHandler(async (req, res) => {
  const results = await testResultService.getResultsForStudent(
    req.params.studentId,
    req.params.seasonId,
  );
  res.json({ success: true, data: results });
});

/**
 * Bitta natijani admin uchun olish (to'g'ri javoblar bilan)
 * GET /api/test-results/admin/:id
 */
const getResultForAdmin = asyncHandler(async (req, res) => {
  const result = await testResultService.getResultForAdmin(req.params.id);
  res.json({ success: true, data: result });
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

/**
 * Qo'shimcha ball yozuvini tahrirlash
 * PATCH /api/test-results/:id/extra-points/:entryId
 */
const editExtraPoints = asyncHandler(async (req, res) => {
  const result = await testResultService.editExtraPoints(
    req.params.id,
    req.params.entryId,
    req.user._id,
    req.body,
  );
  res.json({
    success: true,
    data: result,
    message: "Qo'shimcha ball yangilandi",
  });
});

/**
 * Qo'shimcha ball yozuvini o'chirish
 * DELETE /api/test-results/:id/extra-points/:entryId
 */
const deleteExtraPoints = asyncHandler(async (req, res) => {
  const result = await testResultService.deleteExtraPoints(
    req.params.id,
    req.params.entryId,
    req.user._id,
  );
  res.json({
    success: true,
    data: result,
    message: "Qo'shimcha ball o'chirildi",
  });
});

module.exports = {
  getMyResults,
  getStudentSeasonResults,
  getResultForAdmin,
  getResultById,
  getResultsByTest,
  gradeOpenAnswer,
  addExtraPoints,
  editExtraPoints,
  deleteExtraPoints,
};
