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
  // TANGA CHEKLOVI — qarzdor o'quvchiga tanga berilmaydi
  getCoinBlocks,
  getCoinBlockSummary,
  getCoinBlockCandidates,
  blockCoins,
  unblockCoins,
  getMyCoinBlock,
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

// ── TANGA CHEKLOVI ───────────────────────────────────────────────
// ⚠️ `/blocks/my` — O'QUVCHINING O'ZI uchun, ruxsat kalitisiz (id tokendan).
// U `/blocks` dan OLDIN turishi shart emas (yo'llar bir-biriga kirmaydi),
// lekin `/transactions/:studentId` kabi parametrli yo'l qo'shilsa, aniq
// yo'llar har doim undan OLDIN saqlanadi (`payroll.routes.js` tuzog'i).
router.get("/blocks/my", authorize(ROLES.STUDENT), getMyCoinBlock);
router.get("/blocks/summary", authorizePermission(PERMISSIONS.COINS_BLOCK), getCoinBlockSummary);
router.get("/blocks/candidates", authorizePermission(PERMISSIONS.COINS_BLOCK), getCoinBlockCandidates);
router.get("/blocks", authorizePermission(PERMISSIONS.COINS_BLOCK), getCoinBlocks);
router.post("/blocks", authorizePermission(PERMISSIONS.COINS_BLOCK), blockCoins);
router.post("/blocks/unblock", authorizePermission(PERMISSIONS.COINS_BLOCK), unblockCoins);

router.get("/transactions/:studentId", validateObjectId("studentId"), authorizePermission(PERMISSIONS.COINS_VIEW), getStudentTransactions);
router.post("/distribute", authorizePermission(PERMISSIONS.COINS_DISTRIBUTE), distributeCoins);

// Student routes
router.get("/balance", authorize(ROLES.STUDENT), getMyBalance);
router.get("/transactions", authorize(ROLES.STUDENT), getMyTransactions);
router.get("/leaderboard", authorize(ROLES.STUDENT), getCoinLeaderboard);

module.exports = router;
