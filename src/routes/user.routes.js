const express = require("express");
const router = express.Router();
const {
  getAllUsers,
  createUser,
  updateUser,
  resetPassword,
  getUserPassword,
  deleteUser,
  getStats,
  exportUsersToExcel,
  getStudents,
} = require("../controllers/user.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// /students route is accessible to both owner and teacher
router.get("/students", protect, authorize("owner", "teacher"), getStudents);

// All routes below are protected and for owner only
router.use(protect);
router.use(authorize("owner"));

router.get("/stats", getStats);
router.get("/export", exportUsersToExcel);
router.route("/").get(getAllUsers).post(createUser);

router.route("/:id").put(updateUser).delete(deleteUser);

router.put("/:id/reset-password", resetPassword);
router.get("/:id/password", getUserPassword);

module.exports = router;
