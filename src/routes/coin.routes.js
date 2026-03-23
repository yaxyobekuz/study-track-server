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
} = require("../controllers/coin.controller");
const { protect, authorize } = require("../middleware/auth.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

router.use(protect);

// Owner routes
router.get("/settings", authorize(ROLES.OWNER), getSettings);
router.put("/settings", authorize(ROLES.OWNER), updateSettings);
router.get("/stats", authorize(ROLES.OWNER), getCoinStats);
router.get("/transactions/:studentId", validateObjectId("studentId"), authorize(ROLES.OWNER), getStudentTransactions);
router.post("/distribute", authorize(ROLES.OWNER), distributeCoins);

// Student routes
router.get("/balance", authorize(ROLES.STUDENT), getMyBalance);
router.get("/transactions", authorize(ROLES.STUDENT), getMyTransactions);

module.exports = router;
