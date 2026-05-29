const asyncHandler = require("../middleware/async.middleware");
const testBindingService = require("../services/testBinding.service");

/**
 * Testning biriktiruvlari (o'qituvchi).
 * GET /api/tests/:testId/bindings
 */
const getBindingsForTest = asyncHandler(async (req, res) => {
  const bindings = await testBindingService.listBindingsForTest(
    req.params.testId,
    req.user._id,
  );
  res.json({ success: true, data: bindings });
});

/**
 * Yangi biriktiruv (o'qituvchi).
 * POST /api/tests/:testId/bindings
 */
const createBinding = asyncHandler(async (req, res) => {
  const binding = await testBindingService.createBinding(
    req.params.testId,
    req.body,
    req.user._id,
  );
  res.status(201).json({ success: true, data: binding });
});

/**
 * Biriktiruvni yangilash (o'qituvchi).
 * PUT /api/bindings/:id
 */
const updateBinding = asyncHandler(async (req, res) => {
  const binding = await testBindingService.updateBinding(
    req.params.id,
    req.body,
    req.user._id,
  );
  res.json({ success: true, data: binding });
});

/**
 * Biriktiruvni e'lon qilish.
 * PATCH /api/bindings/:id/publish
 */
const publishBinding = asyncHandler(async (req, res) => {
  const binding = await testBindingService.publishBinding(
    req.params.id,
    req.user._id,
  );
  res.json({ success: true, data: binding, message: "Biriktiruv e'lon qilindi" });
});

/**
 * Biriktiruvni yopish.
 * PATCH /api/bindings/:id/close
 */
const closeBinding = asyncHandler(async (req, res) => {
  const binding = await testBindingService.closeBinding(
    req.params.id,
    req.user._id,
  );
  res.json({ success: true, data: binding, message: "Biriktiruv yopildi" });
});

/**
 * Biriktiruvni o'chirish.
 * DELETE /api/bindings/:id
 */
const deleteBinding = asyncHandler(async (req, res) => {
  const result = await testBindingService.deleteBinding(
    req.params.id,
    req.user._id,
  );
  res.json({
    success: true,
    message: result.deleted
      ? "Biriktiruv o'chirildi"
      : "Sessiyalar mavjud, biriktiruv yopildi (soft)",
  });
});

/**
 * O'quvchiga qayta urinish ruxsati.
 * POST /api/bindings/:id/reopen
 */
const reopenSession = asyncHandler(async (req, res) => {
  const result = await testBindingService.reopenSessionForStudent(
    req.params.id,
    req.body.studentId,
    req.user._id,
  );
  res.json({
    success: true,
    data: result,
    message: "O'quvchiga qayta urinish ruxsati berildi",
  });
});

/**
 * O'quvchiga mavjud biriktiruvlar.
 * GET /api/bindings/available
 */
const getAvailableBindings = asyncHandler(async (req, res) => {
  const bindings = await testBindingService.listAvailableBindingsForStudent(
    req.user._id,
  );
  res.json({ success: true, data: bindings });
});

module.exports = {
  getBindingsForTest,
  createBinding,
  updateBinding,
  publishBinding,
  closeBinding,
  deleteBinding,
  reopenSession,
  getAvailableBindings,
};
