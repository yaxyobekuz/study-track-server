// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getOverview,
  getTargets,
  saveTargets,
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
} = require("../controllers/academicDashboard.controller");

router.use(protect);

// ─────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────
// ⚠️ `education.view` — `grades.view` DAN ALOHIDA. Baholar jurnalini
// ko'rish huquqi bitta sinfning kunlik ishi; bu ekranda esa butun
// maktabning kesimi turadi (o'qituvchilar KPI si, sinflar reytingi).
// Moliya tomonida `reports.view` ham `finance.view` dan shu sababdan
// ajratilgan.
router.get("/overview", authorizePermission(PERMISSIONS.EDUCATION_VIEW), getOverview);

// REJA. Ko'rish — dashboard bilan bir xil huquq (raqam baribir ekranda
// turadi), YOZISH esa alohida: reja "bajarildi" ko'rinishini o'zgartiradi.
router.get("/targets", authorizePermission(PERMISSIONS.EDUCATION_VIEW), getTargets);
router.put("/targets", authorizePermission(PERMISSIONS.EDUCATION_PLAN), saveTargets);

// ─────────────────────────────────────────────
// OLIMPIADA YUTUQLARI
// ─────────────────────────────────────────────
// Toifalar katalogi — yozish ekranini chizish uchun ham kerak, shuning
// uchun `achievements.view` yetarli.
router.get("/achievements/options", authorizePermission(PERMISSIONS.ACHIEVEMENTS_VIEW), getAchievementOptions);
router.get("/achievements", authorizePermission(PERMISSIONS.ACHIEVEMENTS_VIEW), getAchievements);
router.post("/achievements", authorizePermission(PERMISSIONS.ACHIEVEMENTS_CREATE), createAchievement);
router.put(
  "/achievements/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.ACHIEVEMENTS_UPDATE),
  updateAchievement,
);
router.delete(
  "/achievements/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.ACHIEVEMENTS_DELETE),
  deleteAchievement,
);

// ─────────────────────────────────────────────
// TO'GARAKLAR
// ─────────────────────────────────────────────
router.get("/clubs", authorizePermission(PERMISSIONS.CLUBS_VIEW), getClubs);
router.post("/clubs", authorizePermission(PERMISSIONS.CLUBS_CREATE), createClub);
router.get("/clubs/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.CLUBS_VIEW), getClub);
router.put("/clubs/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.CLUBS_UPDATE), updateClub);
router.delete("/clubs/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.CLUBS_DELETE), deleteClub);

// A'zolik — alohida amal: to'garak ochish ma'muriy qaror, a'zo biriktirish
// esa kunlik ish va uni to'garak rahbariga berish mumkin.
router.post(
  "/clubs/:id/members",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.CLUBS_MEMBERS),
  addClubMembers,
);
router.put(
  "/clubs/:id/members/:memberId/close",
  validateObjectId("id"),
  validateObjectId("memberId"),
  authorizePermission(PERMISSIONS.CLUBS_MEMBERS),
  closeClubMember,
);
router.delete(
  "/clubs/:id/members/:memberId",
  validateObjectId("id"),
  validateObjectId("memberId"),
  authorizePermission(PERMISSIONS.CLUBS_MEMBERS),
  removeClubMember,
);

module.exports = router;
