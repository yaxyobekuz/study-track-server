const express = require('express');
const router = express.Router();
const {
  getAllClasses,
  getClass,
  createClass,
  updateClass,
  deleteClass
} = require('../controllers/class.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

// Barcha routelar himoyalangan
router.use(protect);

// GET routelari hamma uchun
router.get('/', getAllClasses);
router.get('/:id', getClass);

// CUD operatsiyalari faqat owner uchun
router.post('/', authorize('owner'), createClass);
router.put('/:id', authorize('owner'), updateClass);
router.delete('/:id', authorize('owner'), deleteClass);

module.exports = router;
