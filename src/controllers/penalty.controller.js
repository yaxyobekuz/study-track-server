const penaltyService = require("../services/penalty.service");

// ─── KATEGORIYA ────────────────────────────────────────────────────

/**
 * GET /api/penalties/categories
 * @access Private (owner, teacher)
 */
exports.getCategories = async (req, res) => {
  try {
    const { targetRole } = req.query;
    const categories = await penaltyService.getCategories(targetRole);
    return res.json({ success: true, data: categories });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};

/**
 * POST /api/penalties/categories
 * @access Private (owner)
 */
exports.createPenaltyCategory = async (req, res) => {
  try {
    const { title, description, points, targetRole } = req.body;

    if (!title || !points || !targetRole) {
      return res
        .status(400)
        .json({ success: false, message: "Sarlavha, ball va maqsadli rol majburiy" });
    }

    if (!["teacher", "student"].includes(targetRole)) {
      return res
        .status(400)
        .json({ success: false, message: "Maqsadli rol noto'g'ri" });
    }

    if (points < 1) {
      return res
        .status(400)
        .json({ success: false, message: "Ball kamida 1 bo'lishi kerak" });
    }

    const category = await penaltyService.createPenaltyCategory(
      { title, description, points, targetRole },
      req.user._id,
    );
    return res.status(201).json({ success: true, data: category });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};

/**
 * PUT /api/penalties/categories/:id
 * @access Private (owner)
 */
exports.updateCategory = async (req, res) => {
  try {
    const { title, description, points } = req.body;
    const category = await penaltyService.updateCategory(req.params.id, {
      title,
      description,
      points,
    });
    return res.json({
      success: true,
      message: "Kategoriya yangilandi",
      data: category,
    });
  } catch (error) {
    const status = error.message === "Kategoriya topilmadi" ? 404 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * DELETE /api/penalties/categories/:id
 * @access Private (owner)
 */
exports.deleteCategory = async (req, res) => {
  try {
    await penaltyService.deleteCategory(req.params.id);
    return res.json({ success: true, message: "Kategoriya o'chirildi" });
  } catch (error) {
    const status = error.message === "Kategoriya topilmadi" ? 404 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

// ─── JARIMA ────────────────────────────────────────────────────────

/**
 * POST /api/penalties
 * @access Private (owner, teacher)
 */
exports.createPenalty = async (req, res) => {
  try {
    const { userId, categoryId, title, description, points, isCustom } = req.body;

    if (!userId) {
      return res
        .status(400)
        .json({ success: false, message: "Foydalanuvchi majburiy" });
    }

    if (isCustom === "true" || isCustom === true) {
      if (!title || !points) {
        return res
          .status(400)
          .json({ success: false, message: "Custom jarima uchun sarlavha va ball majburiy" });
      }
    } else {
      if (!categoryId) {
        return res
          .status(400)
          .json({ success: false, message: "Kategoriya majburiy" });
      }
    }

    const penalty = await penaltyService.createPenalty({
      userId,
      categoryId,
      title,
      description,
      points: Number(points),
      givenBy: req.user._id,
      givenByRole: req.user.role,
      isCustom: isCustom === "true" || isCustom === true,
      files: req.files || [],
    });

    return res.status(201).json({ success: true, data: penalty });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: error.message });
  }
};

/**
 * GET /api/penalties
 * @access Private (owner)
 */
exports.getPenalties = async (req, res) => {
  try {
    const result = await penaltyService.getPenalties(req);
    return res.json(result);
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};

/**
 * GET /api/penalties/pending
 * @access Private (owner)
 */
exports.getPendingPenalties = async (req, res) => {
  try {
    const result = await penaltyService.getPendingPenalties(req);
    return res.json(result);
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};

/**
 * GET /api/penalties/stats
 * @access Private (owner)
 */
exports.getPenaltyStats = async (req, res) => {
  try {
    const stats = await penaltyService.getPenaltyStats();
    return res.json({ success: true, data: stats });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};

/**
 * GET /api/penalties/settings
 * @access Private (owner)
 */
exports.getSettings = async (req, res) => {
  try {
    const settings = await penaltyService.getSettings();
    return res.json({ success: true, data: settings });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};

/**
 * PUT /api/penalties/settings
 * @access Private (owner)
 */
exports.updateSettings = async (req, res) => {
  try {
    const { studentFineAmount, teacherFineAmount } = req.body;

    if (studentFineAmount !== undefined && studentFineAmount < 0) {
      return res
        .status(400)
        .json({ success: false, message: "Jarima miqdori manfiy bo'lishi mumkin emas" });
    }
    if (teacherFineAmount !== undefined && teacherFineAmount < 0) {
      return res
        .status(400)
        .json({ success: false, message: "Jarima miqdori manfiy bo'lishi mumkin emas" });
    }

    const settings = await penaltyService.updateSettings(
      { studentFineAmount, teacherFineAmount },
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
 * GET /api/penalties/my
 * @access Private (student, teacher)
 */
exports.getMyPenalties = async (req, res) => {
  try {
    const result = await penaltyService.getMyPenalties(req.user._id, req);
    return res.json(result);
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};

/**
 * GET /api/penalties/given
 * @access Private (teacher)
 */
exports.getGivenPenalties = async (req, res) => {
  try {
    const result = await penaltyService.getGivenPenalties(req.user._id, req);
    return res.json(result);
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};

/**
 * GET /api/penalties/reductions
 * @access Private (owner)
 */
exports.getReductions = async (req, res) => {
  try {
    const result = await penaltyService.getReductions(req);
    return res.json(result);
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};

/**
 * GET /api/penalties/:id
 * @access Private (owner, teacher)
 */
exports.getPenaltyById = async (req, res) => {
  try {
    const penalty = await penaltyService.getPenaltyById(req.params.id);
    return res.json({ success: true, data: penalty });
  } catch (error) {
    const status = error.message === "Jarima topilmadi" ? 404 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

/**
 * PUT /api/penalties/:id/review
 * @access Private (owner)
 */
exports.reviewPenalty = async (req, res) => {
  try {
    const { status, rejectionReason } = req.body;

    if (!status || !["approved", "rejected"].includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Status 'approved' yoki 'rejected' bo'lishi kerak" });
    }

    const penalty = await penaltyService.reviewPenalty(req.params.id, {
      status,
      rejectionReason,
      reviewedBy: req.user._id,
    });

    const isReduction = penalty.type === "reduction";
    const message = status === "approved"
      ? (isReduction ? "Kamaytirish tasdiqlandi" : "Jarima tasdiqlandi")
      : (isReduction ? "Kamaytirish rad etildi" : "Jarima rad etildi");
    return res.json({ success: true, message, data: penalty });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: error.message });
  }
};

/**
 * GET /api/penalties/user/:userId
 * @access Private (owner)
 */
exports.getUserPenalties = async (req, res) => {
  try {
    const result = await penaltyService.getUserPenalties(req.params.userId, req);
    return res.json(result);
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Server xatosi", error: error.message });
  }
};

/**
 * POST /api/penalties/reduce
 * @access Private (owner)
 */
exports.reducePenalty = async (req, res) => {
  try {
    const { userId, points, reason } = req.body;

    if (!userId || !points || !reason) {
      return res
        .status(400)
        .json({ success: false, message: "Foydalanuvchi, ball va sabab majburiy" });
    }

    if (points < 1) {
      return res
        .status(400)
        .json({ success: false, message: "Ball kamida 1 bo'lishi kerak" });
    }

    const reduction = await penaltyService.reducePenalty({
      userId,
      points: Number(points),
      reason,
      reducedBy: req.user._id,
      reducedByRole: req.user.role,
    });

    return res.status(201).json({
      success: true,
      message: "Kamaytirish so'rovi yuborildi",
      data: reduction,
    });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: error.message });
  }
};
