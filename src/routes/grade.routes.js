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

// All routes are protected
router.use(protect);

// Export grades to Excel
router.get("/export", authorize("owner", "teacher"), exportGrades);

// Qo'yilmagan baholar (faqat owner)
router.get("/missing-today", authorize("owner"), getMissingGradesToday);

// Student views their own grades
router.get("/student/my-grades", authorize("student"), getStudentGrades);

// Teacher specific endpoints
router.get(
  "/teacher/subjects/:classId",
  authorize("teacher"),
  getTeacherSubjectsInClass
);
router.get(
  "/students-with-grades",
  authorize("teacher", "owner"),
  getStudentsWithGrades
);

// View grades for Owner and teachers
router.get("/", authorize("owner", "teacher"), getGrades);
router.get(
  "/class/:classId/date/:date",
  authorize("owner", "teacher"),
  getGradesByClassAndDate
);

// Only teacher can add and edit grades
router.post("/", authorize("teacher"), createGrade);
router.put("/:id", authorize("teacher"), updateGrade);

// Teacher can delete own today's grades, Owner can delete any
router.delete("/:id", authorize("teacher", "owner"), deleteGrade);

// Owner views a student's grades
router.get("/student/:studentId", authorize("owner"), getStudentGrades);

module.exports = router;
