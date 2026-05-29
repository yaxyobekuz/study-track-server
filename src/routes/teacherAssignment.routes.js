// Express
const express = require("express");
const router = express.Router();

// Middleware
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// Controller
const {
  getAssignments,
  getMyAssignments,
  createAssignment,
  updateAssignment,
  deleteAssignment,
} = require("../controllers/teacherAssignment.controller");

router.use(protect);

// O'qituvchi - o'z biriktiruvlarini ko'rish
router.get("/my", authorize(ROLES.TEACHER), getMyAssignments);

// Faqat owner uchun - CRUD
router.get("/", authorize(ROLES.OWNER), getAssignments);
router.post("/", authorize(ROLES.OWNER), createAssignment);
router.put(
  "/:id",
  authorize(ROLES.OWNER),
  validateObjectId("id"),
  updateAssignment,
);
router.delete(
  "/:id",
  authorize(ROLES.OWNER),
  validateObjectId("id"),
  deleteAssignment,
);

module.exports = router;
