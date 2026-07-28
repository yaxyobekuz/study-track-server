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
  authorizePermission(PERMISSIONS.TESTS_VIEW, ROLES.TEACHER, ROLES.STUDENT),
  getActiveSeasons,
);

// Faqat owner uchun - CRUD
router.get("/", authorizePermission(PERMISSIONS.TESTS_VIEW), getSeasons);
router.post("/", authorizePermission(PERMISSIONS.TESTS_CREATE), createSeason);
router.get(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.TESTS_VIEW, ROLES.TEACHER, ROLES.STUDENT),
  getSeasonById,
);
router.put("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.TESTS_UPDATE), updateSeason);
router.delete(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.TESTS_DELETE),
  deleteSeason,
);

// ───── Mavsum e'loni (bot orqali) ─────
router.get(
  "/:id/announce/classes",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.TESTS_ANNOUNCE),
  getSeasonAnnounceClasses,
);
router.post(
  "/:id/announce",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.TESTS_ANNOUNCE),
  announceSeason,
);

// ───── Mavsum mukofotlari (V4) ─────

// Statistika: maktab va sinf darajasida - owner, o'qituvchi va o'quvchi ko'ra oladi
router.get(
  "/:id/stats",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.TESTS_VIEW, ROLES.TEACHER, ROLES.STUDENT),
  getStats,
);
router.get(
  "/:id/class/:classId/stats",
  validateObjectId("id"),
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.TESTS_VIEW, ROLES.TEACHER, ROLES.STUDENT),
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
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.TESTS_DISTRIBUTE),
  setSchoolTiers,
);
router.put(
  "/:id/class-tiers",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.TESTS_DISTRIBUTE),
  setClassTiers,
);

// Tarqatish
router.get(
  "/:id/distribute/preview",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.TESTS_DISTRIBUTE),
  previewDistribution,
);
router.post(
  "/:id/distribute",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.TESTS_DISTRIBUTE),
  distributeCoins,
);

// To'liq yakunlash (coin tarqatish + o'quvchilarga bot orqali natija)
router.post(
  "/:id/finalize",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.TESTS_FINALIZE),
  finalizeSeason,
);

module.exports = router;
