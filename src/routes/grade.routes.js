const express = require("express");
const router = express.Router();
const {
  getGrades,
  getGradesByClassAndDate,
  createGrade,
  updateGrade,
  deleteGrade,
  getStudentGrades,
  getTeacherSubjectsInClass,
  getStudentsWithGrades,
} = require("../controllers/grade.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// Barcha routelar himoyalangan
router.use(protect);

// O'quvchi o'z baholarini ko'rishi
router.get("/student/my-grades", authorize("student"), getStudentGrades);

// Teacher uchun maxsus endpointlar
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

// Owner va o'qituvchilar uchun baholarni ko'rish
router.get("/", authorize("owner", "teacher"), getGrades);
router.get(
  "/class/:classId/date/:date",
  authorize("owner", "teacher"),
  getGradesByClassAndDate
);

// Faqat teacher baho qo'yishi va tahrirlashi
router.post("/", authorize("teacher"), createGrade);
router.put("/:id", authorize("teacher"), updateGrade);

// Faqat owner baho o'chirishi mumkin
router.delete("/:id", authorize("owner"), deleteGrade);

// Owner biror o'quvchining baholarini ko'rishi
router.get("/student/:studentId", authorize("owner"), getStudentGrades);

module.exports = router;
