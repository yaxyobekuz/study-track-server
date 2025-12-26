const express = require('express');
const router = express.Router();
const {
  getScheduleByClass,
  getScheduleByDay,
  createOrUpdateSchedule,
  deleteSchedule,
  getTeacherSchedule
} = require('../controllers/schedule.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

// Barcha routelar himoyalangan
router.use(protect);

// O'qituvchi uchun o'z jadvali
router.get('/teacher/my-schedule', authorize('teacher'), getTeacherSchedule);

// Sinf bo'yicha jadval
router.get('/class/:classId', getScheduleByClass);
router.get('/class/:classId/day/:day', getScheduleByDay);

// CRUD operatsiyalari faqat owner uchun
router.post('/', authorize('owner'), createOrUpdateSchedule);
router.delete('/:id', authorize('owner'), deleteSchedule);

module.exports = router;
