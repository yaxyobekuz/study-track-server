const Penalty = require("../models/penalty.model");
const PenaltyCategory = require("../models/penaltyCategory.model");
const PenaltySettings = require("../models/penaltySettings.model");
const User = require("../models/user.model");
const TgUser = require("../models/tguser.model");
const penaltyNotificationQueueService = require("./penaltyNotificationQueue.service");
const {
  uploadPenaltyAttachments,
  deletePenaltyAttachments,
} = require("./file.service");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const logger = require("../utils/logger");

// ─── KATEGORIYA CRUD ───────────────────────────────────────────────

/**
 * Yangi jarima kategoriyasi yaratadi
 * @param {object} data - Kategoriya ma'lumotlari
 * @param {string} createdBy - Yaratuvchi foydalanuvchi IDsi
 * @returns {Promise<Document>} Yaratilgan kategoriya
 */
const createPenaltyCategory = async (data, createdBy) => {
  const category = await PenaltyCategory.create({
    title: data.title,
    description: data.description,
    points: data.points,
    targetRole: data.targetRole,
    createdBy,
  });
  return category;
};

/**
 * Rolga qarab kategoriyalar ro'yxatini qaytaradi
 * @param {string} targetRole - "teacher" yoki "student"
 * @returns {Promise<Array>} Kategoriyalar ro'yxati
 */
const getCategories = async (targetRole) => {
  const filter = { isActive: true };
  if (targetRole) {
    filter.targetRole = targetRole;
  }
  return PenaltyCategory.find(filter).sort({ createdAt: -1 });
};

/**
 * Kategoriyani yangilaydi (avvalgi jarimalar ta'sirlanmaydi)
 * @param {string} id - Kategoriya IDsi
 * @param {object} data - Yangilanadigan maydonlar
 * @returns {Promise<Document>} Yangilangan kategoriya
 */
const updateCategory = async (id, data) => {
  const category = await PenaltyCategory.findByIdAndUpdate(
    id,
    {
      title: data.title,
      description: data.description,
      points: data.points,
    },
    { new: true, runValidators: true },
  );
  if (!category) {
    throw new Error("Kategoriya topilmadi");
  }
  return category;
};

/**
 * Kategoriyani soft delete qiladi (isActive: false)
 * @param {string} id - Kategoriya IDsi
 * @returns {Promise<Document>} O'chirilgan kategoriya
 */
const deleteCategory = async (id) => {
  const category = await PenaltyCategory.findByIdAndUpdate(
    id,
    { isActive: false },
    { new: true },
  );
  if (!category) {
    throw new Error("Kategoriya topilmadi");
  }
  return category;
};

// ─── JARIMA YOZISH ─────────────────────────────────────────────────

/**
 * O'quvchiga bot orqali jarima xabarnomasini yuboradi (background job orqali)
 * @param {Document} user - Jarimaga uchragan foydalanuvchi
 * @param {Document} penalty - Jarima hujjati (title, points, description, attachments)
 * @param {number} totalPoints - Foydalanuvchining jami jarima bali
 */
const sendPenaltyNotification = async (user, penalty, totalPoints) => {
  try {
    if (
      user.role !== "student" ||
      !user.telegramIds ||
      user.telegramIds.length === 0
    ) {
      return;
    }

    const tgUsers = await TgUser.find({
      student: user._id,
      isActive: true,
      notificationsEnabled: true,
    });

    if (tgUsers.length === 0) return;

    const studentName = user.lastName
      ? `${user.firstName} ${user.lastName}`
      : user.firstName;

    let text = `⚠️ <b>Jarima xabarnomasi</b>\n\n`;
    text += `👤 O'quvchi: <b>${studentName}</b>\n`;
    text += `📋 Sabab: <b>${penalty.title}</b>\n`;
    text += `🔴 Ball: <b>${penalty.points}</b>\n`;
    if (penalty.description) {
      text += `📝 Izoh: ${penalty.description}\n`;
    }
    text += `\n📊 Jami jarima bali: <b>${totalPoints}</b>`;

    if (totalPoints >= 12) {
      text += `\n\n🚫 <b>Diqqat!</b> Jarima bali 12 ga yetdi. Profil bloklandi.`;
    } else if (totalPoints > 3) {
      text += `\n\n⚠️ Do'kondan foydalanish cheklangan (jarima bali 3 dan yuqori).`;
    }

    const attachments = (penalty.attachments || []).map((att) => ({
      url: att.url,
      type: att.type,
      originalName: att.originalName,
    }));

    const queueItems = tgUsers.map((tgUser) => ({
      penaltyId: penalty._id,
      telegramId: tgUser.chatId,
      userId: user._id,
      messageText: text,
      attachments,
    }));

    await penaltyNotificationQueueService.addBulkToQueue(queueItems);
  } catch (error) {
    logger.error(`Jarima xabarnomasi yuborishda xato: ${error.message}`);
  }
};

