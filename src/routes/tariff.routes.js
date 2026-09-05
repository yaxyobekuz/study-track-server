// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getTariffs,
  getTariff,
  createTariff,
  updateTariff,
  archiveTariff,
  deleteTariff,
  getTimeline,
  getVersions,
  addVersion,
  updateVersion,
  deleteVersion,
  resolveForStudent,
  resolveMonthSheet,
  getDirections,
  createDirection,
  updateDirection,
  archiveDirection,
} = require("../controllers/tariff.controller");

// DIQQAT: `/resolve` `/:id` dan OLDIN turishi shart — aks holda "resolve"
// id sifatida o'qilib, validateObjectId da yiqiladi.
router.get("/resolve", protect, authorizePermission(PERMISSIONS.TARIFFS_VIEW), resolveForStudent);
router.get("/resolve/month/:month", protect, authorizePermission(PERMISSIONS.TARIFFS_VIEW), resolveMonthSheet);

// YO'NALISHLAR — tarif ustidagi daraja. `/:id` dan OLDIN turishi shart,
// aks holda "directions" id sifatida o'qilib, validateObjectId da yiqilardi.
router.get("/directions", protect, authorizePermission(PERMISSIONS.TARIFFS_VIEW), getDirections);
router.post("/directions", protect, authorizePermission(PERMISSIONS.TARIFFS_CREATE), createDirection);
router.put("/directions/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.TARIFFS_UPDATE), updateDirection);
router.patch("/directions/:id/archive", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.TARIFFS_UPDATE), archiveDirection);

// Katalog
router.get("/", protect, authorizePermission(PERMISSIONS.TARIFFS_VIEW), getTariffs);
router.post("/", protect, authorizePermission(PERMISSIONS.TARIFFS_CREATE), createTariff);

// Narx versiyalari (`/:id/versions` — `/:id` dan oldin bo'lishi shart emas,
// Express to'liq yo'lni solishtiradi)
router.get("/:id/versions", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.TARIFFS_VIEW), getVersions);
router.post("/:id/versions", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.TARIFFS_VERSIONS), addVersion);
router.put("/:id/versions/:versionId", protect, validateObjectId("id"), validateObjectId("versionId"), authorizePermission(PERMISSIONS.TARIFFS_VERSIONS), updateVersion);
router.delete("/:id/versions/:versionId", protect, validateObjectId("id"), validateObjectId("versionId"), authorizePermission(PERMISSIONS.TARIFFS_VERSIONS), deleteVersion);

router.get("/:id/timeline", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.TARIFFS_VIEW), getTimeline);

router.get("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.TARIFFS_VIEW), getTariff);
router.put("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.TARIFFS_UPDATE), updateTariff);
router.patch("/:id/archive", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.TARIFFS_UPDATE), archiveTariff);
router.delete("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.TARIFFS_DELETE), deleteTariff);

module.exports = router;
