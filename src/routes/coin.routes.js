const express = require("express");
const router = express.Router();
const {
  getSettings,
  updateSettings,
  getCoinStats,
  getMyTransactions,
  getStudentTransactions,
  getMyBalance,
} = require("../controllers/coin.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

router.use(protect);

// Owner routes
router.get("/settings", authorize("owner"), getSettings);
router.put("/settings", authorize("owner"), updateSettings);
router.get("/stats", authorize("owner"), getCoinStats);
router.get("/transactions/:studentId", authorize("owner"), getStudentTransactions);

// Student routes
router.get("/balance", authorize("student"), getMyBalance);
router.get("/transactions", authorize("student"), getMyTransactions);

module.exports = router;
