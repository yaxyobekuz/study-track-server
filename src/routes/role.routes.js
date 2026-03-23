const express = require("express");
const router = express.Router();
const {
  getAllRoles,
  getRoleOptions,
  createRole,
  updateRole,
  deleteRole,
} = require("../controllers/role.controller");
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// All routes are protected and owner only
router.use(protect);
router.use(authorize(ROLES.OWNER));

// GET routes
router.get("/", getAllRoles);
router.get("/options", getRoleOptions);

// CUD operations
router.post("/", createRole);
router.put("/:id", validateObjectId("id"), updateRole);
router.delete("/:id", validateObjectId("id"), deleteRole);

module.exports = router;
