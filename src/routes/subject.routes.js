const express = require('express');
const router = express.Router();
const {
  getAllSubjects,
  createSubject,
  updateSubject,
  deleteSubject
} = require('../controllers/subject.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

// All routes are protected
router.use(protect);

// GET routes for everyone (teacher, student, owner)
router.get('/', getAllSubjects);

// CUD operations for owner only
router.post('/', authorize('owner'), createSubject);
router.put('/:id', authorize('owner'), updateSubject);
router.delete('/:id', authorize('owner'), deleteSubject);

module.exports = router;
