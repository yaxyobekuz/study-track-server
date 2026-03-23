const jwt = require("jsonwebtoken");
const { config } = require("../config/env.config");

/**
 * JWT token yaratish
 * @param {string} userId - Foydalanuvchi ID
 * @returns {string} JWT token
 */
const generateToken = (userId) => {
  return jwt.sign({ id: userId }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
};

/**
 * JWT token tekshirish
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
