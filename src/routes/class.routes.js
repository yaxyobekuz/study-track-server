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
router.get("/export", authorizePermission(PERMISSIONS.CLASSES_EXPORT), exportClasses);
router.get("/:id", validateObjectId("id"), getClass);
router.get("/:id/export", validateObjectId("id"), authorizePermission(PERMISSIONS.CLASSES_EXPORT), exportClassStudents);

// CUD operations - amal darajasidagi ruxsat bilan
router.post("/", authorizePermission(PERMISSIONS.CLASSES_CREATE), createClass);
router.put("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.CLASSES_UPDATE), updateClass);
router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.CLASSES_DELETE), deleteClass);

// Sinf o'quvchilarini boshqarish — ko'chirish alohida ruxsat talab qiladi
router.post("/:id/students/add", validateObjectId("id"), authorizePermission(PERMISSIONS.CLASSES_STUDENTS), addStudentsToClass);
router.post("/:id/students/remove", validateObjectId("id"), authorizePermission(PERMISSIONS.CLASSES_STUDENTS), removeStudentsFromClass);
router.post("/:id/students/move", validateObjectId("id"), authorizePermission(PERMISSIONS.CLASSES_TRANSFER), moveStudentsToClass);

module.exports = router;
