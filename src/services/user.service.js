const User = require("../models/user.model");
const Role = require("../models/role.model");
const Class = require("../models/class.model");
const TgUser = require("../models/tguser.model");
const Premium = require("../models/premium.model");
const {
  NotFoundError,
  ForbiddenError,
  BadRequestError,
} = require("../utils/errors");
const logger = require("../utils/logger");
const {
  recalculateCurrentWeekForStudent,
} = require("./weeklystats.service");

async function getStats() {
  const [telegramUsers, workers, students, premiumUsers] = await Promise.all([
    TgUser.countDocuments(),
    User.countDocuments({ role: { $nin: ["owner", "student"] } }),
    User.countDocuments({ role: "student", isArchived: { $ne: true } }),
    Premium.countDocuments({ status: "active" }),
  ]);

  return { telegramUsers, workers, students, premiumUsers };
}

/**
 * Barcha foydalanuvchilarni sahifalangan holda olish.
 * @param {object} query - { role, class, page, limit, search }
 * @returns {Promise<{users: Array, pagination: object}>}
 */
async function getAllUsers(query) {
  const { role, class: classId, page = 1, limit = 24, search, archived } = query;

  const filter = {};
  if (role) filter.role = role;
  if (classId) filter.classes = classId;

  // Arxivlangan tab faqat arxivlanganlarni, Asosiy tab esa qolganlarni ko'rsatadi
  if (archived === "true" || archived === true) {
    filter.isArchived = true;
  } else {
    filter.isArchived = { $ne: true };
  }

  if (search && search.trim()) {
    const searchRegex = new RegExp(search.trim(), "i");
    filter.$or = [
      { firstName: searchRegex },
      { lastName: searchRegex },
      { username: searchRegex },
    ];
  }

  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  const skip = (pageNum - 1) * limitNum;

  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter)
      .populate("classes", "name")
      .select("-password")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum),
  ]);

  // Har bir foydalanuvchi uchun effektiv default ish vaqti (rol → user merosi).
  // Rollar bir marta yuklanadi - N+1 so'rov yo'q.
  const roles = await Role.find().select("value workStartTime workEndTime").lean();
  const roleMap = {};
  roles.forEach((r) => {
    roleMap[r.value] = r;
  });

  const usersWithSchedule = users.map((u) => {
    const obj = u.toObject({ virtuals: true });
    if (u.role === "student" || u.role === "owner") {
      obj.effectiveSchedule = null;
    } else {
      const role = roleMap[u.role];
      const hasUserOverride = u.workStartTime && u.workEndTime;
      obj.effectiveSchedule = {
        workStartTime: hasUserOverride
          ? u.workStartTime
          : role?.workStartTime || null,
        workEndTime: hasUserOverride
          ? u.workEndTime
          : role?.workEndTime || null,
        source: hasUserOverride ? "user" : "role",
      };
    }
    return obj;
  });

  const totalPages = Math.ceil(total / limitNum);

  return {
    users: usersWithSchedule,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1,
    },
  };
}

/**
 * Yangi foydalanuvchi yaratish.
 * @param {object} data - { username, password, firstName, lastName, role, gender, classes }
 * @returns {Promise<object>} yaratilgan foydalanuvchi
 */
async function createUser(data) {
  const {
    username,
    password,
    firstName,
    lastName,
    role,
    gender,
    classes: userClasses,
    workStartTime,
    workEndTime,
    workDays,
    weeklySchedule,
  } = data;

  if (!username || !password || !firstName || !lastName || !role) {
    throw new BadRequestError("Barcha majburiy maydonlarni to'ldiring");
  }

  if (role === "owner") {
    throw new BadRequestError("Owner rolini yaratish mumkin emas");
  }

  const roleExists = await Role.findOne({ value: role });
  if (!roleExists) {
    throw new BadRequestError("Noto'g'ri rol");
  }

  if (role === "student" && userClasses && userClasses.length > 0) {
    for (const classId of userClasses) {
      const classExists = await Class.findById(classId);
      if (!classExists) {
        throw new BadRequestError(`Sinf topilmadi: ${classId}`);
      }
    }
  }

  const user = await User.create({
    username: username.toLowerCase(),
    password,
    firstName,
    lastName,
    role,
    gender: gender || null,
    classes: role === "student" ? userClasses : [],
    ...(role !== "student" && {
      workStartTime: workStartTime || null,
      workEndTime: workEndTime || null,
      workDays: workDays || undefined,
      weeklySchedule: weeklySchedule || {},
    }),
  });

  return User.findById(user._id)
    .populate("classes", "name")
    .select("-password");
}

/**
 * Foydalanuvchini yangilash.
 * @param {string} id - foydalanuvchi ID
 * @param {object} data - { firstName, lastName, gender, classes, isActive }
 * @returns {Promise<object>} yangilangan foydalanuvchi
 */
