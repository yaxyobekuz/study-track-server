const express = require("express");
const router = express.Router();
const {
  getSettings,
  updateSettings,
  getCoinStats,
  getMyTransactions,
  getStudentTransactions,
  getMyBalance,
  distributeCoins,
  getDistributionPreview,
} = require("../controllers/coin.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

router.use(protect);

// Owner routes
router.get("/settings", authorize("owner"), getSettings);
router.put("/settings", authorize("owner"), updateSettings);
router.get("/stats", authorize("owner"), getCoinStats);
router.get("/transactions/:studentId", authorize("owner"), getStudentTransactions);
router.get("/distribute/preview", authorize("owner"), getDistributionPreview);
router.post("/distribute", authorize("owner"), distributeCoins);

// Student routes
router.get("/balance", authorize("student"), getMyBalance);
router.get("/transactions", authorize("student"), getMyTransactions);

module.exports = router;
