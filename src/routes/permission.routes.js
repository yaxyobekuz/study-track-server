const express = require("express");
const router = express.Router();
const {
  getCatalog,
  getStaff,
  updateUserPermissions,
} = require("../controllers/permission.controller");
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// Ruxsatlarni faqat owner boshqaradi
router.use(protect);
router.use(authorize(ROLES.OWNER));

router.get("/catalog", getCatalog);
router.get("/staff", getStaff);
router.put("/users/:id", validateObjectId("id"), updateUserPermissions);

module.exports = router;
