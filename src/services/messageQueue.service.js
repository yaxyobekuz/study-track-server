// Prisma
const prisma = require("../config/prisma");

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
      const queueItem = await prisma.messageQueue.create({ data: params });
      logger.info(`Xabar navbatga qo'shildi: ${queueItem.id}`);

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
      const queueItems = await prisma.$transaction(
        items.map((item) => prisma.messageQueue.create({ data: item })),
      );
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
        const queueItem = await prisma.messageQueue.findFirst({
          where: { status: "pending" },
          orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
        });

        if (!queueItem) {
          // No more items to process
          break;
        }

        // Mark as processing
        await prisma.messageQueue.update({
          where: { id: queueItem.id },
          data: { status: "processing" },
        });
        queueItem.status = "processing";

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
        queueItem.replyMarkup,
      );

      const update = {};

      if (result.success) {
        // Mark as completed
        update.status = "completed";
        update.processedAt = new Date();

        // Update delivery status in Message model
        await prisma.messageDeliveryStatus.updateMany({
          where: {
            messageId: queueItem.messageId,
            telegramId: queueItem.telegramId,
          },
          data: {
            status: "sent",
            sentAt: new Date(),
          },
        });

        logger.info(`Xabar yuborildi: ${queueItem.telegramId}`);
      } else {
        // Handle failure
        update.attempts = queueItem.attempts + 1;
        update.errorMessage = result.error;

        if (update.attempts >= queueItem.maxAttempts) {
          // Max attempts reached, mark as failed
          update.status = "failed";
          update.processedAt = new Date();

          // Update delivery status in Message model
          await prisma.messageDeliveryStatus.updateMany({
            where: {
              messageId: queueItem.messageId,
              telegramId: queueItem.telegramId,
            },
            data: {
              status: "failed",
              errorMessage: result.error,
            },
          });

          logger.error(
            `Xabar yuborishda xato (max attempts): ${queueItem.telegramId} - ${result.error}`,
          );
        } else {
          // Retry
          update.status = "pending";
          logger.warn(
            `Xabar yuborishda xato, qayta uriniladi (${update.attempts}/${queueItem.maxAttempts}): ${queueItem.telegramId}`,
          );
        }
      }

      await prisma.messageQueue.update({
        where: { id: queueItem.id },
        data: update,
      });
    } catch (error) {
      logger.error(`Queue item qayta ishlashda xato: ${error.message}`);
      await prisma.messageQueue.update({
        where: { id: queueItem.id },
        data: {
          status: "failed",
          errorMessage: error.message,
          processedAt: new Date(),
        },
      });
    }
  }

  /**
   * Cancel pending deliveries of a message.
   * Stops anything still in the queue (status "pending"). Items already being
   * sent ("processing") or already delivered ("completed"/"sent") are left
   * untouched - those cannot be recalled.
   * @param {string} messageId - Message to cancel
   * @returns {Promise<number>} - Number of cancelled queue items
   */
  async cancelMessage(messageId) {
    try {
      const queueResult = await prisma.messageQueue.updateMany({
        where: { messageId, status: "pending" },
        data: {
          status: "cancelled",
          errorMessage: "Bekor qilindi",
          processedAt: new Date(),
        },
      });

      await prisma.messageDeliveryStatus.updateMany({
        where: { messageId, status: "pending" },
        data: { status: "cancelled" },
      });

      logger.info(
        `Xabar bekor qilindi: ${messageId} (${queueResult.count} ta navbatdagi xabar to'xtatildi)`,
      );

      return queueResult.count;
    } catch (error) {
      logger.error(`Xabarni bekor qilishda xato: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get queue statistics
   * @returns {Promise<Object>} - Queue statistics
   */
  async getQueueStats() {
    try {
      const stats = await prisma.messageQueue.groupBy({
        by: ["status"],
        _count: { _all: true },
      });

      return stats.reduce((acc, stat) => {
        acc[stat.status] = stat._count._all;
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

      const result = await prisma.messageQueue.deleteMany({
        where: {
          status: { in: ["completed", "failed"] },
          processedAt: { lt: cutoffDate },
        },
      });

      logger.info(`${result.count} ta eski queue item o'chirildi`);
      return result.count;
    } catch (error) {
      logger.error(`Eski queue itemlarni o'chirishda xato: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new MessageQueueService();
