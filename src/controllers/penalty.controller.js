const asyncHandler = require("../middleware/async.middleware");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const penaltyService = require("../services/penalty.service");
const Role = require("../models/role.model");
const { ROLES } = require("../utils/constants");

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
  const { fineAmounts, studentFineAmount, teacherFineAmount, premiumReductionDiscountPercent } = req.body;

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

  if (premiumReductionDiscountPercent !== undefined) {
    if (
      typeof premiumReductionDiscountPercent !== "number" ||
      premiumReductionDiscountPercent < 0 ||
      premiumReductionDiscountPercent > 100
    ) {
      throw new BadRequestError("Premium chegirma 0 dan 100 gacha bo'lishi kerak");
    }
  }

  const settings = await penaltyService.updateSettings(
    { fineAmounts, studentFineAmount, teacherFineAmount, premiumReductionDiscountPercent },
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
 * DELETE /api/penalties/:id
 * @access Private (owner)
 */
exports.deletePenalty = asyncHandler(async (req, res) => {
  await penaltyService.deletePenalty(req.params.id);
  return res.json({ success: true, message: "Jarima o'chirildi" });
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

// ─── KAMAYTIRISH PAKETLARI ─────────────────────────────────────────

/**
 * GET /api/penalties/reduction-packages
 * @access Private (all authenticated)
 */
exports.getReductionPackages = asyncHandler(async (req, res) => {
  const onlyActive = req.user.role !== ROLES.OWNER;
  const packages = await penaltyService.getReductionPackages(onlyActive);
  return res.json({ success: true, data: packages });
});

/**
 * POST /api/penalties/reduction-packages
 * @access Private (owner)
 */
exports.createReductionPackage = asyncHandler(async (req, res) => {
  const { title, points, coinCost, order } = req.body;

  if (!title) throw new BadRequestError("Sarlavha majburiy");
  if (!points || Number(points) < 1) throw new BadRequestError("Ball kamida 1 bo'lishi kerak");
  if (!coinCost || Number(coinCost) < 1) throw new BadRequestError("Narx kamida 1 tanga bo'lishi kerak");

  const pkg = await penaltyService.createReductionPackage(
    { title, points: Number(points), coinCost: Number(coinCost), order: order !== undefined ? Number(order) : 0 },
    req.user._id,
  );
  return res.status(201).json({ success: true, data: pkg });
});

/**
 * PUT /api/penalties/reduction-packages/:id
 * @access Private (owner)
 */
exports.updateReductionPackage = asyncHandler(async (req, res) => {
  const { title, points, coinCost, order, isActive } = req.body;
  const pkg = await penaltyService.updateReductionPackage(req.params.id, {
    title,
    points: points !== undefined ? Number(points) : undefined,
    coinCost: coinCost !== undefined ? Number(coinCost) : undefined,
    order: order !== undefined ? Number(order) : undefined,
    isActive,
  });
  return res.json({ success: true, message: "Paket yangilandi", data: pkg });
});

/**
 * DELETE /api/penalties/reduction-packages/:id
 * @access Private (owner)
 */
exports.deleteReductionPackage = asyncHandler(async (req, res) => {
  await penaltyService.deleteReductionPackage(req.params.id);
  return res.json({ success: true, message: "Paket o'chirildi" });
});

/**
 * POST /api/penalties/reduction-packages/purchase
 * @access Private (student)
 */
exports.purchaseReductionPackage = asyncHandler(async (req, res) => {
  const { packageId } = req.body;
  if (!packageId) throw new BadRequestError("Paket IDsi majburiy");

  const result = await penaltyService.purchaseReductionPackage(req.user._id, packageId);
  return res.status(201).json({
    success: true,
    message: "Jarima muvaffaqiyatli kamaytirildi",
    data: result,
  });
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

/**
 * GET /api/penalties/grade-settings
 * @access Private (owner)
 */
exports.getGradePenaltySettings = asyncHandler(async (req, res) => {
  const settings = await penaltyService.getGradePenaltySettings();

  return res.json({
    success: true,
    data: settings,
  });
});

/**
 * PUT /api/penalties/grade-settings
 * @access Private (owner)
 */
exports.updateGradePenaltySettings = asyncHandler(async (req, res) => {
  const { isEnabled, penaltyPoints, missingThresholdPercent, exemptTeachers } = req.body;

  if (penaltyPoints !== undefined && penaltyPoints < 1) {
    throw new BadRequestError("Jarima bali kamida 1 bo'lishi kerak");
  }

  if (
    missingThresholdPercent !== undefined &&
    (missingThresholdPercent < 0 || missingThresholdPercent > 100)
  ) {
    throw new BadRequestError("Foiz 0 dan 100 gacha bo'lishi kerak");
  }

  const settings = await penaltyService.updateGradePenaltySettings(
    { isEnabled, penaltyPoints, missingThresholdPercent, exemptTeachers },
    req.user._id,
  );

  return res.json({
    success: true,
    message: "Sozlamalar saqlandi",
    data: settings,
  });
});
