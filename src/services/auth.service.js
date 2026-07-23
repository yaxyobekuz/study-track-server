const prisma = require("../config/prisma");
const { generateToken } = require("../utils/jwt");
const { matchPassword } = require("../utils/password");
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

  const user = await prisma.user.findUnique({
    where: { username: username.toLowerCase() },
    include: { classes: { include: { class: { select: { id: true, name: true } } } } },
  });

  if (!user || !(await matchPassword(password, user.password))) {
    throw new BadRequestError("Username yoki parol noto'g'ri");
  }

  if (!user.isActive) {
    throw new ForbiddenError("Sizning hisobingiz faol emas");
  }

  if (user.isArchived) {
    throw new ForbiddenError("Sizning hisobingiz arxivlangan");
  }

  const token = generateToken(user.id);

  return {
    user: {
      id: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: user.fullName,
      role: user.role,
      classes: user.classes.map((uc) => uc.class),
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
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      classes: { include: { class: { select: { id: true, name: true } } } },
      profileImage: true,
    },
  });

  if (!user) return null;

  return {
    ...user,
    classes: user.classes.map((uc) => uc.class),
    profilePicture: user.profileImage || null,
  };
}

module.exports = { login, getMe };
