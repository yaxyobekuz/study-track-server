const express = require("express");
const router = express.Router();
const {
  getAllUsers,
  getAllUsersShort,
  getUser,
  createUser,
  updateUser,
  resetPassword,
  getUserPassword,
  deleteUser,
  getStats,
  exportUsersToExcel,
  getStudents,
  updateMe,
} = require("../controllers/user.controller");
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// /students route is accessible to both owner and teacher
router.get("/students", protect, authorize(ROLES.OWNER, ROLES.TEACHER), getStudents);

// Own profile update — accessible to any authenticated user
router.put("/me", protect, updateMe);

// all-short — owner, teacher, reception uchun
router.get("/all-short", protect, authorize(ROLES.OWNER, ROLES.TEACHER, ROLES.RECEPTION), getAllUsersShort);

// All routes below are protected and for owner only
router.use(protect);
router.use(authorize(ROLES.OWNER));

router.get("/stats", getStats);
router.get("/export", exportUsersToExcel);
router.route("/").get(getAllUsers).post(createUser);

router.route("/:id").all(validateObjectId("id")).get(getUser).put(updateUser).delete(deleteUser);

router.put("/:id/reset-password", validateObjectId("id"), resetPassword);
router.get("/:id/password", validateObjectId("id"), getUserPassword);

module.exports = router;
