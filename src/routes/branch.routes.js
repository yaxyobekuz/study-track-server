// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getBranches,
  getBranch,
  createBranch,
  updateBranch,
  archiveBranch,
  restoreBranch,
  retryProvision,
} = require("../controllers/branch.controller");

router.get("/", protect, authorizePermission(PERMISSIONS.BRANCHES_VIEW), getBranches);
router.post("/", protect, authorizePermission(PERMISSIONS.BRANCHES_CREATE), createBranch);

router.get("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.BRANCHES_VIEW), getBranch);
router.put("/:id", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.BRANCHES_UPDATE), updateBranch);
router.post("/:id/archive", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.BRANCHES_ARCHIVE), archiveBranch);
router.post("/:id/restore", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.BRANCHES_ARCHIVE), restoreBranch);
// Qayta urinish schema yaratadi va migratsiya yugurtiradi — `create` bilan
// bir xil huquq talab qiladi.
router.post("/:id/retry", protect, validateObjectId("id"), authorizePermission(PERMISSIONS.BRANCHES_CREATE), retryProvision);

module.exports = router;
