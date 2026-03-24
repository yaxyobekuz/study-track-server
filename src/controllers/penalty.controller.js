const asyncHandler = require("../middleware/async.middleware");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const penaltyService = require("../services/penalty.service");
const Role = require("../models/role.model");

// ─── KATEGORIYA ────────────────────────────────────────────────────

/**
 * GET /api/penalties/categories
 * @access Private (owner, teacher)
 */
exports.getCategories = asyncHandler(async (req, res) => {
  const { targetRole } = req.query;
  const categories = await penaltyService.getCategories(targetRole);
  return res.json({ success: true, data: categories });
});

/**
 * POST /api/penalties/categories
 * @access Private (owner)
 */
exports.createPenaltyCategory = asyncHandler(async (req, res) => {
  const { title, description, points, targetRole } = req.body;

  if (!title || !points || !targetRole) {
    throw new BadRequestError("Sarlavha, ball va maqsadli rol majburiy");
  }

  if (targetRole === "owner") {
    throw new BadRequestError("Owner uchun kategoriya yaratib bo'lmaydi");
  }

  const roleExists = await Role.findOne({ value: targetRole });
  if (!roleExists) {
    throw new BadRequestError("Maqsadli rol topilmadi");
  }

  if (points < 1) {
    throw new BadRequestError("Ball kamida 1 bo'lishi kerak");
  }

  const category = await penaltyService.createPenaltyCategory(
    { title, description, points, targetRole },
    req.user._id,
  );
  return res.status(201).json({ success: true, data: category });
});

/**
 * PUT /api/penalties/categories/:id
 * @access Private (owner)
 */
exports.updateCategory = asyncHandler(async (req, res) => {
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
});

/**
 * DELETE /api/penalties/categories/:id
 * @access Private (owner)
 */
exports.deleteCategory = asyncHandler(async (req, res) => {
  await penaltyService.deleteCategory(req.params.id);
  return res.json({ success: true, message: "Kategoriya o'chirildi" });
});

// ─── JARIMA ────────────────────────────────────────────────────────

/**
 * POST /api/penalties
 * @access Private (owner, teacher)
 */
exports.createPenalty = asyncHandler(async (req, res) => {
  const { userId, categoryId, title, description, points, isCustom } = req.body;

  if (!userId) {
    throw new BadRequestError("Foydalanuvchi majburiy");
  }

  if (isCustom === "true" || isCustom === true) {
    if (!title || !points) {
      throw new BadRequestError("Custom jarima uchun sarlavha va ball majburiy");
    }
  } else {
    if (!categoryId) {
      throw new BadRequestError("Kategoriya majburiy");
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
});

/**
 * GET /api/penalties
 * @access Private (owner)
 */
exports.getPenalties = asyncHandler(async (req, res) => {
  const result = await penaltyService.getPenalties(req);
  return res.json(result);
});

/**
 * GET /api/penalties/pending
 * @access Private (owner)
 */
exports.getPendingPenalties = asyncHandler(async (req, res) => {
  const result = await penaltyService.getPendingPenalties(req);
  return res.json(result);
});

/**
 * GET /api/penalties/stats
 * @access Private (owner)
 */
exports.getPenaltyStats = asyncHandler(async (req, res) => {
  const stats = await penaltyService.getPenaltyStats();
  return res.json({ success: true, data: stats });
});

/**
 * GET /api/penalties/settings
 * @access Private (owner)
 */
exports.getSettings = asyncHandler(async (req, res) => {
  const settings = await penaltyService.getSettings();
  return res.json({ success: true, data: settings });
});

/**
 * PUT /api/penalties/settings
 * @access Private (owner)
 */
exports.updateSettings = asyncHandler(async (req, res) => {
  const { fineAmounts, studentFineAmount, teacherFineAmount } = req.body;

  // Yangi format: fineAmounts object validatsiya
  if (fineAmounts !== undefined) {
    if (typeof fineAmounts !== "object" || Array.isArray(fineAmounts)) {
      throw new BadRequestError("fineAmounts object bo'lishi kerak");
    }
    for (const [role, amount] of Object.entries(fineAmounts)) {
      if (typeof amount !== "number" || amount < 0) {
        throw new BadRequestError(
          `${role} uchun jarima miqdori noto'g'ri`,
        );
      }
    }
  }

  // Backward compat validatsiya
  if (studentFineAmount !== undefined && studentFineAmount < 0) {
    throw new BadRequestError("Jarima miqdori manfiy bo'lishi mumkin emas");
  }
  if (teacherFineAmount !== undefined && teacherFineAmount < 0) {
    throw new BadRequestError("Jarima miqdori manfiy bo'lishi mumkin emas");
  }

  const settings = await penaltyService.updateSettings(
    { fineAmounts, studentFineAmount, teacherFineAmount },
    req.user._id,
  );
  return res.json({
    success: true,
    message: "Sozlamalar saqlandi",
    data: settings,
  });
});

/**
 * GET /api/penalties/my
 * @access Private (student, teacher)
 */
exports.getMyPenalties = asyncHandler(async (req, res) => {
  const result = await penaltyService.getMyPenalties(req.user._id, req);
  return res.json(result);
});

/**
 * GET /api/penalties/given
 * @access Private (teacher)
 */
exports.getGivenPenalties = asyncHandler(async (req, res) => {
  const result = await penaltyService.getGivenPenalties(req.user._id, req);
  return res.json(result);
});

/**
 * GET /api/penalties/reductions
 * @access Private (owner)
 */
exports.getReductions = asyncHandler(async (req, res) => {
  const result = await penaltyService.getReductions(req);
  return res.json(result);
});

/**
 * GET /api/penalties/:id
 * @access Private (owner, teacher)
 */
exports.getPenaltyById = asyncHandler(async (req, res) => {
  const penalty = await penaltyService.getPenaltyById(req.params.id);
  return res.json({ success: true, data: penalty });
});

/**
 * PUT /api/penalties/:id/review
 * @access Private (owner)
 */
exports.reviewPenalty = asyncHandler(async (req, res) => {
  const { status, rejectionReason } = req.body;

  if (!status || !["approved", "rejected"].includes(status)) {
    throw new BadRequestError("Status 'approved' yoki 'rejected' bo'lishi kerak");
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
});

/**
 * GET /api/penalties/user/:userId
 * @access Private (owner)
 */
exports.getUserPenalties = asyncHandler(async (req, res) => {
  const result = await penaltyService.getUserPenalties(req.params.userId, req);
  return res.json(result);
});

/**
 * POST /api/penalties/reduce
 * @access Private (owner)
 */
exports.reducePenalty = asyncHandler(async (req, res) => {
  const { userId, points, reason } = req.body;

  if (!userId || !points || !reason) {
    throw new BadRequestError("Foydalanuvchi, ball va sabab majburiy");
  }

  if (points < 1) {
    throw new BadRequestError("Ball kamida 1 bo'lishi kerak");
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
});
