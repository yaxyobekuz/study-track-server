/**
 * Oylik to'lov majburiyatlarini avtomatik shakllantirish.
 *
 * NIMA UCHUN HAR KUNI, OYIGA BIR MARTA EMAS ("0 1 1 * *" emas):
 *
 *  1. Sozlama bazada, cron ifodasi esa `cron.schedule()` chaqirilganda —
 *     ya'ni startup'da — kompilyatsiya qilinadi. Admin `invoiceDayOfMonth` ni
 *     1 dan 5 ga o'zgartirsa, ifodaga qotib qolgan "1" keyingi deploy'gacha
 *     eskirib qolardi. Shuning uchun jadval qat'iy, kun tekshiruvi esa
 *     handler ichida — u har safar bazadan o'qiydi.
 *  2. Tekshiruv `today < targetDay` (`!==` EMAS). Server 1-sanada o'chiq
 *     bo'lsa, 2-sanada o'sha oy majburiyatlari baribir yaraladi. Bu — butun
 *     tiklanish mexanizmi: watermark ham, lock ham, holat mashinasi ham
 *     kerak emas. Keyingi kunlardagi passlar bekorga ishlaydi (`created: 0`),
 *     chunki hamma qatorlar allaqachon bor.
 *  3. 06:00 — yarim tunda `currentMonthKey()` chegarasida turmaslik va 23:45
 *     dagi davomat joblari bilan to'qnashmaslik uchun.
 *
 * KO'P INSTANS (PM2 cluster): ikkalasi bir vaqtda ishlasa ham dublikat
 * bo'lmaydi — `@@unique([studentId, month])` + `skipDuplicates`.
 *
 * Startup'da pass ISHLATILMAYDI: kechqurungi deploy butun oyning
 * majburiyatlarini nojo'ya yaratib yubormasligi kerak.
 */

const cron = require("node-cron");
const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const { getFinanceSettings } = require("../services/settings.service");
const { generateForMonth } = require("../services/invoiceGeneration.service");
const {
  currentMonthKey,
  currentDayOfMonth,
  daysInCurrentMonth,
  prevMonth,
} = require("../helpers/month.helpers");

/**
 * Bitta pass: sozlamani o'qiydi, kun kelganini tekshiradi va joriy (+ catch-up)
 * oylar uchun majburiyat shakllantiradi.
 *
 * @param {{force?: boolean}} options - `force` kun tekshiruvini o'tkazib yuboradi (qo'lda ishga tushirish)
 * @returns {Promise<object[]>} har oy uchun summary
 */
async function runInvoiceGenerationPass({ force = false } = {}) {
  const settings = await getFinanceSettings();

  if (!settings.autoGenerateEnabled) {
    logger.info("[InvoiceCron] Avtomatik shakllantirish o'chirilgan");
    return [];
  }

  const today = currentDayOfMonth();
  // Sozlamada 1..28 cheklovi bor, lekin eski yozuvlar uchun himoya:
  // 31-kun fevralda hech qachon kelmaydi va o'sha oy tashlab ketilardi.
  const targetDay = Math.min(settings.invoiceDayOfMonth, daysInCurrentMonth());

  if (!force && today < targetDay) {
    logger.info(
      `[InvoiceCron] Hali erta (bugun ${today}, kerak ${targetDay})`,
    );
    return [];
  }

  const current = currentMonthKey();
  const months = [];
  let month = current;
  for (let i = 0; i <= settings.catchUpMonths; i += 1) {
    months.unshift(month);
    month = prevMonth(month);
  }

  const summaries = [];

  for (const target of months) {
    try {
      const summary = await generateForMonth(target, {
        source: "cron",
        actorId: null,
      });
      summaries.push(summary);

      if (summary.reason) {
        logger.info(`[InvoiceCron] ${summary.monthLabel}: ${summary.reason}`);
      } else {
        logger.info(
          `[InvoiceCron] ${summary.monthLabel}: ${summary.created} ta yaratildi, ` +
            `mavjud ${summary.skipped.alreadyExists}, muzlatilgan ${summary.skipped.frozen}, ` +
            `chetlatilgan ${summary.skipped.expelled}, tarifsiz ${summary.skipped.noTariff}, ` +
            `narxsiz ${summary.skipped.noPrice}, summa ${summary.totalAmount}`,
        );
      }
    } catch (error) {
      // Bitta oydagi xato qolganlarini to'xtatmaydi
      logger.error(`[InvoiceCron] ${target} oyida xato: ${error.message}`);
    }
  }

  try {
    await prisma.financeSettings.update({
      where: { id: settings.id },
      data: { lastRunAt: new Date(), lastGeneratedMonth: current },
    });
  } catch (error) {
    logger.warn(`[InvoiceCron] Watermark yozilmadi: ${error.message}`);
  }

  return summaries;
}

/**
 * Cron jobni belgilaydi. Har kuni 06:00 (Asia/Tashkent).
 */
function startInvoiceGenerationCron() {
  cron.schedule(
    "0 6 * * *",
    async () => {
      logger.info("[InvoiceCron] Hisob-faktura tekshiruvi boshlandi...");
      try {
        await runInvoiceGenerationPass();
      } catch (error) {
        logger.error("[InvoiceCron] Cron xatosi:", error);
      }
    },
    {
      scheduled: true,
      timezone: "Asia/Tashkent",
    },
  );

  logger.info(
    "Hisob-faktura cron job belgilandi: Har kuni 06:00 (Asia/Tashkent)",
  );
}

module.exports = { startInvoiceGenerationCron, runInvoiceGenerationPass };
