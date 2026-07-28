const express = require("express");
const router = express.Router();
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const {
  getToday,
  getTodayAll,
  markStaff,
  checkIn,
  checkOut,
  getMySchedule,
  getUserSchedule,
  getMyHistory,
  cancelExcuseRequest,
  getRecentExcuses,
  getSettings,
  updateSettings,
  getAllRecords,
  getUserMonthRecords,
  getRecord,
  createExcuseRequest,
  getMyExcuses,
  getAllExcuses,
  getExcuse,
  reviewExcuse,
} = require("../controllers/attendance.controller");

router.get("/settings", protect, authorizePermission(PERMISSIONS.ATTENDANCE), getSettings);
router.put("/settings", protect, authorizePermission(PERMISSIONS.ATTENDANCE), updateSettings);

router.get("/today", protect, getToday);
router.get("/today/all", protect, authorizePermission(PERMISSIONS.ATTENDANCE), getTodayAll);
router.post("/mark", protect, authorizePermission(PERMISSIONS.ATTENDANCE), markStaff);
router.get("/my", protect, getMyHistory);
router.get("/my-schedule", protect, getMySchedule);
router.post("/check-in", protect, checkIn);
router.post("/check-out", protect, checkOut);

router.post("/excuse", protect, createExcuseRequest);
router.get("/excuse/my", protect, getMyExcuses);
router.get("/excuse/recent", protect, authorizePermission(PERMISSIONS.ATTENDANCE), getRecentExcuses);
router.get("/excuse", protect, authorizePermission(PERMISSIONS.ATTENDANCE), getAllExcuses);
router.delete("/excuse/:id", protect, cancelExcuseRequest);
router.get("/excuse/:id", protect, authorizePermission(PERMISSIONS.ATTENDANCE), getExcuse);
router.put("/excuse/:id/review", protect, authorizePermission(PERMISSIONS.ATTENDANCE), reviewExcuse);

router.get("/user/:userId", protect, authorizePermission(PERMISSIONS.ATTENDANCE), getUserMonthRecords);
router.get(
  "/user-schedule/:userId",
  protect,
  authorizePermission(PERMISSIONS.ATTENDANCE),
  getUserSchedule,
);
router.get("/", protect, authorizePermission(PERMISSIONS.ATTENDANCE), getAllRecords);
router.get("/:id", protect, authorizePermission(PERMISSIONS.ATTENDANCE), getRecord);

module.exports = router;
