const express = require("express");
const router = express.Router();

const { protect, authorize } = require("../middleware/auth.middleware");
const { ROLES } = require("../utils/constants");
const {
  getSettings,
  updateSettings,
} = require("../controllers/scheduleSettings.controller");

router.use(protect);

router.get("/", authorize(ROLES.OWNER, ROLES.TEACHER), getSettings);
router.put("/", authorize(ROLES.OWNER), updateSettings);

module.exports = router;
