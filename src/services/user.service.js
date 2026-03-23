const User = require("../models/user.model");
const Role = require("../models/role.model");
const Class = require("../models/class.model");
const TgUser = require("../models/tguser.model");
const { BadRequestError, NotFoundError, ForbiddenError } = require("../utils/errors");

/**
 * Foydalanuvchilar statistikasini olish.
 * @returns {Promise<{telegramUsers: number, teachers: number, students: number}>}
 */
async function getStats() {
  const [telegramUsers, teachers, students] = await Promise.all([
    TgUser.countDocuments(),
    User.countDocuments({ role: "teacher" }),
    User.countDocuments({ role: "student" }),
  ]);

  return { telegramUsers, teachers, students };
}

/**
 * Barcha foydalanuvchilarni sahifalangan holda olish.
 * @param {object} query - { role, class, page, limit, search }
 * @returns {Promise<{users: Array, pagination: object}>}
 */
async function getAllUsers(query) {
  const { role, class: classId, page = 1, limit = 24, search } = query;

  const filter = {};
  if (role) filter.role = role;
  if (classId) filter.classes = classId;

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

  const totalPages = Math.ceil(total / limitNum);

  return {
    users,
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
  } = data;

  const user = await User.findById(id);
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (user.role === "owner") {
    throw new ForbiddenError("Egasi foydalanuvchisini o'zgartirish mumkin emas");
  }

  if (firstName) user.firstName = firstName;
  if (lastName) user.lastName = lastName;
  if (isActive !== undefined) user.isActive = isActive;
  if (gender !== undefined) user.gender = gender || null;

  if (user.role === "student" && userClasses) {
    for (const classId of userClasses) {
      const classExists = await Class.findById(classId);
      if (!classExists) {
        throw new BadRequestError(`Sinf topilmadi: ${classId}`);
      }
    }
    user.classes = userClasses;
  }

  await user.save();

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
    throw new ForbiddenError("Egasi foydalanuvchisi parolini tiklash mumkin emas");
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

  await user.deleteOne();
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
  return User.find({ isActive: true, role: { $ne: "owner" } })
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

  const filter = { role: "student" };

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

module.exports = {
  getStats,
  getAllUsers,
  createUser,
  updateUser,
  resetPassword,
  getUserPassword,
  deleteUser,
  getUsersForExport,
  getAllUsersShort,
  getStudents,
};