/**
 * Yangi jarima yaratadi
 * @param {object} params - Jarima parametrlari
 * @param {string} params.userId - Jarima oluvchi foydalanuvchi IDsi
 * @param {string} params.categoryId - Kategoriya IDsi (ixtiyoriy)
 * @param {string} params.title - Sarlavha
 * @param {string} params.description - Izoh
 * @param {number} params.points - Ball
 * @param {string} params.givenBy - Jarima yozuvchi IDsi
 * @param {string} params.givenByRole - Jarima yozuvchi roli
 * @param {boolean} params.isCustom - Custom jarima yoki yo'q
 * @param {Array} params.files - Multer fayl massivi (ixtiyoriy)
 * @returns {Promise<Document>} Yaratilgan jarima
 */
const createPenalty = async ({
  userId,
  categoryId,
  title,
  description,
  points,
  givenBy,
  givenByRole,
  isCustom,
  files,
}) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new Error("Foydalanuvchi topilmadi");
  }

  // O'qituvchi faqat o'quvchiga jarima yozishi mumkin
  if (givenByRole === "teacher" && user.role !== "student") {
    throw new Error("O'qituvchi faqat o'quvchiga jarima yozishi mumkin");
  }

  // Owner o'qituvchi va o'quvchiga jarima yozishi mumkin
  if (givenByRole === "owner" && user.role === "owner") {
    throw new Error("Ownerga jarima yozib bo'lmaydi");
  }

  // O'qituvchi faqat kategoriya bo'yicha jarima yoza oladi
  if (givenByRole === "teacher" && isCustom) {
    throw new Error("O'qituvchi faqat kategoriya bo'yicha jarima yoza oladi");
  }

  // Kategoriya bo'lsa, undan ma'lumot olish
  let categoryData = null;
  if (categoryId && !isCustom) {
    categoryData = await PenaltyCategory.findById(categoryId);
    if (!categoryData) {
      throw new Error("Kategoriya topilmadi");
    }
  }

  // PenaltySettings dan joriy jarima miqdorini olish (snapshot)
  const settings = await PenaltySettings.getSettings();
  const fineAmount = settings.fineAmounts?.get(user.role) || 0;

  // Fayllarni yuklash
  const attachments = await uploadPenaltyAttachments(files);

  // Owner yozgan jarima darhol approved
  const status = givenByRole === "owner" ? "approved" : "pending";

  const penalty = await Penalty.create({
    user: userId,
    givenBy,
    category: categoryId || null,
    title: isCustom ? title : categoryData?.title || title,
    description: description || categoryData?.description,
    points: isCustom ? points : categoryData?.points || points,
    status,
    isCustom: !!isCustom,
    fineAmount,
    attachments,
    reviewedBy: status === "approved" ? givenBy : undefined,
    reviewedAt: status === "approved" ? new Date() : undefined,
  });

  // Agar darhol approved bo'lsa — penaltyPoints oshirish
  if (status === "approved") {
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $inc: { penaltyPoints: penalty.points } },
      { new: true },
    );

    // Bot xabarnoma yuborish (background job orqali)
    sendPenaltyNotification(updatedUser, penalty, updatedUser.penaltyPoints);
  }

  return penalty;
};

// ─── JARIMA TASDIQLASH / RAD ETISH ─────────────────────────────────

/**
 * Jarimani tasdiqlash yoki rad etish (faqat owner)
 * @param {string} penaltyId - Jarima IDsi
 * @param {object} params - Tasdiqlash parametrlari
 * @param {string} params.status - "approved" yoki "rejected"
 * @param {string} params.rejectionReason - Rad etish sababi (rejected uchun)
 * @param {string} params.reviewedBy - Tasdiqlagan owner IDsi
 * @returns {Promise<Document>} Yangilangan jarima
 */
