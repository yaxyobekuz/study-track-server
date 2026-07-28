const express = require("express");
const router = express.Router();

const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const {
  getSettings,
  updateSettings,
} = require("../controllers/scheduleSettings.controller");

router.use(protect);

router.get("/", authorizePermission(PERMISSIONS.SCHEDULES_VIEW, ROLES.TEACHER), getSettings);
router.put("/", authorizePermission(PERMISSIONS.SCHEDULES_SETTINGS), updateSettings);

module.exports = router;
