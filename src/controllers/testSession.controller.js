const asyncHandler = require("../middleware/async.middleware");
const testSessionService = require("../services/testSession.service");

/**
 * Test sessiyasini boshlash (V3 — binding ID).
 * POST /api/test-sessions
 */
const startSession = asyncHandler(async (req, res) => {
  const session = await testSessionService.startSession(
    req.body.bindingId,
    req.user._id,
  );
  res.status(201).json({
    success: true,
    data: session,
  });
});

/**
 * O'quvchining sessiyalarini olish.
 * GET /api/test-sessions/my
 */
const getMySessions = asyncHandler(async (req, res) => {
  const sessions = await testSessionService.getStudentSessions(
    req.user._id,
    req.query.season,
  );
  res.json({
    success: true,
    data: sessions,
  });
});

/**
 * Bitta sessiyani olish (o'quvchi - o'zinikini).
 * GET /api/test-sessions/:id
 */
const getSession = asyncHandler(async (req, res) => {
  const session = await testSessionService.getSessionForStudent(
    req.params.id,
    req.user._id,
  );
  res.json({
    success: true,
    data: session,
  });
});

/**
 * Javobni saqlash.
 * PUT /api/test-sessions/:id/answers
 */
const saveAnswer = asyncHandler(async (req, res) => {
  const session = await testSessionService.saveAnswer(
    req.params.id,
    req.user._id,
    req.body,
  );
  res.json({
    success: true,
    data: session,
  });
});

/**
 * Sessiyani topshirish.
 * POST /api/test-sessions/:id/submit
 */
const submitSession = asyncHandler(async (req, res) => {
  const { session, result } = await testSessionService.submitSession(
    req.params.id,
    req.user._id,
  );
  res.json({
    success: true,
    data: { session, result },
    message: "Test topshirildi",
  });
});

/**
 * Test bo'yicha sessiyalarni olish (o'qituvchi - o'z testining barcha biriktiruvlarida).
 * GET /api/test-sessions/by-test/:testId
 */
const getSessionsByTest = asyncHandler(async (req, res) => {
  const sessions = await testSessionService.getSessionsForTeacher(
    req.params.testId,
    req.user._id,
  );
  res.json({
    success: true,
    data: sessions,
  });
});

module.exports = {
  startSession,
  getMySessions,
  getSession,
  saveAnswer,
  submitSession,
  getSessionsByTest,
};
