const express = require('express');
const router = express.Router();
const {
  getAllSubjects,
  createSubject,
  updateSubject,
  deleteSubject
} = require('../controllers/subject.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

// Barcha routelar himoyalangan
router.use(protect);

// GET routelari hamma uchun (teacher, student, owner)
router.get('/', getAllSubjects);

// CUD operatsiyalari faqat owner uchun
router.post('/', authorize('owner'), createSubject);
router.put('/:id', authorize('owner'), updateSubject);
router.delete('/:id', authorize('owner'), deleteSubject);

module.exports = router;
