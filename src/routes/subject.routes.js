const express = require("express");
const router = express.Router();
const {
  getAllSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
  exportSubjects,
} = require("../controllers/subject.controller");
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// All routes are protected
router.use(protect);

// GET routes for everyone (teacher, student, owner)
router.get("/", getAllSubjects);
router.get("/export", authorizePermission(PERMISSIONS.SUBJECTS_EXPORT), exportSubjects);

// CUD operations - amal darajasidagi ruxsat bilan
router.post("/", authorizePermission(PERMISSIONS.SUBJECTS_CREATE), createSubject);
router.put("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.SUBJECTS_UPDATE), updateSubject);
router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.SUBJECTS_DELETE), deleteSubject);

module.exports = router;
