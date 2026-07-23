const asyncHandler = require("../middleware/async.middleware");
const testService = require("../services/test.service");

/**
 * O'qituvchining testlarini olish
 * GET /api/tests
 */
const getTests = asyncHandler(async (req, res) => {
  const result = await testService.listTests(req, req.user.id);
  res.json(result);
});

/**
 * Bitta testni olish
 * GET /api/tests/:id
 */
const getTestById = asyncHandler(async (req, res) => {
  const test = await testService.getTestById(req.params.id, req.user);
  res.json({
    success: true,
    data: test,
  });
});

/**
 * Test yaratish
 * POST /api/tests
 */
const createTest = asyncHandler(async (req, res) => {
  const test = await testService.createTest(req.body, req.user.id);
  res.status(201).json({
    success: true,
    data: test,
  });
});

/**
 * Testni yangilash
 * PUT /api/tests/:id
 */
const updateTest = asyncHandler(async (req, res) => {
  const test = await testService.updateTest(
    req.params.id,
    req.body,
    req.user.id,
  );
  res.json({
    success: true,
    data: test,
  });
});

/**
 * Testni o'chirish
 * DELETE /api/tests/:id
 */
const deleteTest = asyncHandler(async (req, res) => {
  const result = await testService.deleteTest(req.params.id, req.user.id);
  res.json({
    success: true,
    message: result.deleted
      ? "Test o'chirildi"
      : "Testda sessiyalar mavjud, shuning uchun u o'chirildi (soft)",
  });
});

module.exports = {
  getTests,
  getTestById,
  createTest,
  updateTest,
  deleteTest,
};
