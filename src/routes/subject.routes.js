const express = require("express");
const router = express.Router();
const {
  getAllSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
  exportSubjects,
} = require("../controllers/subject.controller");
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// All routes are protected
router.use(protect);

// GET routes for everyone (teacher, student, owner)
router.get("/", getAllSubjects);
router.get("/export", authorize(ROLES.OWNER), exportSubjects);

// CUD operations for owner only
router.post("/", authorize(ROLES.OWNER), createSubject);
router.put("/:id", validateObjectId("id"), authorize(ROLES.OWNER), updateSubject);
router.delete("/:id", validateObjectId("id"), authorize(ROLES.OWNER), deleteSubject);

module.exports = router;
