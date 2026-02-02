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
} = require("../controllers/user.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// All routes are protected and for owner only
router.use(protect);
router.use(authorize("owner"));

router.get("/stats", getStats);
router.get("/export", exportUsersToExcel);
router.route("/").get(getAllUsers).post(createUser);

router.route("/:id").put(updateUser).delete(deleteUser);

router.put("/:id/reset-password", resetPassword);
router.get("/:id/password", getUserPassword);

module.exports = router;
