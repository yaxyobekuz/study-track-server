/**
 * Parol yordamchilari (bcrypt).
 *
 * Mongoose User modelidagi `pre("save")` hash hook va `matchPassword` method
 * o'rnini bosadi — endi service qatlamida ishlatiladi.
 */

const bcrypt = require("bcrypt");

/**
 * Parolni hash qiladi (salt rounds = 10, Mongoose bilan bir xil).
 * @param {string} plain
 * @returns {Promise<string>}
 */
async function hashPassword(plain) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plain, salt);
}

/**
 * Kiritilgan parolni hash bilan solishtiradi.
 * @param {string} plain
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
async function matchPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

module.exports = { hashPassword, matchPassword };
