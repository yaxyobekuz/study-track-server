const express = require("express");
const router = express.Router();
const {
  getGrades,
  getMissingGradesToday,
  getGradesByClassAndDate,
  createGrade,
  updateGrade,
  deleteGrade,
  getStudentGrades,
  getTeacherSubjectsInClass,
  getStudentsWithGrades,
  exportGrades,
} = require("../controllers/grade.controller");
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId, validateGrade } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// All routes are protected
router.use(protect);

// Export grades to Excel
router.get("/export", authorize(ROLES.OWNER, ROLES.TEACHER), exportGrades);

// Qo'yilmagan baholar (faqat owner)
router.get("/missing-today", authorize(ROLES.OWNER), getMissingGradesToday);

// Student views their own grades
router.get("/student/my-grades", authorize(ROLES.STUDENT), getStudentGrades);

// Teacher specific endpoints
router.get(
  "/teacher/subjects/:classId",
  validateObjectId("classId"),
  authorize(ROLES.TEACHER),
  getTeacherSubjectsInClass
);
router.get(
  "/students-with-grades",
  authorize(ROLES.TEACHER, ROLES.OWNER),
  getStudentsWithGrades
);

// View grades for Owner and teachers
router.get("/", authorize(ROLES.OWNER, ROLES.TEACHER), getGrades);
router.get(
  "/class/:classId/date/:date",
  validateObjectId("classId"),
  authorize(ROLES.OWNER, ROLES.TEACHER),
  getGradesByClassAndDate
);

// Only teacher can add and edit grades
router.post("/", authorize(ROLES.TEACHER), validateGrade(), createGrade);
router.put("/:id", validateObjectId("id"), authorize(ROLES.TEACHER), validateGrade(), updateGrade);

// Teacher can delete own today's grades, Owner can delete any
router.delete("/:id", validateObjectId("id"), authorize(ROLES.TEACHER, ROLES.OWNER), deleteGrade);

// Owner views a student's grades
router.get("/student/:studentId", validateObjectId("studentId"), authorize(ROLES.OWNER), getStudentGrades);

module.exports = router;
