const coinService = require("../services/coin.service");
const asyncHandler = require("../middleware/async.middleware");
const { BadRequestError } = require("../utils/errors");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");

/**
 * GET /api/coins/settings
 * @access Private (owner only)
 */
exports.getSettings = asyncHandler(async (req, res) => {
  const settings = await coinService.getSettings();
  return res.json({ success: true, data: settings });
});

/**
 * PUT /api/coins/settings
 * @access Private (owner only)
 */
exports.updateSettings = asyncHandler(async (req, res) => {
  const { dailyCoinPercentage, schoolRankBonus, classRankBonus, minDailyGradeForCoin } = req.body;

  if (
    dailyCoinPercentage !== undefined &&
    (dailyCoinPercentage < 0 || dailyCoinPercentage > 100)
  ) {
    throw new BadRequestError("Foiz 0 dan 100 gacha bo'lishi kerak");
  }
  if (schoolRankBonus !== undefined && schoolRankBonus < 0) {
    throw new BadRequestError("Bonus manfiy bo'lishi mumkin emas");
  }
  if (classRankBonus !== undefined && classRankBonus < 0) {
    throw new BadRequestError("Bonus manfiy bo'lishi mumkin emas");
  }
  if (minDailyGradeForCoin !== undefined && minDailyGradeForCoin < 0) {
    throw new BadRequestError("Minimal ball manfiy bo'lishi mumkin emas");
  }

  const settings = await coinService.updateSettings(
    { dailyCoinPercentage, schoolRankBonus, classRankBonus, minDailyGradeForCoin },
    req.user._id,
  );
  return res.json({
    success: true,
    message: "Sozlamalar saqlandi",
    data: settings,
  });
});

/**
 * GET /api/coins/stats
 * @access Private (owner only)
 */
exports.getCoinStats = asyncHandler(async (req, res) => {
  const stats = await coinService.getCoinStats();
  return res.json({ success: true, data: stats });
});

/**
 * GET /api/coins/transactions
 * @access Private (student - own transactions only)
 */
exports.getMyTransactions = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);

  const result = await coinService.getStudentTransactions(
    req.user._id,
    pageNum,
    limitNum,
  );

  return res.json({ success: true, data: result.transactions, pagination: result.pagination });
});

/**
 * GET /api/coins/transactions/:studentId
 * @access Private (owner only)
 */
exports.getStudentTransactions = asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const { page = 1, limit = 20 } = req.query;
  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);

  const result = await coinService.getStudentTransactions(
    studentId,
    pageNum,
    limitNum,
  );

  return res.json({ success: true, data: result.transactions, pagination: result.pagination });
});

/**
 * POST /api/coins/distribute
 * @access Private (owner only)
 */
exports.distributeCoins = asyncHandler(async (req, res) => {
  const { action, amount, reason, filterType, filterValue } = req.body;

  if (!action || !["give", "take"].includes(action)) {
    throw new BadRequestError("Amal 'give' yoki 'take' bo'lishi kerak");
  }

  const parsedAmount = parseInt(amount, 10);
  if (!parsedAmount || parsedAmount <= 0) {
    throw new BadRequestError("Miqdor musbat son bo'lishi kerak");
  }

  if (!reason || !reason.trim()) {
    throw new BadRequestError("Sabab majburiy");
  }

  const validTypes = ["role", "class", "gender", "individual"];
  if (!filterType || !validTypes.includes(filterType)) {
    throw new BadRequestError("Noto'g'ri filter turi");
  }

  if (!filterValue) {
    throw new BadRequestError("Filter qiymati majburiy");
  }

  const result = await coinService.distributeManualCoins({
    action,
    amount: parsedAmount,
    reason: reason.trim(),
    filterType,
    filterValue,
    givenBy: req.user._id,
  });

  const message =
    action === "give"
      ? `${result.successCount} ta foydalanuvchiga tanga berildi`
      : `${result.successCount} ta foydalanuvchidan tanga olindi`;

  return res.json({ success: true, message, data: result });
});

/**
 * GET /api/coins/balance
 * @access Private (student - own balance)
 */
exports.getMyBalance = asyncHandler(async (req, res) => {
  return res.json({
    success: true,
    data: { coinBalance: req.user.coinBalance || 0 },
  });
});

/**
 * GET /api/coins/leaderboard
 * @access Private (student)
 */
exports.getCoinLeaderboard = asyncHandler(async (req, res) => {
  const { page, limit } = getPaginationParams(req, 50);
  const result = await coinService.getCoinLeaderboard(page, limit);
  return res.json(formatPaginationResponse(result.rankings, result.pagination.total, page, limit));
});
