const express = require("express");
const router = express.Router();
const {
  getAllClasses,
  getClass,
  createClass,
  updateClass,
  deleteClass,
  addStudentsToClass,
  removeStudentsFromClass,
  moveStudentsToClass,
  exportClassStudents,
  exportClasses,
} = require("../controllers/class.controller");
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// All routes are protected
router.use(protect);

// GET routes for everyone
router.get("/", getAllClasses);
router.get("/export", authorizePermission(PERMISSIONS.CLASSES), exportClasses);
router.get("/:id", validateObjectId("id"), getClass);
router.get("/:id/export", validateObjectId("id"), authorizePermission(PERMISSIONS.CLASSES), exportClassStudents);

// CUD operations for owner only
router.post("/", authorizePermission(PERMISSIONS.CLASSES), createClass);
router.put("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.CLASSES), updateClass);
router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.CLASSES), deleteClass);

// Sinf o'quvchilarini boshqarish (owner only)
router.post("/:id/students/add", validateObjectId("id"), authorizePermission(PERMISSIONS.CLASSES), addStudentsToClass);
router.post("/:id/students/remove", validateObjectId("id"), authorizePermission(PERMISSIONS.CLASSES), removeStudentsFromClass);
router.post("/:id/students/move", validateObjectId("id"), authorizePermission(PERMISSIONS.CLASSES), moveStudentsToClass);

module.exports = router;
