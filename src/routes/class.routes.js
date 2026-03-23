const express = require("express");
const router = express.Router();
const {
  getAllClasses,
  getClass,
  createClass,
  updateClass,
  deleteClass,
  exportClassStudents,
  exportClasses,
} = require("../controllers/class.controller");
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// All routes are protected
router.use(protect);

// GET routes for everyone
router.get("/", getAllClasses);
router.get("/export", authorize(ROLES.OWNER), exportClasses);
router.get("/:id", validateObjectId("id"), getClass);
router.get("/:id/export", validateObjectId("id"), authorize(ROLES.OWNER), exportClassStudents);

// CUD operations for owner only
router.post("/", authorize(ROLES.OWNER), createClass);
router.put("/:id", validateObjectId("id"), authorize(ROLES.OWNER), updateClass);
router.delete("/:id", validateObjectId("id"), authorize(ROLES.OWNER), deleteClass);

module.exports = router;
