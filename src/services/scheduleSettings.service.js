const ScheduleSettings = require("../models/scheduleSettings.model");
const { BadRequestError } = require("../utils/errors");

const TIME_REGEX = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * Dars jadvali uchun global standart vaqt sozlamalarini qaytaradi (singleton).
 * @returns {Promise<object>}
 */
async function getSettings() {
  return ScheduleSettings.getSettings();
}

/**
 * Dars soatlari uchun standart vaqt sozlamalarini yangilaydi.
 * Yuborilgan `periods` ro'yxati to'liq almashtiradi (replace).
 * @param {object} data - { periods: [{ order, startTime, endTime }] }
 * @param {string} userId - yangilagan foydalanuvchi
 * @returns {Promise<object>}
 */
async function updateSettings(data, userId) {
  const { periods } = data;

  if (!Array.isArray(periods)) {
    throw new BadRequestError("periods massiv bo'lishi kerak");
  }

  const seenOrders = new Set();

  const normalized = periods.map((item, index) => {
    const order = Number(item.order);
    const { startTime, endTime } = item;

    if (!Number.isInteger(order) || order < 1 || order > 100) {
      throw new BadRequestError(
        `Dars tartibi 1 dan 100 gacha butun son bo'lishi kerak (${index + 1}-qator)`,
      );
    }

    if (seenOrders.has(order)) {
      throw new BadRequestError(`Dars tartibi takrorlanmasligi kerak: ${order}`);
    }
    seenOrders.add(order);

    if (!TIME_REGEX.test(startTime) || !TIME_REGEX.test(endTime)) {
      throw new BadRequestError(
        `Vaqt formati noto'g'ri (HH:mm formatida bo'lishi kerak) - ${order}-dars`,
      );
    }

    if (startTime >= endTime) {
      throw new BadRequestError(
        `Boshlanish vaqti tugash vaqtidan oldin bo'lishi kerak - ${order}-dars`,
      );
    }

    return { order, startTime, endTime };
  });

  // Tartib raqami bo'yicha saralab saqlaymiz
  normalized.sort((a, b) => a.order - b.order);

  const settings = await ScheduleSettings.getSettings();
  settings.periods = normalized;
  settings.updatedBy = userId;
  await settings.save();

  return settings;
}

module.exports = { getSettings, updateSettings };
