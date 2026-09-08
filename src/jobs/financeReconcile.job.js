/**
 * Moliyaviy invariantlarni har kecha tekshiradi.
 *
 * Modulda uchta denormalizatsiya va bitta muhrlangan identitet bor — ular
 * tezlik uchun saqlanadi, lekin to'g'riligi kodning to'g'riligiga bog'liq:
 *
 *   1. PaymentAccount.balance     = openingBalance + Σ AccountEntry.amount
 *   2. StudentAccount.balance     = Σ Payment.depositAmount + Σ to'g'rilash
 *   3. MonthlyInvoice.paidAmount  = Σ (isVoided=false) PaymentAllocation.amount
 *   4. MonthlyInvoice.amount      = proratedAmount − discountAmount
 *                                   (va proratedAmount <= baseAmount)
 *
 * CHIQIM tomoni ham AYNAN shu ikki shaklga ega (`finance.md` §10 — har bir
 * tushunchaning ko'zgusi bor), lekin tekshiruvsiz qolgan edi:
 *
 *   5. PayrollEntry.paidAmount    = Σ (isVoided=false) SalaryAllocation.amount
 *   6. PayrollEntry.amount        = baseAmount + hoursAmount
 *
 * Kirim tomonida yo'qolgan yangilanish ertasi kuni topilar, chiqim tomonida
 * esa oylik qayta to'lanib ketishi mumkin edi va buni hech kim aytmasdi.
 *
 * ARZON REKONSILER HAR QANDAY DIZAYN ISHONCHIDAN QIMMATROQ. Bu job hech
 * narsani TUZATMAYDI — u faqat baqiradi. Avtomatik tuzatish haqiqiy sababni
 * yashirardi va keyingi safar pul jimgina yo'qolardi.
 *
 * 03:00 — 06:00 dagi hisob-faktura passidan oldin, kunduzgi to'lov
 * ishidan keyin.
 */

const cron = require("node-cron");
const { branchCron } = require("../helpers/branchIterator");
const prisma = require("../config/prisma");
const { getBranch } = require("../config/branchContext");
const logger = require("../utils/logger");
const { Decimal, formatAmount } = require("../helpers/money.helpers");

/**
 * Bitta tekshiruv passi.
 * @returns {Promise<{checked: object, problems: object[]}>}
 */
