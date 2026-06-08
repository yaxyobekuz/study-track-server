// Telegram Bot API
const TelegramBot = require("node-telegram-bot-api");

// File System
const fs = require("fs");

// Logger
const logger = require("../utils/logger");
const { config } = require("../config/env.config");

// Initialize bot
const token = config.telegramBotToken;
let bot = null;

if (token) {
  bot = new TelegramBot(token, { polling: false });
  logger.info("Telegram bot initialized");
} else {
  logger.warn("TELEGRAM_BOT_TOKEN not found in environment variables");
}

class TelegramService {
  /**
   * Send text message to telegram user
   * @param {string} telegramId - Telegram user ID
   * @param {string} text - Message text
   * @returns {Promise<Object>} - Telegram API response
   */
  async sendMessage(telegramId, text, replyMarkup = null) {
    if (!bot) {
      throw new Error("Telegram bot not initialized");
    }

    try {
      const options = { parse_mode: "HTML" };
      if (replyMarkup) options.reply_markup = replyMarkup;
      const result = await bot.sendMessage(telegramId, text, options);
      return { success: true, data: result };
    } catch (error) {
      logger.error(`Telegram xabar yuborishda xato: ${error.message}`);
      return {
        success: false,
        error: error.message,
        errorCode: error.response?.body?.error_code,
      };
    }
  }

  /**
   * Fetch remote URL and return its content as a Buffer.
   * @param {string} url - Remote file URL (http or https)
   * @returns {Promise<Buffer>}
   */
  fetchBuffer(url) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith("https") ? require("https") : require("http");
      lib.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(this.fetchBuffer(res.headers.location));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to fetch file: HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }).on("error", reject);
    });
  }

  /**
   * Send photo with caption to telegram user
   * @param {string} telegramId - Telegram user ID
   * @param {string} fileUrl - URL or local path to photo file
   * @param {string} caption - Photo caption
   * @returns {Promise<Object>} - Telegram API response
   */
  async sendPhoto(telegramId, fileUrl, caption) {
    if (!bot) {
      throw new Error("Telegram bot not initialized");
    }

    try {
      const source = fileUrl.startsWith("http")
        ? await this.fetchBuffer(fileUrl)
        : fs.createReadStream(fileUrl);

      const result = await bot.sendPhoto(telegramId, source, {
        caption: caption || "",
        parse_mode: "HTML",
      });
      return { success: true, data: result };
    } catch (error) {
      logger.error(`Telegram rasm yuborishda xato: ${error.message}`);
      return {
        success: false,
        error: error.message,
        errorCode: error.response?.body?.error_code,
      };
    }
  }

  /**
   * Send document with caption to telegram user
   * @param {string} telegramId - Telegram user ID
   * @param {string} fileUrl - URL or local path to document file
   * @param {string} caption - Document caption
   * @param {string} fileName - Original file name (shown in Telegram)
   * @returns {Promise<Object>} - Telegram API response
   */
  async sendDocument(telegramId, fileUrl, caption, fileName, contentType) {
    if (!bot) {
      throw new Error("Telegram bot not initialized");
    }

    try {
      const source = fileUrl.startsWith("http")
        ? await this.fetchBuffer(fileUrl)
        : fs.createReadStream(fileUrl);

      const result = await bot.sendDocument(telegramId, source, {
        caption: caption || "",
        parse_mode: "HTML",
      }, {
        filename: fileName || "file",
        contentType: contentType || "application/octet-stream",
      });
      return { success: true, data: result };
    } catch (error) {
      logger.error(`Telegram fayl yuborishda xato: ${error.message}`);
      return {
        success: false,
        error: error.message,
        errorCode: error.response?.body?.error_code,
      };
    }
  }

  /**
   * Send message with file (photo or document)
   * @param {string} telegramId - Telegram user ID
   * @param {string} text - Message text
   * @param {string} filePath - Path to file (optional)
   * @param {string} fileType - File type: 'photo' or 'document' (optional)
   * @returns {Promise<Object>} - Telegram API response
   */
  async sendMessageWithFile(telegramId, text, filePath = null, fileType = null, fileName = null, fileContentType = null, replyMarkup = null) {
    if (!bot) {
      throw new Error("Telegram bot not initialized");
    }

    try {
      let result;

      if (filePath && fileType) {
        if (fileType === "photo") {
          result = await this.sendPhoto(telegramId, filePath, text);
        } else if (fileType === "document") {
          result = await this.sendDocument(telegramId, filePath, text, fileName, fileContentType);
        } else {
          throw new Error("Invalid file type. Use 'photo' or 'document'");
        }
      } else {
        result = await this.sendMessage(telegramId, text, replyMarkup);
      }

      return result;
    } catch (error) {
      logger.error(`Telegram xabar yuborishda xato: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Foydalanuvchi kanal/guruhga a'zo ekanligini tekshirish
   * @param {string} channelChatId - Kanal yoki guruh chat ID
   * @param {string|number} telegramUserId - Telegram foydalanuvchi ID
   * @returns {Promise<{isMember: boolean, status: string}>}
   */
  async checkMembership(channelChatId, telegramUserId) {
    if (!bot) {
      return { isMember: false, status: "bot_not_initialized" };
    }

    try {
      const member = await bot.getChatMember(channelChatId, telegramUserId);
      const isMember = ["creator", "administrator", "member"].includes(
        member.status
      );
      return { isMember, status: member.status };
    } catch (error) {
      logger.error(`Telegram a'zolikni tekshirishda xato: ${error.message}`);
      return { isMember: false, status: "error" };
    }
  }

  /**
   * Delete file after sending
   * @param {string} filePath - Path to file
   */
  deleteFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.info(`File deleted: ${filePath}`);
      }
    } catch (error) {
      logger.error(`Faylni o'chirishda xato: ${error.message}`);
    }
  }

  /**
   * Sleep for specified milliseconds
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = new TelegramService();
