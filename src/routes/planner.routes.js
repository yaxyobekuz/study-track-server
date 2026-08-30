const express = require("express");
const router = express.Router();
const controller = require("../controllers/planner.controller");
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");

// Barcha yo'llar himoyalangan
router.use(protect);

// ── Yuklama ("Asosiy" tab) ──
router.get("/loads", authorizePermission(PERMISSIONS.PLANNER_VIEW), controller.getLoads);
router.put("/loads", authorizePermission(PERMISSIONS.PLANNER_LOADS), controller.saveLoad);

// ── Bandlik ──
router.get(
  "/availability",
  authorizePermission(PERMISSIONS.PLANNER_VIEW),
  controller.getAvailability,
);
router.put(
  "/availability/:teacherId",
  validateObjectId("teacherId"),
  authorizePermission(PERMISSIONS.PLANNER_AVAILABILITY),
  controller.setAvailability,
);
router.patch(
  "/availability/:teacherId/toggle",
  validateObjectId("teacherId"),
  authorizePermission(PERMISSIONS.PLANNER_AVAILABILITY),
  controller.toggleSlot,
);
router.post(
  "/availability/:teacherId/from-work-schedule",
  validateObjectId("teacherId"),
  authorizePermission(PERMISSIONS.PLANNER_AVAILABILITY),
  controller.fillFromWorkSchedule,
);

// ── Dars taqsimoti varag'i (mustaqil tab) ──
router.get(
  "/distribution",
  authorizePermission(PERMISSIONS.PLANNER_VIEW),
  controller.getDistribution,
);
router.put(
  "/distribution",
  authorizePermission(PERMISSIONS.PLANNER_DISTRIBUTION),
  controller.saveDistribution,
);

// ── Sozlamalar ──
router.get("/settings", authorizePermission(PERMISSIONS.PLANNER_VIEW), controller.getSettings);
router.put(
  "/settings",
  authorizePermission(PERMISSIONS.PLANNER_SETTINGS),
  controller.updateSettings,
);

// ── Shakllantirish ──
router.get(
  "/preflight",
  authorizePermission(PERMISSIONS.PLANNER_VIEW),
  controller.getPreflight,
);

// ── Variantlar ──
// ⚠️ `/runs/:id` dan OLDIN turishi shart bo'lgan yo'l yo'q, lekin
// `/runs/:id/lessons` marshrutlari `:id` bilan bir xil prefiksda — Express
// ularni e'lon tartibida ko'rib chiqadi, shuning uchun aniqrog'i pastda.
router.post("/runs", authorizePermission(PERMISSIONS.PLANNER_GENERATE), controller.generate);
router.get("/runs", authorizePermission(PERMISSIONS.PLANNER_VIEW), controller.listRuns);
router.get(
  "/runs/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.PLANNER_VIEW),
  controller.getRun,
);
router.get(
  "/runs/:id/export",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.PLANNER_EXPORT),
  controller.exportRun,
);
router.patch(
  "/runs/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.PLANNER_GENERATE),
  controller.renameRun,
);
router.delete(
  "/runs/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.PLANNER_GENERATE),
  controller.deleteRun,
);

// ── Variantdagi darslar (qo'lda tuzatish) ──
router.post(
  "/runs/:id/lessons",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.PLANNER_GENERATE),
  controller.addLesson,
);
router.patch(
  "/runs/:id/lessons/:lessonId",
  validateObjectId("id"),
  validateObjectId("lessonId"),
  authorizePermission(PERMISSIONS.PLANNER_GENERATE),
  controller.updateLesson,
);
router.delete(
  "/runs/:id/lessons/:lessonId",
  validateObjectId("id"),
  validateObjectId("lessonId"),
  authorizePermission(PERMISSIONS.PLANNER_GENERATE),
  controller.removeLesson,
);

module.exports = router;
