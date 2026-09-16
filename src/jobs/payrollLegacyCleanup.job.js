/**
 * TIZIMGA O'TISHDAN OLDINGI OYLIK MAJBURIYATLARINI TOZALASH — startup passi.
 *
 * Xodimlar SENTABR, 2026 dan ish boshlagan. Undan oldingi (avgust va avvalgi)
 * oyliklar avtomatik shakllantirilib, "fantom qarz" bo'lib qolgan. Bu pass
 * server har ishga tushganda BIR MARTA:
 *   1. `firstPayrollMonth` polini `202609` ga o'rnatadi (agar past bo'lsa) —
 *      shuning uchun kunlik cron o'sha oylarni QAYTA yaratmaydi.
 *   2. Pol'dan oldingi TO'LOVSIZ (qarz) oylik majburiyatlarini O'CHIRADI.
 *
 * ⚠️ To'lov TUSHGAN majburiyatga TEGILMAYDI (kassa daftari buzilmasin) —
 * ular alohida log qilinadi, qo'lda ko'rib chiqiladi. Avgust oyliklari odatda
 * to'lanmagani uchun (sentabrdan boshlangan) hammasi shu o'chirishga tushadi.
 *
 * ⚠️ IDEMPOTENT: birinchi o'chirishdan keyin pol'dan oldingi qator qolmaydi,
 * ya'ni keyingi startup'larda hech narsa o'chmaydi. To'lovsiz majburiyatni
 * o'chirish xavfsiz — unga bog'liq `SalaryAllocation` `onDelete: Cascade`
 * bilan o'zi o'chadi, kassa daftariga tegilmaydi.
 */

const { branchCron } = require("../helpers/branchIterator");
const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const { getFinanceSettings } = require("../services/settings.service");

// Xodimlar ish boshlagan oy — bundan oldin oylik yo'q.
const PAYROLL_START_MONTH = 202609;

/**
 * Bir marta ishga tushiriladi (server startup). Filiallar bo'ylab yuradi.
 */
async function runPayrollLegacyCleanup() {
  await branchCron("[PayrollCleanup]", async (branch) => {
    const settings = await getFinanceSettings();

    // 1 ── Pol: cron eski oylarni qayta yaratmasin
    let floor = settings.firstPayrollMonth;
    if (floor == null || floor < PAYROLL_START_MONTH) {
      floor = PAYROLL_START_MONTH;
      await prisma.financeSettings.update({
        where: { id: settings.id },
        data: { firstPayrollMonth: floor },
      });
    }

    // 2 ── Pol'dan oldingi TO'LOVSIZ majburiyatlarni o'chiramiz (qarz).
    // `SalaryAllocation` (onDelete: Cascade) o'zi o'chadi; to'lovsizda faol
    // allokatsiya yo'q, shuning uchun kassa daftariga tegilmaydi.
    const deleted = await prisma.payrollEntry.deleteMany({
      where: { month: { lt: floor }, paidAmount: 0 },
    });

    // 3 ── To'lov tushgan eski majburiyat qolsa — o'chirmaymiz, log qilamiz
    const paidLeft = await prisma.payrollEntry.count({
      where: { month: { lt: floor }, paidAmount: { gt: 0 } },
    });

    if (deleted.count > 0 || paidLeft > 0) {
      logger.warn(
        `[PayrollCleanup] ${branch.name}: pol ${floor}, ` +
          `${deleted.count} ta to'lovsiz eski oylik majburiyati o'chirildi` +
          (paidLeft
            ? `, ${paidLeft} ta to'lovli majburiyat qoldi (qo'lda ko'rib chiqing)`
            : ""),
      );
    }
  })();
}

module.exports = { runPayrollLegacyCleanup };
