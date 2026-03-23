const User = require("../models/user.model");
const { generateToken } = require("../utils/jwt");
const { BadRequestError, ForbiddenError } = require("../utils/errors");

/**
 * Foydalanuvchini login qilish.
 * @param {string} username - foydalanuvchi nomi
 * @param {string} password - parol
 * @returns {Promise<{user: object, token: string}>} foydalanuvchi va token
 */
async function login(username, password) {
  if (!username || !password) {
    throw new BadRequestError("Username va parol majburiy");
  }

  const user = await User.findOne({
    username: username.toLowerCase(),
  }).populate("classes", "name");

  if (!user || !(await user.matchPassword(password))) {
    throw new BadRequestError("Username yoki parol noto'g'ri");
  }

  if (!user.isActive) {
    throw new ForbiddenError("Sizning hisobingiz faol emas");
  }

  const token = generateToken(user._id);

  return {
    user: {
      id: user._id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: user.fullName,
      role: user.role,
      classes: user.classes,
    },
    token,
  };
}

/**
 * Joriy foydalanuvchi ma'lumotlarini olish.
 * @param {string} userId - foydalanuvchi ID
 * @returns {Promise<object>} foydalanuvchi ma'lumotlari
 */
async function getMe(userId) {
  const user = await User.findById(userId).populate("classes", "name");
  return user;
}

module.exports = { login, getMe };
