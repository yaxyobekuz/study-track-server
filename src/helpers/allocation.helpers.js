/**
 * To'lovni hisob-fakturalarga taqsimlash — SOF hisob, DB'siz.
 *
 * Kassir bitta summa kiritadi ("Ali Valiyev, 1 500 000 so'm"), tizim uni eng
 * ESKI qarzdan boshlab yopadi. Ortib qolgani depozit bo'lib qoladi.
 *
 * Alohida faylda, chunki chaqiruvchisi ikkita: kassirning to'lovi
 * (`payment.service.js`) va depozitni qo'llash (`studentAccount.service.js`).
 * Ikkalasi bir xil qoida bo'yicha ishlashi SHART — aks holda "kassir
 * to'lagani boshqa oyga, depozitdan yechilgani boshqa oyga tushdi" degan
 * tushuntirib bo'lmas holat chiqadi.
 *
 * ═════════════════════════════════════════════
 * LOCK TARTIBI — BUTUN MOLIYA MODULIDA O'ZGARMAS
 *
 *     StudentAccount  →  MonthlyInvoice (month asc, id asc)  →  PaymentAccount
 *
 * Pulga tegadigan HAR QANDAY tranzaksiyaning BIRINCHI operatori:
 *     tx.studentAccount.update({ where: { studentId }, data: { version: { increment: 1 } } })
 * `UPDATE` commit'gacha eksklyuziv row-lock oladi. O'quvchilar bir-biri bilan
 * hech qachon to'qnashmaydi, shuning uchun deadlock imkonsiz.
 *
 * Kassa yozuvi HAR DOIM oxirgi. Ikki hisob orasidagi o'tkazmada esa hisoblar
 * `id` bo'yicha O'SISH tartibida lock qilinadi — yo'nalishdan qat'i nazar.
 * ═════════════════════════════════════════════
 */

const { Decimal, sumAmounts } = require("./money.helpers");
const { InternalServerError } = require("../utils/errors");

/**
 * Hisob-faktura holati `paidAmount` DAN KELIB CHIQADI, hech qachon qo'lda
 * qo'yilmaydi. Yagona manba shu funksiya.
 *
 * @param {Prisma.Decimal} amount
 * @param {Prisma.Decimal} paidAmount
 * @returns {"unpaid"|"partial"|"paid"}
 */
function deriveStatus(amount, paidAmount) {
  if (paidAmount.lessThanOrEqualTo(0)) return "unpaid";
  if (paidAmount.greaterThanOrEqualTo(amount)) return "paid";
  return "partial";
}

/**
 * FIFO taqsimot.
 *
 * `invoices` CHAQIRUVCHI tomonidan `[month asc, id asc]` bo'yicha
 * tartiblangan holda kelishi kerak — bu ham eng eski qarz birinchi
 * yopilishini, ham lock tartibini determinlashtiradi.
 *
 * @param {Array<{id: string, amount: any, paidAmount: any, month: number}>} invoices
 * @param {Prisma.Decimal} amount - taqsimlanadigan summa (musbat)
 * @param {Date} appliedAt
 * @returns {{
 *   allocations: Array<{invoiceId, month, amount, previousPaidAmount, newPaidAmount, status, paidAt}>,
 *   allocated: Prisma.Decimal,
 *   remainder: Prisma.Decimal
 * }}
 */
function allocateFifo(invoices, amount, appliedAt) {
  let rest = amount;
  const allocations = [];

  for (const invoice of invoices) {
    if (rest.lessThanOrEqualTo(0)) break;

    const invoiceAmount = new Decimal(invoice.amount);
    const previousPaid = new Decimal(invoice.paidAmount);
    const remaining = invoiceAmount.minus(previousPaid);

    // 0 so'mlik grant tarifi allaqachon `paid`, bu yerda himoya qavati
    if (remaining.lessThanOrEqualTo(0)) continue;

    const take = Decimal.min(remaining, rest);
    const newPaid = previousPaid.plus(take);
    const status = deriveStatus(invoiceAmount, newPaid);

    allocations.push({
      invoiceId: invoice.id,
      month: invoice.month,
      amount: take,
      previousPaidAmount: previousPaid,
      newPaidAmount: newPaid,
      status,
      // `new Date()` EMAS: orqaga sanalgan to'lov hisob-fakturani O'Z
      // kunida yopishi kerak, kiritilgan kunda emas.
      paidAt: status === "paid" ? (invoice.paidAt ?? appliedAt) : null,
    });

    rest = rest.minus(take);
  }

  const allocated = sumAmounts(allocations.map((a) => a.amount));

  // Jim yo'qotish bo'lmasin: kelajakdagi refaktor xatosini baland
  // xatolikka aylantiradi. Decimal ayirmasi 2 xonada aniq, shuning uchun
  // bu tenglik har doim bajarilishi kerak.
  if (!allocated.plus(rest).equals(amount)) {
    throw new InternalServerError(
      `Taqsimot summasi to'lovga teng emas: ${allocated.toFixed(2)} + ${rest.toFixed(2)} ≠ ${amount.toFixed(2)}`,
    );
  }

  return { allocations, allocated, remainder: rest };
}

module.exports = {
  deriveStatus,
  allocateFifo,
};
