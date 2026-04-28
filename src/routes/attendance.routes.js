const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/auth.middleware");
const {
  getToday,
  getTodayAll,
  checkIn,
  checkOut,
  getMyHistory,
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

router.get("/settings", protect, authorize("owner"), getSettings);
router.put("/settings", protect, authorize("owner"), updateSettings);

router.get("/today", protect, getToday);
router.get("/today/all", protect, authorize("owner"), getTodayAll);
router.get("/my", protect, getMyHistory);
router.post("/check-in", protect, checkIn);
router.post("/check-out", protect, checkOut);

router.post("/excuse", protect, createExcuseRequest);
router.get("/excuse/my", protect, getMyExcuses);
router.get("/excuse", protect, authorize("owner"), getAllExcuses);
router.get("/excuse/:id", protect, authorize("owner"), getExcuse);
router.put("/excuse/:id/review", protect, authorize("owner"), reviewExcuse);

router.get("/user/:userId", protect, authorize("owner"), getUserMonthRecords);
router.get("/", protect, authorize("owner"), getAllRecords);
router.get("/:id", protect, authorize("owner"), getRecord);

module.exports = router;
