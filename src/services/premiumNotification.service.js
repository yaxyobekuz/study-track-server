const TgUser = require("../models/tguser.model");
const telegramService = require("./telegram.service");
const logger = require("../utils/logger");
const { config } = require("../config/env.config");

/**
 * Sanani DD.MM.YYYY ko'rinishida formatlaydi.
 * @param {Date|string} date
 * @returns {string}
 */
const formatDate = (date) => {
  if (!date) return "";
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${d.getFullYear()}`;
};

/**
 * Hodisa turi bo'yicha xabar matnini tuzadi.
 * @param {string} eventType - purchased | granted | revoked | expired
 * @param {object} data - { studentName, durationDays, expiresAt }
 * @returns {string|null}
 */
const buildMessage = (eventType, { studentName, durationDays, expiresAt } = {}) => {
  const name = studentName ? `<b>${studentName}</b>` : "O'quvchi";

  switch (eventType) {
    case "purchased":
      return (
        `⭐️ <b>MBSI Premium faollashtirildi!</b>\n\n` +
        `👤 ${name}\n` +
        `🗓 Muddati: <b>${durationDays} kun</b>\n` +
        `⏳ Amal qiladi: <b>${formatDate(expiresAt)}</b> gacha\n\n` +
        `Premium imkoniyatlaridan bahramand bo'ling! ✨`
      );
    case "granted":
      return (
        `🎁 <b>Sizga MBSI Premium hadya qilindi!</b>\n\n` +
        `👤 ${name}\n` +
        `🗓 Muddati: <b>${durationDays} kun</b>\n` +
        `⏳ Amal qiladi: <b>${formatDate(expiresAt)}</b> gacha\n\n` +
        `Tabriklaymiz! ✨`
      );
    case "revoked":
      return (
        `⚠️ <b>MBSI Premium bekor qilindi</b>\n\n` +
        `👤 ${name}\n` +
        `Premium obunangiz administrator tomonidan bekor qilindi.`
      );
    case "expired":
      return (
        `⌛️ <b>MBSI Premium muddati tugadi</b>\n\n` +
        `👤 ${name}\n` +
        `Premium obunangiz muddati yakunlandi. Qaytadan faollashtirishingiz mumkin.`
      );
    default:
      return null;
  }
};

/**
 * O'quvchining barcha faol Telegram foydalanuvchilariga matn yuboradi.
 * @param {string} studentId
 * @param {string} text
 */
const sendToStudent = async (studentId, text) => {
  const tgUsers = await TgUser.find({
    student: studentId,
    isActive: true,
    notificationsEnabled: true,
  });

  for (const tgUser of tgUsers) {
    const result = await telegramService.sendMessage(tgUser.chatId, text);
    if (!result.success) {
      logger.warn(
        `Premium xabarnoma yuborilmadi: chatId=${tgUser.chatId} - ${result.error}`,
      );
    }
    await telegramService.sleep(config.messageRateLimitMs);
  }
};

/**
 * Premium hodisasi yuz berganda o'quvchiga bot orqali xabar yuboradi.
 * Hech qachon xato tashlamaydi (asosiy oqimni to'xtatmaydi).
 * @param {object} user - O'quvchi hujjati (_id, firstName, lastName)
 * @param {string} eventType - purchased | granted | revoked | expired
 * @param {object} [data] - { durationDays, expiresAt }
 * @returns {Promise<void>}
 */
const notifyPremiumEvent = async (user, eventType, data = {}) => {
  try {
    if (!user || !user._id) return;

    const studentName = user.lastName
      ? `${user.firstName} ${user.lastName}`
      : user.firstName;

    const text = buildMessage(eventType, { studentName, ...data });
    if (!text) return;

    await sendToStudent(user._id, text);
  } catch (error) {
    logger.error(`Premium xabarnoma xatosi (${eventType}): ${error.message}`);
  }
};

module.exports = { notifyPremiumEvent };
