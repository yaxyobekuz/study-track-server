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

// All routes are protected and owner only
router.use(protect);
router.use(authorize("owner"));

// GET routes
router.get("/", getAllRoles);
router.get("/options", getRoleOptions);

// CUD operations
router.post("/", createRole);
router.put("/:id", updateRole);
router.delete("/:id", deleteRole);

module.exports = router;
