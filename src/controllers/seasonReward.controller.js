const asyncHandler = require("../middleware/async.middleware");
const seasonRewardService = require("../services/seasonReward.service");

/**
 * Mavsum statistikasi (owner: hammasi, teacher: o'z sinflari, student: o'zi).
 * GET /api/test-seasons/:id/stats
 */
const getStats = asyncHandler(async (req, res) => {
  const { classId, subjectId } = req.query;
  const stats = await seasonRewardService.getSeasonStats(req.params.id, {
    classId,
    subjectId,
  });
  res.json({ success: true, data: stats });
});

/**
 * Sinf bo'yicha mavsum stati.
 * GET /api/test-seasons/:id/class/:classId/stats
 */
const getClassStats = asyncHandler(async (req, res) => {
  const stats = await seasonRewardService.getClassStats(
    req.params.id,
    req.params.classId,
  );
  res.json({ success: true, data: stats });
});

/**
 * O'quvchining o'z mavsum stati.
 * GET /api/test-seasons/:id/my-stats
 */
const getMyStats = asyncHandler(async (req, res) => {
  const stats = await seasonRewardService.getMyStats(
    req.params.id,
    req.user._id,
  );
  res.json({ success: true, data: stats });
});

/**
 * Maktab bo'yicha o'rin mukofotlarini belgilash (owner).
 * PUT /api/test-seasons/:id/school-tiers
 */
const setSchoolTiers = asyncHandler(async (req, res) => {
  const season = await seasonRewardService.setSchoolTiers(
    req.params.id,
    req.body.tiers,
    req.user._id,
  );
  res.json({
    success: true,
    data: season,
    message: "Maktab darajalari saqlandi",
  });
});

/**
 * Sinf top-N darajalarini belgilash (owner yoki biriktirilgan o'qituvchi).
 * PUT /api/test-seasons/:id/class/:classId/tiers
 */
const setClassTiers = asyncHandler(async (req, res) => {
  const season = await seasonRewardService.setClassTiers(
    req.params.id,
    req.params.classId,
    req.body.tiers,
    req.user,
  );
  res.json({
    success: true,
    data: season,
    message: "Sinf darajalari saqlandi",
  });
});

/**
 * Tarqatish preview.
 * GET /api/test-seasons/:id/distribute/preview
 */
const previewDistribution = asyncHandler(async (req, res) => {
  const preview = await seasonRewardService.previewDistribution(req.params.id);
  res.json({ success: true, data: preview });
});

/**
 * Coinlarni tarqatish.
 * POST /api/test-seasons/:id/distribute
 */
const distributeCoins = asyncHandler(async (req, res) => {
  const result = await seasonRewardService.distributeCoins(
    req.params.id,
    req.user._id,
    { force: Boolean(req.body.force) },
  );
  res.json({
    success: true,
    data: result,
    message: `Tarqatildi: ${result.distributed}, o'tkazildi: ${result.skipped}`,
  });
});

module.exports = {
  getStats,
  getClassStats,
  getMyStats,
  setSchoolTiers,
  setClassTiers,
  previewDistribution,
  distributeCoins,
};