const reviewPenalty = async (
  penaltyId,
  { status, rejectionReason, reviewedBy },
) => {
  const penalty = await Penalty.findById(penaltyId);
  if (!penalty) {
    throw new Error("Jarima topilmadi");
  }

  if (penalty.status !== "pending") {
    throw new Error(
      "Faqat kutilayotgan holatdagi jarimani tasdiqlash yoki rad etish mumkin",
    );
  }

  if (status === "rejected" && !rejectionReason) {
    throw new Error("Rad etish sababi majburiy");
  }

  penalty.status = status;
  penalty.reviewedBy = reviewedBy;
  penalty.reviewedAt = new Date();

  if (status === "rejected") {
    penalty.rejectionReason = rejectionReason;
  }

  await penalty.save();

  // Approved bo'lsa — penaltyPoints o'zgartirish (tur bo'yicha)
  if (status === "approved") {
    const inc = penalty.type === "reduction" ? -penalty.points : penalty.points;
    const updatedUser = await User.findByIdAndUpdate(
      penalty.user,
      { $inc: { penaltyPoints: inc } },
      { new: true },
    );

    // Bot xabarnoma faqat oddiy jarima uchun (background job orqali)
    if (penalty.type === "penalty") {
      sendPenaltyNotification(updatedUser, penalty, updatedUser.penaltyPoints);
    }
  }

  return penalty;
};

// ─── JARIMA KAMAYTIRISH ────────────────────────────────────────────

/**
 * Jarima balini kamaytirish so'rovini yaratadi (owner tasdiqlashini kutadi)
 * @param {object} params - Kamaytirish parametrlari
 * @param {string} params.userId - Foydalanuvchi IDsi
 * @param {number} params.points - Kamaytirilayotgan ball
 * @param {string} params.reason - Kamaytirish sababi
 * @param {string} params.reducedBy - So'rov yuborgan owner IDsi
 * @returns {Promise<Document>} Yaratilgan Penalty (type: "reduction")
 */
const reducePenalty = async ({
  userId,
  points,
  reason,
  reducedBy,
  reducedByRole,
}) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new Error("Foydalanuvchi topilmadi");
  }

  if (points < 1) {
    throw new Error("Kamaytirilayotgan ball kamida 1 bo'lishi kerak");
  }

  if (points > user.penaltyPoints) {
    throw new Error(
      `Kamaytirilayotgan ball foydalanuvchida mavjud balldan (${user.penaltyPoints}) ko'p bo'lishi mumkin emas`,
    );
  }

  const settings = await PenaltySettings.getSettings();
  const fineAmount = settings.fineAmounts?.get(user.role) || 0;

  // Owner tomonidan yaratilgan kamaytirish darhol tasdiqlanadi
  const status = reducedByRole === "owner" ? "approved" : "pending";

  const reduction = await Penalty.create({
    type: "reduction",
    user: userId,
    givenBy: reducedBy,
    description: reason,
    points,
    status,
    isCustom: false,
    fineAmount,
    reviewedBy: status === "approved" ? reducedBy : undefined,
    reviewedAt: status === "approved" ? new Date() : undefined,
  });

  // Agar darhol approved bo'lsa — penaltyPoints kamaytirish
  if (status === "approved") {
    await User.findByIdAndUpdate(userId, { $inc: { penaltyPoints: -points } });
  }

  return reduction;
};

// ─── RO'YXATLAR ────────────────────────────────────────────────────

/**
 * Barcha jarimalar ro'yxatini qaytaradi (filtrlash bilan)
 * @param {object} req - Express request (query: status, startDate, endDate, page, limit)
 * @returns {Promise<object>} Formatlanganpaginated response
 */
const getPenalties = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { status, startDate, endDate } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = end;
    }
  }

  const [penalties, total] = await Promise.all([
    Penalty.find(filter)
      .populate("user", "firstName lastName role username penaltyPoints")
      .populate("givenBy", "firstName lastName role")
      .populate("reviewedBy", "firstName lastName")
      .populate("category", "title points")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Penalty.countDocuments(filter),
  ]);

  return formatPaginationResponse(penalties, total, page, limit);
};