async function updateUser(id, data) {
  const {
    firstName,
    lastName,
    gender,
    classes: userClasses,
    isActive,
    workStartTime,
    workEndTime,
    workDays,
    weeklySchedule,
  } = data;

  const user = await User.findById(id);
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (user.role === "owner") {
    throw new ForbiddenError(
      "Egasi foydalanuvchisini o'zgartirish mumkin emas",
    );
  }

  if (firstName) user.firstName = firstName;
  if (lastName) user.lastName = lastName;
  if (isActive !== undefined) user.isActive = isActive;
  if (gender !== undefined) user.gender = gender || null;

  // Ish jadvali override (davomat uchun)
  if (user.role !== "student") {
    if (workStartTime !== undefined) user.workStartTime = workStartTime || null;
    if (workEndTime !== undefined) user.workEndTime = workEndTime || null;
    if (workDays !== undefined) user.workDays = workDays || [];
    if (weeklySchedule !== undefined) user.weeklySchedule = weeklySchedule || {};
  }

  let classesChanged = false;
  if (user.role === "student" && userClasses) {
    if (user.isArchived && userClasses.length > 0) {
      throw new BadRequestError(
        "Arxivlangan o'quvchiga sinf biriktirish mumkin emas",
      );
    }
    for (const classId of userClasses) {
      const classExists = await Class.findById(classId);
      if (!classExists) {
        throw new BadRequestError(`Sinf topilmadi: ${classId}`);
      }
    }

    // Sinf haqiqatan o'zgardimi - aniqlaymiz (keraksiz qayta hisoblashning oldini olish uchun)
    const prevClasses = user.classes.map((c) => c.toString()).sort();
    const nextClasses = userClasses.map((c) => c.toString()).sort();
    classesChanged =
      prevClasses.length !== nextClasses.length ||
      prevClasses.some((c, i) => c !== nextClasses[i]);

    user.classes = userClasses;
  }

  await user.save();

  // Sinf o'zgargan bo'lsa, joriy hafta statistikasini darhol qayta hisoblaymiz.
  // Aks holda statistika faqat keyingi baho hodisasida yangilanardi.
  // Statistika xatosi foydalanuvchi yangilanishini buzmasligi kerak.
  if (classesChanged) {
    try {
      await recalculateCurrentWeekForStudent(user._id);
    } catch (error) {
      logger.error(
        "Sinf o'zgarganda haftalik statistikani yangilashda xato:",
        error,
      );
    }
  }

  return User.findById(user._id)
    .populate("classes", "name")
    .select("-password");
}

/**
 * Foydalanuvchi parolini tiklash.
 * @param {string} id - foydalanuvchi ID
 * @param {string} newPassword - yangi parol
 * @returns {Promise<void>}
 */
async function resetPassword(id, newPassword) {
  if (!newPassword) {
    throw new BadRequestError("Yangi parol majburiy");
  }

  const user = await User.findById(id);
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (user.role === "owner") {
    throw new ForbiddenError(
      "Egasi foydalanuvchisi parolini tiklash mumkin emas",
    );
  }

  user.password = newPassword;
  await user.save();
}

/**
 * Foydalanuvchi parolini olish (plainPassword).
 * @param {string} id - foydalanuvchi ID
 * @returns {Promise<string>} parol
 */
async function getUserPassword(id) {
  const user = await User.findById(id).select("+plainPassword");
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  return user.plainPassword || "Hisob eski, parolni ko'rsatib bo'lmaydi";
}

/**
 * Foydalanuvchini o'chirish.
 * @param {string} id - foydalanuvchi ID
 * @returns {Promise<void>}
 */
async function deleteUser(id) {
  const user = await User.findById(id);
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (user.role === "owner") {
    throw new ForbiddenError("Egasi foydalanuvchisini o'chirish mumkin emas");
  }

  if (user.role === "student") {
    throw new BadRequestError(
      "O'quvchini o'chirib bo'lmaydi. Uning o'rniga arxivlang",
    );
  }

  await user.deleteOne();
}

/**
 * O'quvchini arxivlash (yumshoq o'chirish).
 * Ixtiyoriy ravishda Tangalar va/yoki Jarimalarni 0 ga tushiradi.
 * Asl qiymatlar har ehtimolga qarshi archiveSnapshot da saqlanadi.
 * @param {string} id - o'quvchi ID
 * @param {{ resetCoins?: boolean, resetPenalties?: boolean }} options
 * @returns {Promise<object>} arxivlangan o'quvchi
 */
async function archiveStudent(id, options = {}) {
  const { resetCoins = false, resetPenalties = false } = options;

  const user = await User.findById(id);
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (user.role !== "student") {
    throw new BadRequestError("Faqat o'quvchini arxivlash mumkin");
  }

  if (user.isArchived) {
    throw new BadRequestError("O'quvchi allaqachon arxivlangan");
  }

  // 0lashtirishdan oldingi asl qiymatlarni saqlab qo'yamiz
  user.archiveSnapshot = {
    coinBalance: user.coinBalance,
    penaltyPoints: user.penaltyPoints,
  };

  if (resetCoins) user.coinBalance = 0;
  if (resetPenalties) user.penaltyPoints = 0;

  // Arxivlangan o'quvchi barcha sinflardan avtomatik chiqariladi
  user.classes = [];

  user.isArchived = true;
  user.archivedAt = new Date();

  await user.save();

  return User.findById(user._id)
    .populate("classes", "name")
    .select("-password");
}

