/**
 * DEPOZITNI OCHIQ QARZGA YECHISH — tranzaksiya ichidagi YAGONA yadro.
 *
 * Qoida bitta jumlada: **qarz va depozit birga turmaydi.** O'quvchi depozitida
 * pul bo'lib, ochiq (to'lanmagan / qisman) oyi ham bo'lsa, pul eng eski oydan
 * boshlab darhol yechiladi. 14 mln oldindan to'lab qo'ygan o'quvchining har
 * oylik majburiyati shu tufayli o'z-o'zidan yopiladi.
 *
 * ── NIMA UCHUN ALOHIDA FAYL VA NIMA UCHUN `tx` ICHIDA ──
 * Ilgari depozit faqat oylik pass YANGI qator yozganda qo'llanardi. Qolgan
 * yo'llar — to'lovni bekor qilish (boshqa chekning depoziti qayta ochilgan
 * oyga tushmasdi), hisob-fakturani bekor qilish, bekordan tiklash, qayta
 * shakllantirish, summa oshishi — depozitni ochiq qarz yonida qoldirib
 * ketardi. Endi HAR BIR pul amali o'z tranzaksiyasi oxirida shu funksiyani
 * chaqiradi: "yechish" amalning o'zi bilan ATOMAR, oraliq holat yo'q.
 * `payment.service` va `studentAccount.service` bir-biriga bog'liq bo'lgani
 * uchun yadro ikkalasidan ham tashqarida turadi (aylanma `require` bo'lmasin).
 *
 * ⚠️ CHAQIRUVCHI `StudentAccount` LOCK'INI OLGAN BO'LISHI SHART va
 * `PaymentAccount` ga hali tegmagan bo'lishi kerak (lock tartibi:
 * StudentAccount → MonthlyInvoice → PaymentAccount). Bu yerda daftar yozuvi
 * YO'Q: pul kassaga to'lov qabul qilinganda kirgan, bu faqat ichki taqsimot.
 *
 * ⚠️ `depositHold` — admin shu oydan yechimni qo'lda olib qo'ygan. Avtomat
 * yechish bunday oyni o'tkazib yuboradi, aks holda o'chirilgan yechim darhol
 * qaytib kelardi. Qo'lda qo'llash (`manual`) esa belgini tozalab, hammasini
 * qamraydi.
 */

const { ConflictError } = require("../utils/errors");
const { Decimal, sumAmounts, formatAmount } = require("../helpers/money.helpers");
const { allocateFifo } = require("../helpers/allocation.helpers");
const { formatMonthKey } = require("../helpers/month.helpers");

const EMPTY = Object.freeze({ applied: new Decimal(0), allocations: [] });

/**
 * O'quvchining depozitini ochiq hisob-fakturalarga FIFO bilan yechadi.
 *
 * @param {object} tx - Prisma tranzaksiya klienti (StudentAccount lock'i olingan)
 * @param {string} studentId
 * @param {object} [options]
 * @param {boolean} [options.manual=false] - qo'lda qo'llash: `depositAutoApply`
 *   sozlamasiga qaramaydi, `depositHold` belgilarini tozalaydi
 * @param {string[]} [options.ignoreHoldFor=[]] - belgisi bo'lsa ham qamraladigan
 *   hisob-fakturalar (o'z pulini qaytarib olgan faktura, `amendPaidInvoice`)
 * @param {Date} [options.appliedAt=new Date()]
 * @returns {Promise<{applied: Prisma.Decimal, allocations: object[]}>}
 */
