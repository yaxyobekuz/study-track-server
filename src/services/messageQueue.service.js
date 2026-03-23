// Models
const MessageQueue = require("../models/messageQueue.model");
const Message = require("../models/message.model");

// Services
const telegramService = require("./telegram.service");

// Logger
const logger = require("../utils/logger");

class MessageQueueService {
  constructor() {
    this.isProcessing = false;
    const { config } = require("../config/env.config");
    this.rateLimit = config.messageRateLimitMs;
  }

  /**
   * Add message to queue
   * @param {Object} params - Queue item parameters
   * @returns {Promise<Object>} - Created queue item
   */
  async addToQueue(params) {
    try {
      const queueItem = await MessageQueue.create(params);
      logger.info(`Xabar navbatga qo'shildi: ${queueItem._id}`);

      // Start processing queue if not already processing
      if (!this.isProcessing) {
        this.processQueue();
      }

      return queueItem;
    } catch (error) {
      logger.error(`Navbatga qo'shishda xato: ${error.message}`);
      throw error;
    }
  }

  /**
   * Add multiple messages to queue
   * @param {Array} items - Array of queue item parameters
   * @returns {Promise<Array>} - Created queue items
   */
  async addBulkToQueue(items) {
    try {
      const queueItems = await MessageQueue.insertMany(items);
      logger.info(`${queueItems.length} ta xabar navbatga qo'shildi`);

      // Start processing queue if not already processing
      if (!this.isProcessing) {
        this.processQueue();
      }

      return queueItems;
    } catch (error) {
      logger.error(`Navbatga qo'shishda xato: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process queue items
   */
  async processQueue() {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    logger.info("Queue qayta ishlanmoqda...");

    try {
      while (true) {
        // Get next pending item from queue (sorted by priority and creation time)
        const queueItem = await MessageQueue.findOne({
          status: "pending",
        }).sort({ priority: -1, createdAt: 1 });

        if (!queueItem) {
          // No more items to process
          break;
        }

        // Mark as processing
        queueItem.status = "processing";
        await queueItem.save();

        // Process the item
        await this.processQueueItem(queueItem);

        // Wait for rate limit
        await telegramService.sleep(this.rateLimit);
      }
    } catch (error) {
      logger.error(`Queue qayta ishlashda xato: ${error.message}`);
    } finally {
      this.isProcessing = false;
      logger.info("Queue qayta ishlash tugadi");
    }
  }

  /**
   * Process single queue item
   * @param {Object} queueItem - Queue item to process
   */
  async processQueueItem(queueItem) {
    try {
      // Send message via Telegram
      const result = await telegramService.sendMessageWithFile(
        queueItem.telegramId,
        queueItem.messageText,
        queueItem.filePath,
        queueItem.fileType,
        queueItem.fileName,
        queueItem.fileContentType,
      );

      if (result.success) {
        // Mark as completed
        queueItem.status = "completed";
        queueItem.processedAt = new Date();

        // Update delivery status in Message model
        await Message.findByIdAndUpdate(
          queueItem.messageId,
          {
            $set: {
              "deliveryStatus.$[elem].status": "sent",
              "deliveryStatus.$[elem].sentAt": new Date(),
            },
          },
          {
            arrayFilters: [{ "elem.telegramId": queueItem.telegramId }],
          },
        );

        logger.info(`Xabar yuborildi: ${queueItem.telegramId}`);
      } else {
        // Handle failure
        queueItem.attempts += 1;
        queueItem.errorMessage = result.error;

        if (queueItem.attempts >= queueItem.maxAttempts) {
          // Max attempts reached, mark as failed
          queueItem.status = "failed";
          queueItem.processedAt = new Date();

          // Update delivery status in Message model
          await Message.findByIdAndUpdate(
            queueItem.messageId,
            {
              $set: {
                "deliveryStatus.$[elem].status": "failed",
                "deliveryStatus.$[elem].errorMessage": result.error,
              },
            },
            {
              arrayFilters: [{ "elem.telegramId": queueItem.telegramId }],
            },
          );

          logger.error(
            `Xabar yuborishda xato (max attempts): ${queueItem.telegramId} - ${result.error}`,
          );
        } else {
          // Retry
          queueItem.status = "pending";
          logger.warn(
            `Xabar yuborishda xato, qayta uriniladi (${queueItem.attempts}/${queueItem.maxAttempts}): ${queueItem.telegramId}`,
          );
        }
      }

      await queueItem.save();
    } catch (error) {
      logger.error(`Queue item qayta ishlashda xato: ${error.message}`);
      queueItem.status = "failed";
      queueItem.errorMessage = error.message;
      queueItem.processedAt = new Date();
      await queueItem.save();
    }
  }

  /**
   * Get queue statistics
   * @returns {Promise<Object>} - Queue statistics
   */
  async getQueueStats() {
    try {
      const stats = await MessageQueue.aggregate([
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
          },
        },
      ]);

      return stats.reduce((acc, stat) => {
        acc[stat._id] = stat.count;
        return acc;
      }, {});
    } catch (error) {
      logger.error(`Queue statistika olishda xato: ${error.message}`);
      throw error;
    }
  }

  /**
   * Clear completed queue items older than specified days
   * @param {number} days - Number of days
   * @returns {Promise<number>} - Number of deleted items
   */
  async clearOldQueueItems(days = 7) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const result = await MessageQueue.deleteMany({
        status: { $in: ["completed", "failed"] },
        processedAt: { $lt: cutoffDate },
      });

      logger.info(`${result.deletedCount} ta eski queue item o'chirildi`);
      return result.deletedCount;
    } catch (error) {
      logger.error(`Eski queue itemlarni o'chirishda xato: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new MessageQueueService();