/**
 * Arxivlangan o'quvchini qaytarish.
 * Balanslar o'zgartirilmaydi (0 holatda qoladi), archiveSnapshot saqlanib qoladi.
 * @param {string} id - o'quvchi ID
 * @returns {Promise<object>} qaytarilgan o'quvchi
 */
async function restoreStudent(id) {
  const user = await User.findById(id);
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (!user.isArchived) {
    throw new BadRequestError("O'quvchi arxivlanmagan");
  }

  user.isArchived = false;
  user.archivedAt = null;

  await user.save();

  return User.findById(user._id)
    .populate("classes", "name")
    .select("-password");
}

/**
 * Excel eksport uchun foydalanuvchilar ma'lumotlarini tayyorlash.
 * @param {string} [role] - rol bo'yicha filtr (ixtiyoriy)
 * @returns {Promise<Array>} formatlangan foydalanuvchilar ro'yxati
 */
async function getUsersForExport(role) {
  const query = {};
  if (role) {
    query.role = role;
  } else {
    query.role = { $ne: "owner" };
  }

  const users = await User.find(query)
    .populate("classes", "name")
    .select("+plainPassword")
    .sort({ role: 1, firstName: 1 });

  const allRoles = await Role.find().lean();
  const roleMap = {};
  allRoles.forEach((r) => {
    roleMap[r.value] = r.name;
  });

  return users.map((user) => ({
    fullName: `${user.firstName} ${user.lastName || ""}`.trim(),
    username: user.username,
    password: user.plainPassword || "N/A",
    role: roleMap[user.role] || user.role,
    classes:
      user.classes && user.classes.length > 0
        ? user.classes.map((c) => c.name).join(", ")
        : "-",
  }));
}

/**
 * Barcha faol foydalanuvchilarning qisqa ro'yxatini olish (owner bundan mustasno).
 * @returns {Promise<Array>}
 */
async function getAllUsersShort() {
  return User.find({
    isActive: true,
    isArchived: { $ne: true },
    role: { $ne: "owner" },
  })
    .select("firstName lastName role")
    .sort({ role: 1, firstName: 1 })
    .lean();
}

/**
 * Talabalar ro'yxatini olish (qidiruv bilan).
 * @param {object} query - { search, limit }
 * @returns {Promise<Array>} talabalar ro'yxati
 */
async function getStudents(query) {
  const { search, limit = 500 } = query;

  const filter = { role: "student", isArchived: { $ne: true } };

  if (search && search.trim()) {
    const searchRegex = new RegExp(search.trim(), "i");
    filter.$or = [
      { firstName: searchRegex },
      { lastName: searchRegex },
      { username: searchRegex },
    ];
  }

  return User.find(filter)
    .select("firstName lastName username classes penaltyPoints")
    .populate("classes", "name")
    .sort({ firstName: 1 })
    .limit(parseInt(limit, 10));
}

/**
 * Foydalanuvchining o'z profilini yangilash (faqat firstName va lastName).
 * @param {string} userId - Foydalanuvchi ID si
 * @param {{firstName?: string, lastName?: string}} data - Yangilanadigan ma'lumotlar
 * @returns {Promise<import('../models/user.model')>}
 */
async function updateSelfProfile(userId, data) {
  const { firstName, lastName, username, currentPassword, newPassword } = data;

  const user = await User.findById(userId);
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (firstName !== undefined) user.firstName = firstName;
  if (lastName !== undefined) user.lastName = lastName;

  // Username o'zgartirish - unikallik tekshiruvi bilan
  if (username !== undefined) {
    const normalizedUsername = String(username).toLowerCase().trim();
    if (normalizedUsername !== user.username) {
      const usernameTaken = await User.findOne({
        username: normalizedUsername,
        _id: { $ne: user._id },
      });
      if (usernameTaken) {
        throw new BadRequestError("Bu username allaqachon band");
      }
      user.username = normalizedUsername;
    }
  }

  // Parol o'zgartirish - joriy parolni tasdiqlash talab qilinadi
  if (newPassword) {
    if (!currentPassword) {
      throw new BadRequestError("Joriy parolni kiriting");
    }

    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      throw new BadRequestError("Joriy parol noto'g'ri");
    }

    user.password = newPassword;
  }

  await user.save();

  return User.findById(user._id).select("-password");
}

module.exports = {
  getStats,
  getAllUsers,
  createUser,
  updateUser,
  resetPassword,
  getUserPassword,
  deleteUser,
  archiveStudent,
  restoreStudent,
  getUsersForExport,
  getAllUsersShort,
  getStudents,
  updateSelfProfile,
};
