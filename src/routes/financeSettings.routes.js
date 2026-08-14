// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");

// Controller
const {
  getSettings,
  updateSettings,
  getAcademicYear,
} = require("../controllers/financeSettings.controller");

router.get("/academic-year", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getAcademicYear);

router.get("/", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getSettings);
router.put("/", protect, authorizePermission(PERMISSIONS.FINANCE_SETTINGS), updateSettings);

module.exports = router;
