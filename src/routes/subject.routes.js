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
router.get("/export", authorizePermission(PERMISSIONS.SUBJECTS), exportSubjects);

// CUD operations for owner only
router.post("/", authorizePermission(PERMISSIONS.SUBJECTS), createSubject);
router.put("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.SUBJECTS), updateSubject);
router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.SUBJECTS), deleteSubject);

module.exports = router;