/**
 * Pending holatdagi jarimalar ro'yxati
 * @param {object} req - Express request
 * @returns {Promise<object>} Formatlanganpaginated response
 */
const getPendingPenalties = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);

  const filter = { status: "pending" };

  const [penalties, total] = await Promise.all([
    Penalty.find(filter)
      .populate("user", "firstName lastName role username")
      .populate("givenBy", "firstName lastName role")
      .populate("category", "title points")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Penalty.countDocuments(filter),
  ]);

  return formatPaginationResponse(penalties, total, page, limit);
};

/**
 * Bitta foydalanuvchining jarimalari
 * @param {string} userId - Foydalanuvchi IDsi
 * @param {object} req - Express request
 * @returns {Promise<object>} Formatlanganpaginated response
 */
const getUserPenalties = async (userId, req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { status } = req.query;

  const filter = { user: userId, type: "penalty" };
  if (status) filter.status = status;

  const [penalties, total] = await Promise.all([
    Penalty.find(filter)
      .populate("givenBy", "firstName lastName role")
      .populate("reviewedBy", "firstName lastName")
      .populate("category", "title points")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Penalty.countDocuments(filter),
  ]);

  return formatPaginationResponse(penalties, total, page, limit);
};

/**
 * O'z jarimalari (student/teacher panel uchun)
 * @param {string} userId - Foydalanuvchi IDsi
 * @param {object} req - Express request
 * @returns {Promise<object>} Formatlanganpaginated response
 */
const getMyPenalties = async (userId, req) => {
  const { page, limit, skip } = getPaginationParams(req);

  const filter = { user: userId };

  const [penalties, total] = await Promise.all([
    Penalty.find(filter)
      .populate("givenBy", "firstName lastName role")
      .populate("category", "title points")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Penalty.countDocuments(filter),
  ]);

  return formatPaginationResponse(penalties, total, page, limit);
};

/**
 * Ustoz bergan jarimalar ro'yxati (teacher panel uchun)
 * @param {string} givenById - Ustoz IDsi
 * @param {object} req - Express request
 * @returns {Promise<object>} Formatlanganpaginated response
 */
const getGivenPenalties = async (givenById, req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { status } = req.query;

  const filter = { givenBy: givenById, type: { $ne: "reduction" } };
  if (status) filter.status = status;

  const [penalties, total] = await Promise.all([
    Penalty.find(filter)
      .populate("user", "firstName lastName role username")
      .populate("category", "title points")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Penalty.countDocuments(filter),
  ]);

  return formatPaginationResponse(penalties, total, page, limit);
};

/**
 * Bitta jarima tafsiloti
 * @param {string} id - Jarima IDsi
 * @returns {Promise<Document>} Jarima hujjati
 */
const getPenaltyById = async (id) => {
  const penalty = await Penalty.findById(id)
    .populate("user", "firstName lastName role username penaltyPoints")
    .populate("givenBy", "firstName lastName role")
    .populate("reviewedBy", "firstName lastName")
    .populate("category", "title description points");

  if (!penalty) {
    throw new Error("Jarima topilmadi");
  }

  return penalty;
};

/**
 * Kamaytirish tarixi
 * @param {object} req - Express request (query: userId)
 * @returns {Promise<object>} Formatlanganpaginated response
 */
const getReductions = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { userId } = req.query;

  const filter = { type: "reduction" };
  if (userId) filter.user = userId;

  const [reductions, total] = await Promise.all([
    Penalty.find(filter)
      .populate("user", "firstName lastName role username")
      .populate("givenBy", "firstName lastName")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Penalty.countDocuments(filter),
  ]);

  return formatPaginationResponse(reductions, total, page, limit);
};

// ─── STATISTIKA ────────────────────────────────────────────────────

/**
 * Jarima statistikasi: umumiy ball, kamaytirilgan ball, top 10 o'quvchi, top 10 o'qituvchi
 * @returns {Promise<object>} Statistika ob'yekti
 */
