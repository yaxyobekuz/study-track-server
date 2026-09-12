const express = require("express");
const router = express.Router();

const {
  protect,
  authorizePermission,
  authorizeAnyPermission,
} = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const {
  getMode,
  getStatus,
  updateConfig,
  inspectSheet,
  checkSheet,
  listRevisions,
  getRevision,
  applyRevision,
  rejectRevision,
  getMappings,
  saveMappings,
  switchSource,
  listSnapshots,
  getSnapshot,
  restoreSnapshot,
} = require("../controllers/scheduleSync.controller");

const { SCHEDULESYNC_VIEW: VIEW, SCHEDULESYNC_REVIEW: REVIEW, SCHEDULESYNC_SOURCE: SOURCE } =
  PERMISSIONS;
// Ko'rish — bo'limning istalgan amali bilan (`normalizePermissions` ham
// review/source bilan birga view'ni qo'shadi; bu yerda eski yozuvlar uchun ham).
const ANY = [VIEW, REVIEW, SOURCE];

router.use(protect);

// Rejim — jadvalni ko'radigan/tahrirlaydigan hamma sahifaga kerak
router.get(
  "/mode",
  authorizeAnyPermission([PERMISSIONS.SCHEDULES_VIEW, ...ANY], ROLES.TEACHER),
  getMode,
);

router.get("/status", authorizeAnyPermission(ANY), getStatus);
router.put("/config", authorizePermission(SOURCE), updateConfig);
router.post("/inspect", authorizePermission(SOURCE), inspectSheet);
router.post("/check", authorizeAnyPermission([REVIEW, SOURCE]), checkSheet);

router.get("/revisions", authorizeAnyPermission(ANY), listRevisions);
router.get("/revisions/:id", validateObjectId("id"), authorizeAnyPermission(ANY), getRevision);
router.post("/revisions/:id/apply", validateObjectId("id"), authorizePermission(REVIEW), applyRevision);
router.post("/revisions/:id/reject", validateObjectId("id"), authorizePermission(REVIEW), rejectRevision);

// Moslash amaldagi jadvalga tegmaydi (qo'llash qayta tekshiradi) — manbani
// almashtiruvchi ham birinchi sozlashda nomlarni moslay olishi kerak.
router.get("/mappings", authorizeAnyPermission(ANY), getMappings);
router.put("/mappings", authorizeAnyPermission([REVIEW, SOURCE]), saveMappings);

router.post("/switch", authorizePermission(SOURCE), switchSource);

router.get("/snapshots", authorizeAnyPermission(ANY), listSnapshots);
router.get("/snapshots/:id", validateObjectId("id"), authorizeAnyPermission(ANY), getSnapshot);
router.post("/snapshots/:id/restore", validateObjectId("id"), authorizePermission(SOURCE), restoreSnapshot);

module.exports = router;
