const jwt = require("jsonwebtoken");
const { config } = require("../config/env.config");

/**
 * JWT token yaratish.
 *
 * Token FILIALGA bog'langan: `branchId` imzolangan yuk ichida turadi, ya'ni
 * uni mijoz tomondan o'zgartirib bo'lmaydi. Filial almashtirish — yangi token
 * olish (`POST /api/auth/switch-branch`), header emas.
 *
 * @param {string} userId - Foydalanuvchi ID (filial schema'sidagi User.id)
 * @param {string} [branchId] - Filial ID (platforma reyestridagi Branch.id)
 * @returns {string} JWT token
 */
const generateToken = (userId, branchId) => {
  return jwt.sign({ id: userId, branchId: branchId ?? null }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
};

/**
 * JWT token tekshirish.
 *
 * Eski (filiallashtirishdan oldingi) tokenlarda `branchId` YO'Q — ular `null`
 * qaytaradi va `auth.middleware` ularni default filialga yo'naltiradi. Shu
 * sababli joriy etish paytida hech kim tizimdan chiqib ketmaydi.
 *
 * @param {string} token - JWT token
 * @returns {object|null} Decoded token yoki null
 */
const verifyToken = (token) => {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (error) {
    return null;
  }
};

module.exports = { generateToken, verifyToken };