async function runFinanceReconcilePass() {
  const problems = [];

  // Filial nomi HAR BIR log satrida: bu job pul invariantlari haqida
  // baqiradi va "qaysi filialda?" degan savol javobsiz qolmasligi kerak.
  const branch = getBranch();
  const tag = `[FinanceReconcile] ${branch ? branch.name : "?"}`;

  // ── 1. To'lov turlari qoldiqlari ───────────────────
  const accounts = await prisma.paymentAccount.findMany();
  const entrySums = await prisma.accountEntry.groupBy({
    by: ["accountId"],
    _sum: { amount: true },
  });
  const entryByAccount = new Map(
    entrySums.map((row) => [row.accountId, new Decimal(row._sum.amount ?? 0)]),
  );

  for (const account of accounts) {
    const expected = new Decimal(account.openingBalance).plus(
      entryByAccount.get(account.id) ?? 0,
    );
    if (!expected.equals(account.balance)) {
      problems.push({
        kind: "account_balance",
        id: account.id,
        label: account.name,
        stored: formatAmount(account.balance),
        expected: formatAmount(expected),
      });
    }
  }

  // ── 2. O'quvchi depoziti ──────────────────
  // balance = to'lovlarning taqsimlanmagan qoldig'i + qo'lda to'g'rilashlar.
  // Qaytarish (`refundDeposit`) `depositAmount` ni kamaytiradi, ya'ni u
  // birinchi qo'shiluvchiga singdirilgan; to'g'rilash esa unga tegmaydi
  // va alohida qo'shiladi.
  const [studentAccounts, depositSums, adjustmentSums] = await Promise.all([
    prisma.studentAccount.findMany(),
    prisma.payment.groupBy({
      by: ["studentId"],
      where: { isVoided: false },
      _sum: { depositAmount: true },
    }),
    // Qo'lda to'g'rilashlar `depositAmount` ga tegmaydi — ular alohida
    // qo'shiladi.
    //
    // ⚠️ HAR DOIM qo'shiladi. Ilgari to'g'rilashlar faqat birinchi
    // taqqoslash MOS KELMAGANDA o'qilardi: to'g'rilashlar yig'indisi +100
    // bo'lgan o'quvchida depozit −100 ga adashsa, ikkita xato bir-birini
    // yopib, tekshiruv jimgina o'tib ketardi. Bundan tashqari, o'sha
    // shakl har bir mos kelmagan o'quvchi uchun alohida so'rov yuborardi.
    prisma.studentBalanceAdjustment.groupBy({
      by: ["studentId"],
      _sum: { amount: true },
    }),
  ]);

  const depositByStudent = new Map(
    depositSums.map((row) => [row.studentId, new Decimal(row._sum.depositAmount ?? 0)]),
  );
  const adjustmentByStudent = new Map(
    adjustmentSums.map((row) => [row.studentId, new Decimal(row._sum.amount ?? 0)]),
  );

  for (const account of studentAccounts) {
    const expected = (depositByStudent.get(account.studentId) ?? new Decimal(0)).plus(
      adjustmentByStudent.get(account.studentId) ?? new Decimal(0),
    );
    const stored = new Decimal(account.balance);

    if (!expected.equals(stored)) {
      problems.push({
        kind: "student_balance",
        id: account.studentId,
        label: `student=${account.studentId}`,
        stored: formatAmount(stored),
        expected: formatAmount(expected),
      });
    }
  }

  // ── 3. Hisob-faktura to'langan summasi ────
  // Faqat qiymati bor qatorlar tekshiriladi: nol/nol juftligi ko'p va
  // ular hech qachon buzilmaydi.
  const invoices = await prisma.monthlyInvoice.findMany({
    where: { OR: [{ paidAmount: { gt: 0 } }, { allocations: { some: { isVoided: false } } }] },
    select: { id: true, month: true, studentId: true, paidAmount: true },
  });

  if (invoices.length > 0) {
    const allocationSums = await prisma.paymentAllocation.groupBy({
      by: ["invoiceId"],
      where: { invoiceId: { in: invoices.map((i) => i.id) }, isVoided: false },
      _sum: { amount: true },
    });
    const allocationByInvoice = new Map(
      allocationSums.map((row) => [row.invoiceId, new Decimal(row._sum.amount ?? 0)]),
    );

    for (const invoice of invoices) {
      const expected = allocationByInvoice.get(invoice.id) ?? new Decimal(0);
      if (!expected.equals(invoice.paidAmount)) {
        problems.push({
          kind: "invoice_paid",
          id: invoice.id,
          label: `${invoice.month} / student=${invoice.studentId}`,
          stored: formatAmount(invoice.paidAmount),
          expected: formatAmount(expected),
        });
      }
    }
  }

  // ── 4. Muhrlangan summa identiteti ────────
  // amount = proratedAmount − discountAmount, va proratedAmount <= baseAmount.
  //
  // Bu tekshiruv proratsiya bilan birga qo'shildi: summani ikkita mustaqil
  // joyda hisoblash xavfi paydo bo'ldi (oylik pass va qayta shakllantirish).
  // Bitta quruvchiga o'tkazilgan bo'lsa-da, invariantni tekshirib turish
  // drift'ni uch hafta keyin hisobotda emas, ertasi kuni topadi.
  const sealed = await prisma.monthlyInvoice.findMany({
    select: {
      id: true,
      month: true,
      studentId: true,
      amount: true,
      baseAmount: true,
      proratedAmount: true,
      discountAmount: true,
      billableDays: true,
      monthDays: true,
    },
  });

  for (const invoice of sealed) {
    const expected = new Decimal(invoice.proratedAmount).minus(invoice.discountAmount);
    if (!expected.equals(invoice.amount)) {
      problems.push({
        kind: "invoice_amount",
        id: invoice.id,
        label: `${invoice.month} / student=${invoice.studentId}`,
        stored: formatAmount(invoice.amount),
        expected: formatAmount(expected),
      });
    }

    if (new Decimal(invoice.proratedAmount).greaterThan(invoice.baseAmount)) {
      problems.push({
        kind: "invoice_prorated",
        id: invoice.id,
        label: `${invoice.month} / student=${invoice.studentId}`,
        stored: formatAmount(invoice.proratedAmount),
        expected: `<= ${formatAmount(invoice.baseAmount)}`,
      });
    }

    const days = invoice.billableDays;
    if (
      days != null &&
      (invoice.monthDays == null || days < 1 || days > invoice.monthDays)
    ) {
      problems.push({
        kind: "invoice_days",
        id: invoice.id,
        label: `${invoice.month} / student=${invoice.studentId}`,
        stored: `${days}/${invoice.monthDays}`,
        expected: "1..monthDays",
      });
    }

  }

  // ── 5 va 6. CHIQIM: oylik majburiyatlari ──
  // Kirim tomonidagi 3 va 4-invariantlarning ko'zgusi.
  const entries = await prisma.payrollEntry.findMany({
    select: {
      id: true,
      month: true,
      staffId: true,
      amount: true,
      paidAmount: true,
      baseAmount: true,
      hoursAmount: true,
    },
  });

  if (entries.length > 0) {
    const salarySums = await prisma.salaryAllocation.groupBy({
      by: ["payrollEntryId"],
      where: { isVoided: false },
      _sum: { amount: true },
    });
    const paidByEntry = new Map(
      salarySums.map((row) => [row.payrollEntryId, new Decimal(row._sum.amount ?? 0)]),
    );

    for (const entry of entries) {
      const label = `${entry.month} / staff=${entry.staffId}`;

      const expectedPaid = paidByEntry.get(entry.id) ?? new Decimal(0);
      if (!expectedPaid.equals(entry.paidAmount)) {
        problems.push({
          kind: "payroll_paid",
          id: entry.id,
          label,
          stored: formatAmount(entry.paidAmount),
          expected: formatAmount(expectedPaid),
        });
      }

      // `computeSalary()` uchala rejimda ham shu tenglikni beradi
      // (fixed → hoursAmount 0, hourly → baseAmount 0).
      const expectedAmount = new Decimal(entry.baseAmount).plus(entry.hoursAmount);
      if (!expectedAmount.equals(entry.amount)) {
        problems.push({
          kind: "payroll_amount",
          id: entry.id,
          label,
          stored: formatAmount(entry.amount),
          expected: formatAmount(expectedAmount),
        });
      }

      // Ortiqcha to'lov RAD ETILADI (avans yo'q) — qarz manfiy bo'lolmaydi
      if (new Decimal(entry.paidAmount).greaterThan(entry.amount)) {
        problems.push({
          kind: "payroll_overpaid",
          id: entry.id,
          label,
          stored: formatAmount(entry.paidAmount),
          expected: `<= ${formatAmount(entry.amount)}`,
        });
      }
    }
  }

  const checked = {
    accounts: accounts.length,
    studentAccounts: studentAccounts.length,
    invoices: invoices.length,
    sealed: sealed.length,
    payrollEntries: entries.length,
  };

  if (problems.length === 0) {
    logger.info(
      `${tag} Invariantlar joyida — ${checked.accounts} to'lov turi, ` +
        `${checked.studentAccounts} depozit, ${checked.sealed} hisob-faktura, ` +
        `${checked.payrollEntries} oylik majburiyati`,
    );
  } else {
    logger.error(
      `${tag} ⚠️ ${problems.length} ta nomuvofiqlik topildi ` +
        "(avtomatik TUZATILMAYDI — sababi tekshirilishi kerak)",
    );
    for (const problem of problems) {
      logger.error(
        `${tag} ${problem.kind}: ${problem.label} — ` +
          `saqlangan ${problem.stored}, kutilgan ${problem.expected}`,
      );
    }
  }

  return { checked, problems };
}

/**
 * Cron jobni belgilaydi. Har kuni 03:00 (Asia/Tashkent).
 */
function startFinanceReconcileCron() {
  cron.schedule(
    "0 3 * * *",
    branchCron("[FinanceReconcileCron]", async (branch) => {
      try {
        await runFinanceReconcilePass();
      } catch (error) {
        logger.error(`[FinanceReconcile] ${branch.name}: cron xatosi`, error);
      }
    }),
    { scheduled: true, timezone: "Asia/Tashkent" },
  );

  logger.info(
    "Moliyaviy tekshiruv cron job belgilandi: Har kuni 03:00 (Asia/Tashkent)",
  );
}

module.exports = { startFinanceReconcileCron, runFinanceReconcilePass };