const getPenaltyStats = async () => {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
  thirtyDaysAgo.setHours(0, 0, 0, 0);

  const [
    totalApprovedPoints,
    totalReducedPoints,
    topUsers,
    topStudents,
    pendingCount,
    dailyPenalties,
    dailyReductions,
  ] = await Promise.all([
    Penalty.aggregate([
      { $match: { type: "penalty", status: "approved" } },
      { $group: { _id: null, total: { $sum: "$points" } } },
    ]),
    Penalty.aggregate([
      { $match: { type: "reduction", status: "approved" } },
      { $group: { _id: null, total: { $sum: "$points" } } },
    ]),
    User.find({ role: { $nin: ["owner", "student"] }, penaltyPoints: { $gt: 0 } })
      .select("firstName lastName username penaltyPoints role")
      .sort({ penaltyPoints: -1 })
      .limit(10),
    User.find({ role: "student", penaltyPoints: { $gt: 0 } })
      .select("firstName lastName username penaltyPoints role")
      .sort({ penaltyPoints: -1 })
      .limit(10),
    Penalty.countDocuments({ status: "pending" }),
    Penalty.aggregate([
      {
        $match: {
          type: "penalty",
          status: "approved",
          createdAt: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
            day: { $dayOfMonth: "$createdAt" },
          },
          points: { $sum: "$points" },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]),
    Penalty.aggregate([
      {
        $match: {
          type: "reduction",
          status: "approved",
          createdAt: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
            day: { $dayOfMonth: "$createdAt" },
          },
          points: { $sum: "$points" },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]),
  ]);

  // So'nggi 30 kun uchun to'liq kunlik massiv hosil qilish
  const dailyTrend = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(thirtyDaysAgo);
    d.setDate(d.getDate() + i);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const day = d.getDate();

    const penaltyEntry = dailyPenalties.find(
      (e) => e._id.year === year && e._id.month === month && e._id.day === day,
    );
    const reductionEntry = dailyReductions.find(
      (e) => e._id.year === year && e._id.month === month && e._id.day === day,
    );

    dailyTrend.push({
      date: d.toISOString().split("T")[0],
      penaltyPoints: penaltyEntry?.points || 0,
      reductionPoints: reductionEntry?.points || 0,
    });
  }

  return {
    totalApprovedPoints: totalApprovedPoints[0]?.total || 0,
    totalReducedPoints: totalReducedPoints[0]?.total || 0,
    topUsers,
    topStudents,
    pendingCount,
    dailyTrend,
  };
};

// ─── SOZLAMALAR ────────────────────────────────────────────────────

/**
 * Jarima sozlamalarini olish
 * @returns {Promise<Document>} PenaltySettings
 */
const getSettings = async () => {
  return PenaltySettings.getSettings();
};

/**
 * Jarima sozlamalarini yangilash
 * @param {object} data - Yangilanadigan maydonlar
 * @param {object} data.fineAmounts - Har bir rol uchun jarima miqdori ({ student: N, teacher: N, ... })
 * @param {string} updatedBy - Yangilovchi foydalanuvchi IDsi
 * @returns {Promise<Document>} Yangilangan PenaltySettings
 */
const updateSettings = async (data, updatedBy) => {
  const settings = await PenaltySettings.getSettings();

  // Yangi format: fineAmounts object
  if (data.fineAmounts && typeof data.fineAmounts === "object") {
    for (const [role, amount] of Object.entries(data.fineAmounts)) {
      settings.fineAmounts.set(role, Number(amount));
    }
  }

  // Backward compat: eski format ham qabul qilinadi
  if (data.studentFineAmount !== undefined) {
    settings.studentFineAmount = data.studentFineAmount;
    settings.fineAmounts.set("student", data.studentFineAmount);
  }
  if (data.teacherFineAmount !== undefined) {
    settings.teacherFineAmount = data.teacherFineAmount;
    settings.fineAmounts.set("teacher", data.teacherFineAmount);
  }

  settings.updatedBy = updatedBy;
  await settings.save();
  return settings;
};

module.exports = {
  createPenaltyCategory,
  getCategories,
  updateCategory,
  deleteCategory,
  createPenalty,
  reviewPenalty,
  reducePenalty,
  getPenalties,
  getPendingPenalties,
  getUserPenalties,
  getMyPenalties,
  getGivenPenalties,
  getPenaltyById,
  getReductions,
  getPenaltyStats,
  getSettings,
  updateSettings,
};
