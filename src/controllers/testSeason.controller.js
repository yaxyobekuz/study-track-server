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

/**
 * Mavsumga biriktirilgan sinflar (e'lon modali uchun)
 * GET /api/test-seasons/:id/announce/classes
 */
const getSeasonAnnounceClasses = asyncHandler(async (req, res) => {
  const classes = await testSeasonService.getSeasonClasses(req.params.id);
  res.json({
    success: true,
    data: classes,
  });
});

/**
 * Mavsum e'lonini bot orqali yuborish
 * POST /api/test-seasons/:id/announce
 */
const announceSeason = asyncHandler(async (req, res) => {
  const result = await testSeasonService.announceSeason(
    req.params.id,
    req.body,
    req.user._id,
  );
  res.json({
    success: true,
    message: `E'lon ${result.studentCount} ta o'quvchiga navbatga qo'shildi`,
    data: result,
  });
});

/**
 * Mavsumni to'liq yakunlash: coin tarqatish + o'quvchilarga bot orqali natija
 * POST /api/test-seasons/:id/finalize
 */
const finalizeSeason = asyncHandler(async (req, res) => {
  const result = await testSeasonService.finalizeSeason(
    req.params.id,
    req.user._id,
  );
  res.json({
    success: true,
    message: `Mavsum yakunlandi. ${result.distributed} ta mukofot tarqatildi, ${result.notified} ta xabar navbatga qo'shildi`,
    data: result,
  });
});

module.exports = {
  getSeasons,
  getActiveSeasons,
  getSeasonById,
  createSeason,
  updateSeason,
  deleteSeason,
  getSeasonAnnounceClasses,
  announceSeason,
  finalizeSeason,
};
