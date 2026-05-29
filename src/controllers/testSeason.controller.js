const asyncHandler = require("../middleware/async.middleware");
const testSeasonService = require("../services/testSeason.service");

/**
 * Mavsumlar ro'yxatini olish
 * GET /api/test-seasons
 */
const getSeasons = asyncHandler(async (req, res) => {
  const result = await testSeasonService.listSeasons(req);
  res.json(result);
});

/**
 * Faol mavsumlarni olish
 * GET /api/test-seasons/active
 */
const getActiveSeasons = asyncHandler(async (req, res) => {
  const seasons = await testSeasonService.getActiveSeasons();
  res.json({
    success: true,
    data: seasons,
  });
});

/**
 * Bitta mavsumni olish
 * GET /api/test-seasons/:id
 */
const getSeasonById = asyncHandler(async (req, res) => {
  const season = await testSeasonService.getSeasonById(req.params.id);
  res.json({
    success: true,
    data: season,
  });
});

/**
 * Mavsum yaratish
 * POST /api/test-seasons
 */
const createSeason = asyncHandler(async (req, res) => {
  const { season, overlapping } = await testSeasonService.createSeason(
    req.body,
    req.user._id,
  );
  res.status(201).json({
    success: true,
    data: season,
    overlapping,
  });
});

/**
 * Mavsumni yangilash
 * PUT /api/test-seasons/:id
 */
const updateSeason = asyncHandler(async (req, res) => {
  const { season, overlapping } = await testSeasonService.updateSeason(
    req.params.id,
    req.body,
  );
  res.json({
    success: true,
    data: season,
    overlapping,
  });
});

/**
 * Mavsum holatini o'zgartirish
 * PATCH /api/test-seasons/:id/status
 */
const setSeasonStatus = asyncHandler(async (req, res) => {
  const season = await testSeasonService.setSeasonStatus(
    req.params.id,
    req.body.status,
  );
  res.json({
    success: true,
    data: season,
  });
});

/**
 * Mavsumni o'chirish
 * DELETE /api/test-seasons/:id
 */
const deleteSeason = asyncHandler(async (req, res) => {
  const result = await testSeasonService.deleteSeason(req.params.id);
  res.json({
    success: true,
    message: result.deleted
      ? "Mavsum o'chirildi"
      : "Mavsumda testlar mavjud, shuning uchun u yopildi",
  });
});

module.exports = {
  getSeasons,
  getActiveSeasons,
  getSeasonById,
  createSeason,
  updateSeason,
  setSeasonStatus,
  deleteSeason,
};
