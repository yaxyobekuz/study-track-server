const express = require('express');
const router = express.Router();
const {
  getAllUsers,
  createUser,
  updateUser,
  resetPassword,
  deleteUser
} = require('../controllers/user.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

// Barcha routelar himoyalangan va faqat owner uchun
router.use(protect);
router.use(authorize('owner'));

router.route('/')
  .get(getAllUsers)
  .post(createUser);

router.route('/:id')
  .put(updateUser)
  .delete(deleteUser);

router.put('/:id/reset-password', resetPassword);

module.exports = router;
