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
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId, validateGrade } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// All routes are protected
router.use(protect);

// Export grades to Excel
router.get("/export", authorizePermission(PERMISSIONS.GRADES_EXPORT, ROLES.TEACHER), exportGrades);

// Qo'yilmagan baholar (faqat owner)
router.get("/missing-today", authorizePermission(PERMISSIONS.GRADES_VIEW), getMissingGradesToday);

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
  authorizePermission(PERMISSIONS.GRADES_VIEW, ROLES.TEACHER),
  getStudentsWithGrades
);

// View grades for Owner and teachers
router.get("/", authorizePermission(PERMISSIONS.GRADES_VIEW, ROLES.TEACHER), getGrades);
router.get(
  "/class/:classId/date/:date",
  validateObjectId("classId"),
  authorizePermission(PERMISSIONS.GRADES_VIEW, ROLES.TEACHER),
  getGradesByClassAndDate
);

// Baho qo'yish/tahrirlash — o'qituvchi doim, xodim `grades.create/update` bilan
router.post("/", authorizePermission(PERMISSIONS.GRADES_CREATE, ROLES.TEACHER), validateGrade(), createGrade);
router.put("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.GRADES_UPDATE, ROLES.TEACHER), validateGrade(), updateGrade);

// Teacher can delete own today's grades, Owner can delete any
router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.GRADES_DELETE, ROLES.TEACHER), deleteGrade);

// Owner views a student's grades
router.get("/student/:studentId", validateObjectId("studentId"), authorizePermission(PERMISSIONS.GRADES_VIEW), getStudentGrades);

module.exports = router;
