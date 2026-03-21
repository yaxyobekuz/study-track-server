const coinService = require("../services/coin.service");

/**
 * GET /api/coins/settings
 * @access Private (owner only)
 */
exports.getSettings = async (req, res) => {
  try {
    const settings = await coinService.getSettings();
    return res.json({ success: true, data: settings });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};

/**
 * PUT /api/coins/settings
 * @access Private (owner only)
 */
exports.updateSettings = async (req, res) => {
  try {
    const { dailyCoinPercentage, schoolRankBonus, classRankBonus, minDailyGradeForCoin } = req.body;

    if (
      dailyCoinPercentage !== undefined &&
      (dailyCoinPercentage < 0 || dailyCoinPercentage > 100)
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Foiz 0 dan 100 gacha bo'lishi kerak" });
    }
    if (schoolRankBonus !== undefined && schoolRankBonus < 0) {
      return res
        .status(400)
        .json({ success: false, message: "Bonus manfiy bo'lishi mumkin emas" });
    }
    if (classRankBonus !== undefined && classRankBonus < 0) {
      return res
        .status(400)
        .json({ success: false, message: "Bonus manfiy bo'lishi mumkin emas" });
    }
    if (minDailyGradeForCoin !== undefined && minDailyGradeForCoin < 0) {
      return res
        .status(400)
        .json({ success: false, message: "Minimal ball manfiy bo'lishi mumkin emas" });
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
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};

/**
 * GET /api/coins/stats
 * @access Private (owner only)
 */
exports.getCoinStats = async (req, res) => {
  try {
    const stats = await coinService.getCoinStats();
    return res.json({ success: true, data: stats });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};

/**
 * GET /api/coins/transactions
 * @access Private (student - own transactions only)
 */
exports.getMyTransactions = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    const result = await coinService.getStudentTransactions(
      req.user._id,
      pageNum,
      limitNum,
    );

    return res.json({ success: true, ...result });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};

/**
 * GET /api/coins/transactions/:studentId
 * @access Private (owner only)
 */
exports.getStudentTransactions = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    const result = await coinService.getStudentTransactions(
      studentId,
      pageNum,
      limitNum,
    );

    return res.json({ success: true, ...result });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};

/**
 * POST /api/coins/distribute
 * @access Private (owner only)
 */
exports.distributeCoins = async (req, res) => {
  try {
    const { action, amount, reason, filterType, filterValue } = req.body;

    if (!action || !["give", "take"].includes(action)) {
      return res
        .status(400)
        .json({ success: false, message: "Amal 'give' yoki 'take' bo'lishi kerak" });
    }

    const parsedAmount = parseInt(amount, 10);
    if (!parsedAmount || parsedAmount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Miqdor musbat son bo'lishi kerak" });
    }

    if (!reason || !reason.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Sabab majburiy" });
    }

    const validTypes = ["role", "class", "gender", "individual"];
    if (!filterType || !validTypes.includes(filterType)) {
      return res
        .status(400)
        .json({ success: false, message: "Noto'g'ri filter turi" });
    }

    if (!filterValue) {
      return res
        .status(400)
        .json({ success: false, message: "Filter qiymati majburiy" });
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
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};

/**
 * GET /api/coins/balance
 * @access Private (student - own balance)
 */
exports.getMyBalance = async (req, res) => {
  try {
    return res.json({
      success: true,
      data: { coinBalance: req.user.coinBalance || 0 },
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};
