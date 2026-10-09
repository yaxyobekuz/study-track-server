/**
 * MUAMMOGA JAVOB — ma'muriyat yozgan javobni botga qaytaradi.
 *
 * Muammoni bot yaratadi, ko'rib chiqishni esa panel: javob yozilgandan
 * keyin odam uni AYNAN SHU YERDAN oladi, boshqa kanal yo'q.
 *
 * ⚠️ `chatId` MUAMMONING O'ZIDAN olinadi, `tg_users` dan qayta izlanmaydi.
 * Oradan kun o'tgan bo'lishi mumkin: odam bog'lanishni uzgan yoki o'sha
 * telegramga boshqa hisob bog'langan bo'lishi mumkin. Javob MUAMMONI
 * YUBORGAN chatga borishi kerak — hozir u telegramda kim turganiga emas,
 * aks holda birovning shikoyatiga yozilgan javob boshqa odamga ketardi.
 *
 * ⚠️ XATO TASHLAMAYDI. Odam botni bloklagan bo'lsa ham ma'muriyatning
 * qarori bekor qilinmaydi — chaqiruvchi (`issue.service#reviewIssue`)
 * natijaga qarab `repliedAt` ni belgilaydi va panelda "javob yetib
 * bormadi" ko'rinadi.
 */

const logger = require("../utils/logger");
const telegramService = require("./telegram.service");
const { config } = require("../config/env.config");
const { escapeHtml } = require("../helpers/changelogMessage.helpers");
const { formatDateTimeUz } = require("../helpers/date.helpers");

/** Yakuniy holat → xabar sarlavhasi. */
const HEADERS = {
  resolved: "✅ <b>Muammoyingiz hal qilindi</b>",
  rejected: "❌ <b>Muammoyingiz rad etildi</b>",
};

/**
 * Javob xabarining matni.
 *
 * Muammoning O'ZI ham qaytariladi (qisqartirilgan holda): odam bir necha
 * muammo yuborgan bo'lishi mumkin va "hal qilindi" degan quruq xabar
 * qaysi biri haqida ekanini bildirmasdi.
 *
 * @param {object} issue - `issues` qatori (`category` bilan)
 * @returns {string|null}
 */
const buildMessage = (issue) => {
  const header = HEADERS[issue.status];
  if (!header) return null;

  const body =
    issue.body.length > 300 ? `${issue.body.slice(0, 300)}…` : issue.body;

  const lines = [
    header,
    "",
    `🏷 Kategoriya: <b>${escapeHtml(issue.category?.name || "—")}</b>`,
    `📅 Yuborilgan: <b>${escapeHtml(formatDateTimeUz(issue.createdAt))}</b>`,
    "",
    `📝 Murojaatingiz:\n<i>${escapeHtml(body)}</i>`,
    "",
    `💬 <b>Javob:</b>\n${escapeHtml(issue.reply || "")}`,
  ];

  return lines.join("\n");
};

/**
 * Javobni muammo yuborilgan chatga yuboradi.
 *
 * @param {object} issue - `issues` qatori (`category` bilan)
 * @returns {Promise<boolean>} yetib bordimi
 */
const notifyIssueReply = async (issue) => {
  try {
    if (!issue?.chatId) return false;
    if (!config.telegramBotToken) return false;

    const text = buildMessage(issue);
    if (!text) return false;

    const result = await telegramService.sendMessage(issue.chatId, text);
    if (!result?.success) {
      logger.warn(
        `[Issue] Javob yuborilmadi: chatId=${issue.chatId} - ${result?.error || "noma'lum xato"}`,
      );
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[Issue] Javob yuborishda xato: ${error.message}`);
    return false;
  }
};

module.exports = { notifyIssueReply, buildMessage };
