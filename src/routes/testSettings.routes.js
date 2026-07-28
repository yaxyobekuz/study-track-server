const express = require("express");
const router = express.Router();

const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const {
  getSettings,
  updateSettings,
} = require("../controllers/testSettings.controller");

router.use(protect);

router.get("/", authorizePermission(PERMISSIONS.TESTS), getSettings);
router.put("/", authorizePermission(PERMISSIONS.TESTS), updateSettings);

module.exports = router;
