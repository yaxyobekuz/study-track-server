// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// Controller
const {
  getSeasons,
  getActiveSeasons,
  getSeasonById,
  createSeason,
  updateSeason,
  deleteSeason,
  getSeasonAnnounceClasses,
  announceSeason,
} = require("../controllers/testSeason.controller");

const {
  getStats,
  getClassStats,
  getMyStats,
  setAbsoluteTiers,
  setClassTiers,
  previewDistribution,
  distributeCoins,
} = require("../controllers/seasonReward.controller");

router.use(protect);

// O'qituvchi va o'quvchi - faol mavsumlarni ko'rish
router.get(
  "/active",
  authorize(ROLES.OWNER, ROLES.TEACHER, ROLES.STUDENT),
  getActiveSeasons,
);

// Faqat owner uchun - CRUD
router.get("/", authorize(ROLES.OWNER), getSeasons);
router.post("/", authorize(ROLES.OWNER), createSeason);
router.get(
  "/:id",
  authorize(ROLES.OWNER, ROLES.TEACHER, ROLES.STUDENT),
  validateObjectId("id"),
  getSeasonById,
);
router.put("/:id", authorize(ROLES.OWNER), validateObjectId("id"), updateSeason);
router.delete(
  "/:id",
  authorize(ROLES.OWNER),
  validateObjectId("id"),
  deleteSeason,
);

// ───── Mavsum e'loni (bot orqali) ─────
router.get(
  "/:id/announce/classes",
  authorize(ROLES.OWNER),
  validateObjectId("id"),
  getSeasonAnnounceClasses,
);
router.post(
  "/:id/announce",
  authorize(ROLES.OWNER),
  validateObjectId("id"),
  announceSeason,
);

// ───── Mavsum mukofotlari (V4) ─────

// Statistika: maktab va sinf darajasida - owner, o'qituvchi va o'quvchi ko'ra oladi
router.get(
  "/:id/stats",
  authorize(ROLES.OWNER, ROLES.TEACHER, ROLES.STUDENT),
  validateObjectId("id"),
  getStats,
);
router.get(
  "/:id/class/:classId/stats",
  authorize(ROLES.OWNER, ROLES.TEACHER, ROLES.STUDENT),
  validateObjectId("id"),
  validateObjectId("classId"),
  getClassStats,
);
router.get(
  "/:id/my-stats",
  authorize(ROLES.STUDENT),
  validateObjectId("id"),
  getMyStats,
);

// Darajalar konfiguratsiyasi
router.put(
  "/:id/absolute-tiers",
  authorize(ROLES.OWNER),
  validateObjectId("id"),
  setAbsoluteTiers,
);
router.put(
  "/:id/class/:classId/tiers",
  authorize(ROLES.OWNER, ROLES.TEACHER),
  validateObjectId("id"),
  validateObjectId("classId"),
  setClassTiers,
);

// Tarqatish
router.get(
  "/:id/distribute/preview",
  authorize(ROLES.OWNER),
  validateObjectId("id"),
  previewDistribution,
);
router.post(
  "/:id/distribute",
  authorize(ROLES.OWNER),
  validateObjectId("id"),
  distributeCoins,
);

module.exports = router;
