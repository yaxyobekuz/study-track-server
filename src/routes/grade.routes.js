const express = require('express');
const router = express.Router();
const {
  getGrades,
  getGradesByClassAndDate,
  createGrade,
  updateGrade,
  deleteGrade,
  getStudentGrades
} = require('../controllers/grade.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

// Barcha routelar himoyalangan
router.use(protect);

// O'quvchi o'z baholarini ko'rishi
router.get('/student/my-grades', authorize('student'), getStudentGrades);

// Owner va o'qituvchilar uchun
router.get('/', authorize('owner', 'teacher'), getGrades);
router.get('/class/:classId/date/:date', authorize('owner', 'teacher'), getGradesByClassAndDate);

// O'qituvchi va owner baho qo'yishi
router.post('/', authorize('owner', 'teacher'), createGrade);

// O'qituvchi bahoni tahrirlashi (2 kun ichida)
router.put('/:id', authorize('owner', 'teacher'), updateGrade);

// Faqat owner baho o'chirishi mumkin
router.delete('/:id', authorize('owner'), deleteGrade);

// Owner biror o'quvchining baholarini ko'rishi
router.get('/student/:studentId', authorize('owner'), getStudentGrades);

module.exports = router;
