const PenaltyNotificationQueue = require("../models/penaltyNotificationQueue.model");
const telegramService = require("./telegram.service");
const logger = require("../utils/logger");

class PenaltyNotificationQueueService {
  constructor() {
    this.isProcessing = false;
    this.rateLimit = parseInt(process.env.MESSAGE_RATE_LIMIT_MS || "1000", 10);
    this.recoverStuckItems();
  }

  /**
   * Server qayta ishga tushganda "processing" holatdagi itemlarni "pending" ga qaytaradi
   */
  async recoverStuckItems() {
    try {
      const result = await PenaltyNotificationQueue.updateMany(
        { status: "processing" },
        { $set: { status: "pending" } },
      );
      if (result.modifiedCount > 0) {
        logger.info(
          `${result.modifiedCount} ta jarima xabarnoma queue itemi qayta tiklandi`,
        );
      }
    } catch (error) {
      logger.error(
        `Jarima queue itemlarni qayta tiklashda xato: ${error.message}`,
      );
    }
  }

  /**
   * Bir nechta xabarnomani navbatga qo'shadi
   * @param {Array} items - Queue item parametrlari massivi
   * @returns {Promise<Array>} Yaratilgan queue itemlar
   */
  async addBulkToQueue(items) {
    try {
      const queueItems = await PenaltyNotificationQueue.insertMany(items);
      logger.info(
        `${queueItems.length} ta jarima xabarnoma navbatga qo'shildi`,
      );

      if (!this.isProcessing) {
        this.processQueue();
      }

      return queueItems;
    } catch (error) {
      logger.error(
        `Jarima xabarnomani navbatga qo'shishda xato: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Navbatdagi itemlarni ketma-ket qayta ishlaydi
   */
  async processQueue() {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    logger.info("Jarima xabarnoma queue qayta ishlanmoqda...");

    try {
      while (true) {
        const queueItem = await PenaltyNotificationQueue.findOne({
          status: "pending",
        }).sort({ priority: -1, createdAt: 1 });

        if (!queueItem) {
          break;
        }

        queueItem.status = "processing";
        await queueItem.save();

        await this.processQueueItem(queueItem);

        await telegramService.sleep(this.rateLimit);
      }
    } catch (error) {
      logger.error(
        `Jarima xabarnoma queue qayta ishlashda xato: ${error.message}`,
      );
    } finally {
      this.isProcessing = false;
      logger.info("Jarima xabarnoma queue qayta ishlash tugadi");
    }
  }

  /**
   * Bitta queue itemni qayta ishlaydi: matn + attachmentlar yuboradi
   * @param {Object} queueItem - Qayta ishlanadigan queue item
   */
  async processQueueItem(queueItem) {
    try {
      const result = await telegramService.sendMessage(
        queueItem.telegramId,
        queueItem.messageText,
      );

      if (!result.success) {
        queueItem.attempts += 1;
        queueItem.errorMessage = result.error;

        if (queueItem.attempts >= queueItem.maxAttempts) {
          queueItem.status = "failed";
          queueItem.processedAt = new Date();
          logger.error(
            `Jarima xabarnoma yuborishda xato (max attempts): ${queueItem.telegramId} - ${result.error}`,
          );
        } else {
          queueItem.status = "pending";
          logger.warn(
            `Jarima xabarnoma yuborishda xato, qayta uriniladi (${queueItem.attempts}/${queueItem.maxAttempts}): ${queueItem.telegramId}`,
          );
        }

        await queueItem.save();
        return;
      }

      // Attachmentlarni yuborish
      if (queueItem.attachments && queueItem.attachments.length > 0) {
        for (const attachment of queueItem.attachments) {
          try {
            await telegramService.sleep(this.rateLimit);

            if (attachment.type === "image") {
              await telegramService.sendPhoto(
                queueItem.telegramId,
                attachment.url,
                "",
              );
            } else {
              await telegramService.sendDocument(
                queueItem.telegramId,
                attachment.url,
                "",
                attachment.originalName,
              );
            }
          } catch (attachmentError) {
            logger.error(
              `Jarima attachment yuborishda xato (${attachment.originalName}): ${attachmentError.message}`,
            );
          }
        }
      }

      queueItem.status = "completed";
      queueItem.processedAt = new Date();
      await queueItem.save();

      logger.info(`Jarima xabarnoma yuborildi: ${queueItem.telegramId}`);
    } catch (error) {
      logger.error(
        `Jarima queue item qayta ishlashda xato: ${error.message}`,
      );
      queueItem.status = "failed";
      queueItem.errorMessage = error.message;
      queueItem.processedAt = new Date();
      await queueItem.save();
    }
  }

  /**
   * Eski tugallangan/muvaffaqiyatsiz queue itemlarni o'chiradi
   * @param {number} days - Necha kunlik itemlar o'chiriladi
   * @returns {Promise<number>} O'chirilgan itemlar soni
   */
  async clearOldQueueItems(days = 7) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const result = await PenaltyNotificationQueue.deleteMany({
        status: { $in: ["completed", "failed"] },
        processedAt: { $lt: cutoffDate },
      });

      logger.info(
        `${result.deletedCount} ta eski jarima xabarnoma queue item o'chirildi`,
      );
      return result.deletedCount;
    } catch (error) {
      logger.error(
        `Eski jarima queue itemlarni o'chirishda xato: ${error.message}`,
      );
      throw error;
    }
  }
}

module.exports = new PenaltyNotificationQueueService();
