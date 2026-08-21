const prisma = require("../config/prisma");
const { getBranch, runWithBranch } = require("../config/branchContext");
const telegramService = require("./telegram.service");
const logger = require("../utils/logger");

class PenaltyNotificationQueueService {
  constructor() {
    // ⚠️ FILIAL BO'YICHA, global emas. Navbat har filialning o'z schema'sida
    // yashaydi: bitta global bayroq bir filial ishlayotganda qolganlarini
    // bloklab qo'yardi va xabarlar "pending" da qotib qolardi.
    this.processing = new Map(); // schemaName -> true
    const { config } = require("../config/env.config");
    this.rateLimit = config.messageRateLimitMs;
  }

  /**
   * Server qayta ishga tushganda "processing" holatdagi itemlarni "pending" ga qaytaradi
   */
  async recoverStuckItems() {
    try {
      const result = await prisma.penaltyNotificationQueue.updateMany({
        where: { status: "processing" },
        data: { status: "pending" },
      });
      if (result.count > 0) {
        logger.info(
          `${result.count} ta jarima xabarnoma queue itemi qayta tiklandi`,
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
      const created = await prisma.penaltyNotificationQueue.createMany({
        data: items,
      });
      logger.info(
        `${created.count} ta jarima xabarnoma navbatga qo'shildi`,
      );

      if (!this.isBusy()) {
        this.startProcessing();
      }

      return created;
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
  /** Joriy filialning kaliti; kontekst yo'q bo'lsa `null`. */
  branchKey() {
    const branch = getBranch();
    return branch ? branch.schemaName : null;
  }

  /** Shu filialda navbat allaqachon qayta ishlanyaptimi? */
  isBusy() {
    const key = this.branchKey();
    return key ? this.processing.get(key) === true : false;
  }

  /**
   * Navbatni JORIY FILIAL kontekstida fonda ishga tushiradi.
   *
   * Kontekst ATAYLAB aniq uzatiladi: chaqiruv "detached" (javob kutilmaydi)
   * va so'rov tugagandan keyin ham davom etadi — `prisma` qaysi filialga
   * borishini bilishi kerak.
   */
  startProcessing() {
    const branch = getBranch();
    if (!branch) return;
    runWithBranch(branch, () => this.processQueue());
  }

  async processQueue() {
    const key = this.branchKey();
    if (!key || this.processing.get(key)) {
      return;
    }

    this.processing.set(key, true);
    logger.info("Jarima xabarnoma queue qayta ishlanmoqda...");

    try {
      while (true) {
        const queueItem = await prisma.penaltyNotificationQueue.findFirst({
          where: { status: "pending" },
          orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
        });

        if (!queueItem) {
          break;
        }

        await prisma.penaltyNotificationQueue.update({
          where: { id: queueItem.id },
          data: { status: "processing" },
        });
        queueItem.status = "processing";

        await this.processQueueItem(queueItem);

        await telegramService.sleep(this.rateLimit);
      }
    } catch (error) {
      logger.error(
        `Jarima xabarnoma queue qayta ishlashda xato: ${error.message}`,
      );
    } finally {
      this.processing.delete(key);
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

        await prisma.penaltyNotificationQueue.update({
          where: { id: queueItem.id },
          data: {
            attempts: queueItem.attempts,
            errorMessage: queueItem.errorMessage,
            status: queueItem.status,
            processedAt: queueItem.processedAt,
          },
        });
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
      await prisma.penaltyNotificationQueue.update({
        where: { id: queueItem.id },
        data: { status: queueItem.status, processedAt: queueItem.processedAt },
      });

      logger.info(`Jarima xabarnoma yuborildi: ${queueItem.telegramId}`);
    } catch (error) {
      logger.error(
        `Jarima queue item qayta ishlashda xato: ${error.message}`,
      );
      queueItem.status = "failed";
      queueItem.errorMessage = error.message;
      queueItem.processedAt = new Date();
      await prisma.penaltyNotificationQueue.update({
        where: { id: queueItem.id },
        data: {
          status: queueItem.status,
          errorMessage: queueItem.errorMessage,
          processedAt: queueItem.processedAt,
        },
      });
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

      const result = await prisma.penaltyNotificationQueue.deleteMany({
        where: {
          status: { in: ["completed", "failed"] },
          processedAt: { lt: cutoffDate },
        },
      });

      logger.info(
        `${result.count} ta eski jarima xabarnoma queue item o'chirildi`,
      );
      return result.count;
    } catch (error) {
      logger.error(
        `Eski jarima queue itemlarni o'chirishda xato: ${error.message}`,
      );
      throw error;
    }
  }
}

const instance = new PenaltyNotificationQueueService();

/**
 * Server ishga tushganda BARCHA filiallarda "processing" da qotib qolgan
 * yozuvlarni "pending" ga qaytaradi va navbatni qayta ishga tushiradi.
 *
 * Konstruktorda EMAS: modul yuklanganda filial konteksti hali yo'q va
 * `prisma` xato beradi. `index.js` bootstrap'i shuni chaqiradi.
 */
instance.recoverAll = async () => {
  const { forEachBranch } = require("../helpers/branchIterator");
  await forEachBranch(
    async () => {
      await instance.recoverStuckItems();
      if (!instance.isBusy()) instance.startProcessing();
    },
    { label: "[Jarima xabarnoma queue]" },
  );
};

module.exports = instance;
