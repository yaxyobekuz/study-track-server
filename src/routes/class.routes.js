const express = require("express");
const router = express.Router();
const {
  getAllClasses,
  getClass,
  createClass,
  updateClass,
  deleteClass,
  exportClassStudents,
} = require("../controllers/class.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// All routes are protected
router.use(protect);

// GET routes for everyone
router.get("/", getAllClasses);
router.get("/:id", getClass);
router.get("/:id/export", authorize("owner"), exportClassStudents);

// CUD operations for owner only
router.post("/", authorize("owner"), createClass);
router.put("/:id", authorize("owner"), updateClass);
router.delete("/:id", authorize("owner"), deleteClass);

module.exports = router;
