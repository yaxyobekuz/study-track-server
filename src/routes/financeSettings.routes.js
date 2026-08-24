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
} = require("../controllers/financeSettings.controller");


router.get("/", protect, authorizePermission(PERMISSIONS.FINANCE_VIEW), getSettings);
router.put("/", protect, authorizePermission(PERMISSIONS.FINANCE_SETTINGS), updateSettings);

module.exports = router;
