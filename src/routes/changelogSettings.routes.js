const express = require("express");
const router = express.Router();
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const {
  getSettings,
  updateSettings,
  getNotifications,
  sendNow,
} = require("../controllers/changelogSettings.controller");

// Alohida router: `changelog.routes.js` da "/versions" ni "/:id" dan oldin
// qo'yish sharti bor. Yana uchta statik yo'l qo'shish o'sha tuzoqni
// kuchaytirardi. `test-settings` / `finance-settings` ham shunday alohida.
router.use(protect);

router.get("/", authorizePermission(PERMISSIONS.CHANGELOG_VIEW, ROLES.DEVELOPER), getSettings);
router.put(
  "/",
  authorizePermission(PERMISSIONS.CHANGELOG_SETTINGS, ROLES.DEVELOPER),
  updateSettings,
);

router.get(
  "/notifications",
  authorizePermission(PERMISSIONS.CHANGELOG_VIEW, ROLES.DEVELOPER),
  getNotifications,
);

router.post("/send", authorizePermission(PERMISSIONS.CHANGELOG_SEND, ROLES.DEVELOPER), sendNow);

module.exports = router;
