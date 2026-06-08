const TestSettings = require("../models/testSettings.model");
const { BadRequestError } = require("../utils/errors");

/**
 * Global test ball sozlamalarini qaytaradi (singleton).
 * @returns {Promise<object>}
 */
async function getSettings() {
  return TestSettings.getSettings();
}

/**
 * Global test ball sozlamalarini yangilaydi.
 * @param {object} data - { minScore, maxScore }
 * @param {string} userId - yangilagan foydalanuvchi
 * @returns {Promise<object>}
 */
async function updateSettings(data, userId) {
  const settings = await TestSettings.getSettings();

  const min =
    data.minScore !== undefined ? Number(data.minScore) : settings.minScore;
  const max =
    data.maxScore !== undefined ? Number(data.maxScore) : settings.maxScore;

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new BadRequestError("Minimal va maksimal ball son bo'lishi kerak");
  }
  if (min < 0) {
    throw new BadRequestError("Minimal ball manfiy bo'lishi mumkin emas");
  }
  if (max <= min) {
    throw new BadRequestError(
      "Maksimal ball minimal balldan katta bo'lishi kerak",
    );
  }

  settings.minScore = min;
  settings.maxScore = max;
  settings.updatedBy = userId;
  await settings.save();

  return settings;
}

module.exports = { getSettings, updateSettings };
