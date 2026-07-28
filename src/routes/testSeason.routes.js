// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
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
  finalizeSeason,
} = require("../controllers/testSeason.controller");

const {
  getStats,
  getClassStats,
  getMyStats,
  setSchoolTiers,
  setClassTiers,
  previewDistribution,
  distributeCoins,
} = require("../controllers/seasonReward.controller");

router.use(protect);

// O'qituvchi va o'quvchi - faol mavsumlarni ko'rish
router.get(
  "/active",
  authorizePermission(PERMISSIONS.TESTS, ROLES.TEACHER, ROLES.STUDENT),
  getActiveSeasons,
);

// Faqat owner uchun - CRUD
router.get("/", authorizePermission(PERMISSIONS.TESTS), getSeasons);
router.post("/", authorizePermission(PERMISSIONS.TESTS), createSeason);
router.get(
  "/:id",
  authorizePermission(PERMISSIONS.TESTS, ROLES.TEACHER, ROLES.STUDENT),
  validateObjectId("id"),
  getSeasonById,
);
router.put("/:id", authorizePermission(PERMISSIONS.TESTS), validateObjectId("id"), updateSeason);
router.delete(
  "/:id",
  authorizePermission(PERMISSIONS.TESTS),
  validateObjectId("id"),
  deleteSeason,
);

// ───── Mavsum e'loni (bot orqali) ─────
router.get(
  "/:id/announce/classes",
  authorizePermission(PERMISSIONS.TESTS),
  validateObjectId("id"),
  getSeasonAnnounceClasses,
);
router.post(
  "/:id/announce",
  authorizePermission(PERMISSIONS.TESTS),
  validateObjectId("id"),
  announceSeason,
);

// ───── Mavsum mukofotlari (V4) ─────

// Statistika: maktab va sinf darajasida - owner, o'qituvchi va o'quvchi ko'ra oladi
router.get(
  "/:id/stats",
  authorizePermission(PERMISSIONS.TESTS, ROLES.TEACHER, ROLES.STUDENT),
  validateObjectId("id"),
  getStats,
);
router.get(
  "/:id/class/:classId/stats",
  authorizePermission(PERMISSIONS.TESTS, ROLES.TEACHER, ROLES.STUDENT),
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
  "/:id/school-tiers",
  authorizePermission(PERMISSIONS.TESTS),
  validateObjectId("id"),
  setSchoolTiers,
);
router.put(
  "/:id/class-tiers",
  authorizePermission(PERMISSIONS.TESTS),
  validateObjectId("id"),
  setClassTiers,
);

// Tarqatish
router.get(
  "/:id/distribute/preview",
  authorizePermission(PERMISSIONS.TESTS),
  validateObjectId("id"),
  previewDistribution,
);
router.post(
  "/:id/distribute",
  authorizePermission(PERMISSIONS.TESTS),
  validateObjectId("id"),
  distributeCoins,
);

// To'liq yakunlash (coin tarqatish + o'quvchilarga bot orqali natija)
router.post(
  "/:id/finalize",
  authorizePermission(PERMISSIONS.TESTS),
  validateObjectId("id"),
  finalizeSeason,
);

module.exports = router;
