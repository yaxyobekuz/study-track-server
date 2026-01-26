/**
 * Async handler middleware
 *
 * Controller funksiyalaridan keladigan promise'larni catch qiladi
 * va error middleware'ga yo'naltiradi. Bu orqali har bir controller'da
 * try-catch yozishning oldini oladi.
 *
 * @param {Function} fn - Async controller funksiyasi
 * @returns {Function} Express middleware funksiyasi
 *
 * @example
 * const asyncHandler = require('../middleware/async.middleware');
 *
 * const getUsers = asyncHandler(async (req, res) => {
 *   const users = await User.find();
 *   res.json({ success: true, data: users });
 * });
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
