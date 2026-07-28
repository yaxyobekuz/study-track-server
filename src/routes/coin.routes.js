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
  getCoinLeaderboard,
} = require("../controllers/coin.controller");
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

router.use(protect);

// Owner routes
router.get("/settings", authorizePermission(PERMISSIONS.COINS_VIEW), getSettings);
router.put("/settings", authorizePermission(PERMISSIONS.COINS_SETTINGS), updateSettings);
router.get("/stats", authorizePermission(PERMISSIONS.COINS_VIEW), getCoinStats);
router.get("/transactions/:studentId", validateObjectId("studentId"), authorizePermission(PERMISSIONS.COINS_VIEW), getStudentTransactions);
router.post("/distribute", authorizePermission(PERMISSIONS.COINS_DISTRIBUTE), distributeCoins);

// Student routes
router.get("/balance", authorize(ROLES.STUDENT), getMyBalance);
router.get("/transactions", authorize(ROLES.STUDENT), getMyTransactions);
router.get("/leaderboard", authorize(ROLES.STUDENT), getCoinLeaderboard);

module.exports = router;
