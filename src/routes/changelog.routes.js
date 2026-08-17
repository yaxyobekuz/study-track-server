const express = require("express");
const router = express.Router();
const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId, validateRequired } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");
const {
  getAll,
  getVersions,
  getOne,
  create,
  update,
  remove,
} = require("../controllers/changelog.controller");

router.use(protect);

// DIQQAT: "/versions" "/:id" DAN OLDIN turishi shart — aks holda `validateObjectId`
// "versions" ni ObjectId deb parse qilib, chalkash 400 qaytaradi.
router.get("/versions", authorizePermission(PERMISSIONS.CHANGELOG_VIEW, ROLES.DEVELOPER), getVersions);

router.get("/", authorizePermission(PERMISSIONS.CHANGELOG_VIEW, ROLES.DEVELOPER), getAll);
router.get(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.CHANGELOG_VIEW, ROLES.DEVELOPER),
  getOne,
);

router.post(
  "/",
  validateRequired(["panel", "date"]),
  authorizePermission(PERMISSIONS.CHANGELOG_CREATE, ROLES.DEVELOPER),
  create,
);
router.put(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.CHANGELOG_UPDATE, ROLES.DEVELOPER),
  update,
);
router.delete(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.CHANGELOG_DELETE, ROLES.DEVELOPER),
  remove,
);

module.exports = router;