const settleDepositInTx = async (
  tx,
  studentId,
  { manual = false, ignoreHoldFor = [], appliedAt = new Date() } = {},
) => {
  if (manual) {
    // Qo'lda qo'llash — adminning ochiq qarori: to'xtatilgan oylar yana
    // umumiy qoidaga qaytadi (depozit bo'sh bo'lsa ham — belgi osilib qolmasin)
    await tx.monthlyInvoice.updateMany({
      where: { studentId, depositHold: true },
      data: { depositHold: false },
    });
  } else {
    // Singleton qatori bo'lmasa — sxema sukuti (`true`)
    const settings = await tx.financeSettings.findFirst({
      select: { depositAutoApply: true },
    });
    if (settings && !settings.depositAutoApply) return EMPTY;
  }

  const account = await tx.studentAccount.findUnique({ where: { studentId } });
  const balance = new Decimal(account?.balance ?? 0);
  if (balance.lessThanOrEqualTo(0)) return EMPTY;

  // Pul manbai: qoldig'i bor cheklar, eng ESKIsidan (bekor qilish natijasi
  // oldindan aytiladigan bo'lsin)
  const payments = await tx.payment.findMany({
    where: { studentId, isVoided: false, depositAmount: { gt: 0 } },
    orderBy: [{ paidAt: "asc" }, { receiptNo: "asc" }],
  });

  // ⚠️ BYUDJET = min(balans, cheklar qoldig'i). Balansga qo'lda to'g'rilash
  // (`adjustBalance`) ham kiradi, lekin taqsimot qatori chekka bog'lanishi
  // SHART — chekka bog'lanmagan pulni yechib bo'lmaydi. Ilgari bu farq
  // `ConflictError` bilan BUTUN yechishni to'xtatardi: +100 000 to'g'rilashi
  // bor o'quvchining depoziti hech qachon qarzga tushmasdi.
  const available = sumAmounts(payments.map((p) => p.depositAmount));
  const budget = Decimal.min(balance, available);
  if (budget.lessThanOrEqualTo(0)) return EMPTY;

  const holdFilter = manual
    ? {}
    : ignoreHoldFor.length > 0
      ? { OR: [{ depositHold: false }, { id: { in: ignoreHoldFor } }] }
      : { depositHold: false };

  const invoices = await tx.monthlyInvoice.findMany({
    where: { studentId, status: { in: ["unpaid", "partial"] }, ...holdFilter },
    orderBy: [{ month: "asc" }, { id: "asc" }],
  });
  if (invoices.length === 0) return EMPTY;

  const { allocations, allocated } = allocateFifo(invoices, budget, appliedAt);
  if (allocations.length === 0) return EMPTY;

  // ── Ikki ko'rsatkichli yurish: chek qoldig'i → oy ulushi ──
  const rows = [];
  const spentByPayment = new Map();
  let paymentIndex = 0;
  let paymentLeft = new Decimal(payments[0].depositAmount);

  for (const allocation of allocations) {
    let need = allocation.amount;

    while (need.greaterThan(0)) {
      while (paymentLeft.lessThanOrEqualTo(0)) {
        paymentIndex += 1;
        // `budget <= available` buni imkonsiz qiladi — lekin ro'yxatdan
        // chiqib ketish TypeError bo'lmasin, pul xatosi tushunarli bo'lsin
        if (paymentIndex >= payments.length) {
          throw new ConflictError(
            "Depozit qoldig'i to'lovlar bilan mos kelmadi. Moliya bo'limiga murojaat qiling.",
          );
        }
        paymentLeft = new Decimal(payments[paymentIndex].depositAmount);
      }

      const take = Decimal.min(need, paymentLeft);
      const payment = payments[paymentIndex];

      rows.push({
        paymentId: payment.id,
        invoiceId: allocation.invoiceId,
        studentId,
        amount: take,
        source: "deposit",
        appliedAt,
      });

      spentByPayment.set(
        payment.id,
        (spentByPayment.get(payment.id) ?? new Decimal(0)).plus(take),
      );

      need = need.minus(take);
      paymentLeft = paymentLeft.minus(take);
    }
  }

  await tx.paymentAllocation.createMany({ data: rows });

  // ── Hisob-fakturalar: COMPARE-AND-SWAP (month asc, id asc) ──
  for (const allocation of allocations) {
    const updated = await tx.monthlyInvoice.updateMany({
      where: {
        id: allocation.invoiceId,
        paidAmount: allocation.previousPaidAmount,
        status: { in: ["unpaid", "partial"] },
      },
      data: {
        paidAmount: allocation.newPaidAmount,
        status: allocation.status,
        paidAt: allocation.paidAt,
      },
    });

    if (updated.count !== 1) {
      throw new ConflictError("Hisob-faktura holati o'zgardi. Qayta urinib ko'ring.");
    }
  }

  // ── Cheklarning hosila summalari ──
  for (const [paymentId, spent] of spentByPayment) {
    await tx.payment.update({
      where: { id: paymentId },
      data: {
        allocatedAmount: { increment: spent },
        depositAmount: { decrement: spent },
      },
    });
  }

  // ── Qoldiq (to'lov turiga TEGILMAYDI) ──
  await tx.studentAccount.update({
    where: { studentId },
    data: { balance: { decrement: allocated } },
  });

  return {
    applied: allocated,
    allocations: allocations.map((a) => ({
      invoiceId: a.invoiceId,
      month: a.month,
      monthLabel: formatMonthKey(a.month),
      amount: formatAmount(a.amount),
      status: a.status,
    })),
  };
};

module.exports = { settleDepositInTx };
