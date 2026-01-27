// Telegram Bot API
const TelegramBot = require("node-telegram-bot-api");

// File System
const fs = require("fs");

// Logger
const logger = require("../utils/logger");

// Initialize bot
const token = process.env.TELEGRAM_BOT_TOKEN;
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
  async sendMessage(telegramId, text) {
    if (!bot) {
      throw new Error("Telegram bot not initialized");
    }

    try {
      const result = await bot.sendMessage(telegramId, text, {
        parse_mode: "HTML",
      });
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
   * Send photo with caption to telegram user
   * @param {string} telegramId - Telegram user ID
   * @param {string} filePath - Path to photo file
   * @param {string} caption - Photo caption
   * @returns {Promise<Object>} - Telegram API response
   */
  async sendPhoto(telegramId, filePath, caption) {
    if (!bot) {
      throw new Error("Telegram bot not initialized");
    }

    try {
      const result = await bot.sendPhoto(telegramId, filePath, {
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
   * @param {string} filePath - Path to document file
   * @param {string} caption - Document caption
   * @returns {Promise<Object>} - Telegram API response
   */
  async sendDocument(telegramId, filePath, caption) {
    if (!bot) {
      throw new Error("Telegram bot not initialized");
    }

    try {
      const result = await bot.sendDocument(telegramId, filePath, {
        caption: caption || "",
        parse_mode: "HTML",
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
  async sendMessageWithFile(telegramId, text, filePath = null, fileType = null) {
    if (!bot) {
      throw new Error("Telegram bot not initialized");
    }

    try {
      let result;

      if (filePath && fileType) {
        // Check if file exists
        if (!fs.existsSync(filePath)) {
          throw new Error("File not found");
        }

        if (fileType === "photo") {
          result = await this.sendPhoto(telegramId, filePath, text);
        } else if (fileType === "document") {
          result = await this.sendDocument(telegramId, filePath, text);
        } else {
          throw new Error("Invalid file type. Use 'photo' or 'document'");
        }
      } else {
        result = await this.sendMessage(telegramId, text);
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
