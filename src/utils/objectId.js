/**
 * ObjectId yordamchilari (Mongoose'siz).
 *
 * Prisma'da ID'lar oddiy 24-belgili hex string. `mongoose.isValidObjectId` va
 * `new mongoose.Types.ObjectId(x)` o'rnini bosadi.
 */

const OBJECT_ID_REGEX = /^[a-fA-F0-9]{24}$/;

/**
 * 24-belgili hex ID formatini tekshiradi.
 * @param {*} id
 * @returns {boolean}
 */
function isValidId(id) {
  return typeof id === "string" && OBJECT_ID_REGEX.test(id);
}

module.exports = { isValidId, OBJECT_ID_REGEX };
