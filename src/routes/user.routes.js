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

// All routes are protected and for owner only
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
