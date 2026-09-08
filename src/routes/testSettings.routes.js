const express = require("express");
const router = express.Router();

const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const {
  getSettings,
  updateSettings,
} = require("../controllers/testSettings.controller");

router.use(protect);

router.get("/", authorizePermission(PERMISSIONS.TESTS_VIEW), getSettings);
router.put("/", authorizePermission(PERMISSIONS.TESTS_SETTINGS), updateSettings);

module.exports = router;
