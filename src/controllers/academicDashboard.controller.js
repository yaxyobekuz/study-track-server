const asyncHandler = require("../middleware/async.middleware");
const academicDashboardService = require("../services/academicDashboard.service");
const academicTargetService = require("../services/academicTarget.service");
const achievementService = require("../services/achievement.service");
const clubService = require("../services/club.service");
const academicInsightService = require("../services/academicInsight.service");

// ─────────────────────────────────────────────
// Dashboard va reja
// ─────────────────────────────────────────────

const getOverview = asyncHandler(async (req, res) => {
  const data = await academicDashboardService.getOverview(req.query);
  res.json({ success: true, data });
});

const getTargets = asyncHandler(async (req, res) => {
  const data = await academicTargetService.getTargets(req.query);
  res.json({ success: true, data });
});

const saveTargets = asyncHandler(async (req, res) => {
  const data = await academicTargetService.upsertTargets(req.body, req.user.id);
  res.json({ success: true, message: "Reja saqlandi", data });
});

// ─────────────────────────────────────────────
// Haftalik AI tahlil
// ─────────────────────────────────────────────

// ⚠️ O'QISH SO'ROVI YOZMAYDI: shu hafta uchun snapshot bo'lmasa, servis
// jonli qoidalar natijasini qaytaradi va bazaga tegmaydi.
const getInsights = asyncHandler(async (req, res) => {
  const data = await academicInsightService.getWeeklyInsight();
  res.json({ success: true, data });
});

// Qo'lda yangilash — model chaqiriladi, natija haftaning qatoriga
// yoziladi. Sovish muddati servisda tekshiriladi (429).
const refreshInsights = asyncHandler(async (req, res) => {
  const data = await academicInsightService.generateWeeklyInsight({ actorId: req.user.id });
  res.json({ success: true, message: "Haftalik tahlil yangilandi", data });
});

// ─────────────────────────────────────────────
// Yutuqlar
// ─────────────────────────────────────────────

const getAchievements = asyncHandler(async (req, res) => {
  const result = await achievementService.getAchievements(req.query);
  res.json(result);
});

const getAchievementOptions = asyncHandler(async (req, res) => {
  res.json({ success: true, data: achievementService.getOptions() });
});

const createAchievement = asyncHandler(async (req, res) => {
  const data = await achievementService.createAchievement(req.body, req.user.id);
  res.status(201).json({ success: true, message: "Yutuq qo'shildi", data });
});

const updateAchievement = asyncHandler(async (req, res) => {
  const data = await achievementService.updateAchievement(req.params.id, req.body);
  res.json({ success: true, message: "Yutuq yangilandi", data });
});

const deleteAchievement = asyncHandler(async (req, res) => {
  const data = await achievementService.deleteAchievement(req.params.id);
  res.json({ success: true, message: "Yutuq o'chirildi", data });
});

// ─────────────────────────────────────────────
// To'garaklar
// ─────────────────────────────────────────────

const getClubs = asyncHandler(async (req, res) => {
  const result = await clubService.getClubs(req.query);
  res.json(result);
});

const getClub = asyncHandler(async (req, res) => {
  const data = await clubService.getClub(req.params.id);
  res.json({ success: true, data });
});

const createClub = asyncHandler(async (req, res) => {
  const data = await clubService.createClub(req.body, req.user.id);
  res.status(201).json({ success: true, message: "To'garak qo'shildi", data });
});

const updateClub = asyncHandler(async (req, res) => {
  const data = await clubService.updateClub(req.params.id, req.body);
  res.json({ success: true, message: "To'garak yangilandi", data });
});

const deleteClub = asyncHandler(async (req, res) => {
  const data = await clubService.deleteClub(req.params.id);
  res.json({ success: true, message: "To'garak o'chirildi", data });
});

const addClubMembers = asyncHandler(async (req, res) => {
  const data = await clubService.addMembers(req.params.id, req.body, req.user.id);

  res.status(201).json({
    success: true,
    // ⚠️ Xabar SANOQ bilan: "qo'shildi" deb qo'yib, 12 tadan 3 tasi
    // allaqachon a'zo bo'lganini aytmaslik — jim yo'qotish bo'lardi
    message:
      data.skipped > 0
        ? `${data.added} ta o'quvchi qo'shildi, ${data.skipped} tasi allaqachon a'zo edi`
        : `${data.added} ta o'quvchi qo'shildi`,
    data,
  });
});

const closeClubMember = asyncHandler(async (req, res) => {
  const data = await clubService.closeMember(req.params.id, req.params.memberId, req.body);
  res.json({ success: true, message: "A'zolik yopildi", data });
});

const removeClubMember = asyncHandler(async (req, res) => {
  const data = await clubService.removeMember(req.params.id, req.params.memberId);
  res.json({ success: true, message: "A'zolik o'chirildi", data });
});

module.exports = {
  getOverview,
  getTargets,
  saveTargets,
  getInsights,
  refreshInsights,
  getAchievements,
  getAchievementOptions,
  createAchievement,
  updateAchievement,
  deleteAchievement,
  getClubs,
  getClub,
  createClub,
  updateClub,
  deleteClub,
  addClubMembers,
  closeClubMember,
  removeClubMember,
};
