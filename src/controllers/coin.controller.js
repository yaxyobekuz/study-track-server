const coinService = require("../services/coin.service");
// TANGA CHEKLOVI yadrosi — darvoza ham, registr ham shu yerda
const coinBlockService = require("../services/coinBlock.service");
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
    req.user.id,
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
    req.user.id,
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
    givenBy: req.user.id,
  });

  // ⚠️ TANGA CHEKLOVI ALOHIDA AYTILADI: "0 ta foydalanuvchiga berildi"
  // degan jim javob admin uchun nosozlikka o'xshardi — aslida bu qoida
  // (`coinBlock.service.js`). Bitta o'quvchi tanlangan holda servis
  // umuman 409 bilan rad etadi.
  const base =
    action === "give"
      ? `${result.successCount} ta foydalanuvchiga tanga berildi`
      : `${result.successCount} ta foydalanuvchidan tanga olindi`;

  const message = result.blockedCount
    ? `${base}. ${result.blockedCount} tasiga tanga berish taqiqlangan (qarzdorlik) — ularga yozilmadi`
    : base;

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

// ─────────────────────────────────────────────
// TANGA CHEKLOVI (qarzdor o'quvchiga tanga berilmaydi)
// ─────────────────────────────────────────────
// Yadro — `coinBlock.service.js`: darvoza ham, registr ham shu yerda.
// Controller faqat so'rovni o'qiydi; tekshiruvlar servisda (ommaviy yo'l
// bittalik yo'ldan yumshoqroq shart olmasligi uchun).

/**
 * GET /api/coins/blocks
 * Cheklovlar registri: `status=active` (sukut) yoki `status=revoked` (tarix).
 * @access Private (`coins.block`)
 */
exports.getCoinBlocks = asyncHandler(async (req, res) => {
  const result = await coinBlockService.listBlocks(req);
  return res.json(result);
});

/**
 * GET /api/coins/blocks/summary
 * Kartalar: nechta cheklangan, jami joriy qarz, qarzi yopilganlar soni.
 * @access Private (`coins.block`)
 */
exports.getCoinBlockSummary = asyncHandler(async (req, res) => {
  const data = await coinBlockService.getBlockSummary();
  return res.json({ success: true, data });
});

/**
 * GET /api/coins/blocks/candidates
 * Cheklash uchun tanlov ro'yxati — sukut bo'yicha QARZDORLAR
 * (`debtorsOnly=false` — barcha o'quvchilar).
 * @access Private (`coins.block`)
 */
exports.getCoinBlockCandidates = asyncHandler(async (req, res) => {
  const result = await coinBlockService.getBlockCandidates(req);
  return res.json(result);
});

/**
 * POST /api/coins/blocks
 * BIR NECHTA O'QUVCHINI BIR AMALDA cheklash: { studentIds[], reason, note }.
 * @access Private (`coins.block`)
 */
exports.blockCoins = asyncHandler(async (req, res) => {
  const { studentIds, reason, note } = req.body;

  const result = await coinBlockService.blockStudents({
    studentIds,
    reason,
    note,
    createdBy: req.user.id,
  });

  const parts = [`${result.blockedCount} ta o'quvchiga tanga berish taqiqlandi`];
  if (result.skippedCount) parts.push(`${result.skippedCount} tasi allaqachon cheklangan`);
  if (result.failedCount) parts.push(`${result.failedCount} tasida xato`);

  return res.json({ success: true, message: parts.join(", "), data: result });
});

/**
 * POST /api/coins/blocks/unblock
 * Cheklovni olib tashlash: { studentIds[] } yoki { blockIds[] } + reason.
 * @access Private (`coins.block`)
 */
exports.unblockCoins = asyncHandler(async (req, res) => {
  const { studentIds, blockIds, reason } = req.body;

  const result = await coinBlockService.unblockStudents({
    studentIds,
    blockIds,
    reason,
    revokedBy: req.user.id,
  });

  const parts = [`${result.unblockedCount} ta o'quvchiga tanga berish ochildi`];
  if (result.failedCount) parts.push(`${result.failedCount} tasida xato`);

  return res.json({ success: true, message: parts.join(", "), data: result });
});

/**
 * GET /api/coins/blocks/my
 * O'quvchi O'ZI ko'radi: cheklanganmi, nima uchun, qachondan.
 * ⚠️ Ruxsat kaliti YO'Q — id tokendan (`/payroll/deductions/my` bilan AYNI
 * qoida). Cheklov yashirin emas: tangasi to'xtagan o'quvchi sababini
 * ekranda ko'rishi kerak.
 * @access Private (student)
 */
exports.getMyCoinBlock = asyncHandler(async (req, res) => {
  const data = await coinBlockService.getMyBlock(req.user.id);
  return res.json({ success: true, data });
});
