/**
 * O'quvchining oldindan to'langan qoldig'i (depozit).
 *
 * DEPOZIT ALOHIDA JADVAL EMAS. `StudentAccount.balance` — bu shunchaki
 *
 *     Σ payment.amount − Σ allocation − Σ refund + Σ adjustment
 *
 * ning tezlik uchun saqlangan nusxasi. Harakatlar tarixi ham alohida
 * "ledger" jadvalidan emas, AYNAN shu qatorlardan tuziladi — ikki nusxa
 * bo'lsa ular bir kun kelib bir-biriga mos kelmay qolardi va o'quvchi
 * o'z to'lovlariga mos kelmaydigan balansni ko'rardi.
 *
 * `version` — LOCK USTUNI: pulga tegadigan har bir tranzaksiyaning birinchi
 * operatori. Lock tartibi — `helpers/allocation.helpers.js` sarlavhasida.
 */

const prisma = require("../config/prisma");
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
} = require("../utils/errors");
const logger = require("../utils/logger");
const {
  Decimal,
  parseAmount,
  parseSignedAmount,
  formatAmount,
  sumAmounts,
} = require("../helpers/money.helpers");
const { allocateFifo } = require("../helpers/allocation.helpers");
const { formatMonthKey } = require("../helpers/month.helpers");
const { postEntry, assertActiveAccount } = require("./paymentAccount.service");
const { TX_OPTIONS, ensureStudentAccount } = require("./payment.service");

const MOVEMENT_LABELS = {
  payment: "To'lov qabul qilindi",
  allocation: "Hisob-fakturaga yechildi",
  refund: "Qaytarildi",
  adjustment: "Qo'lda to'g'rilash",
};

/**
 * O'quvchining joriy qoldig'i (qator bo'lmasa — 0).
 * @param {string} studentId
 * @returns {Promise<Prisma.Decimal>}
 */
const getBalance = async (studentId) => {
  const account = await prisma.studentAccount.findUnique({ where: { studentId } });
  return new Decimal(account?.balance ?? 0);
};

/**
 * Ko'p o'quvchining qoldig'i — bitta so'rov (registr ekranidagi ustun uchun).
 * @param {string[]} studentIds
 * @returns {Promise<Map<string, Prisma.Decimal>>}
 */
const getBalances = async (studentIds = []) => {
  if (studentIds.length === 0) return new Map();

  const rows = await prisma.studentAccount.findMany({
    where: { studentId: { in: studentIds } },
    select: { studentId: true, balance: true },
  });

  return new Map(rows.map((r) => [r.studentId, new Decimal(r.balance)]));
};

// ─────────────────────────────────────────────
// Depozitni qo'llash
// ─────────────────────────────────────────────

/**
 * O'quvchining qoldig'ini ochiq hisob-fakturalarga qo'llaydi.
 *
 * MUSTAQIL VA IDEMPOTENT: sharti faqat "qoldiq > 0 va ochiq hisob-faktura
 * bor". Ikki marta ishlashi zararsiz — ikkinchisi hech narsa topmaydi.
 * Shuning uchun uni generatsiya ham, cron ham, admin tugmasi ham bir xil
 * chaqira oladi.
 *
 * ⚠️ Bu yerda KASSA YOZUVI YOZILMAYDI. Pul kassaga to'lov qabul qilinganda
 * kirgan; bu faqat ICHKI taqsimot. Yozilsa daromad ikki marta hisoblanardi.
 *
 * Pul ham FIFO sarflanadi (eng eski to'lovning qoldig'i birinchi), shunda
 * to'lovni bekor qilish natijasi oldindan aytiladigan bo'ladi.
 *
 * @param {string} studentId
 * @returns {Promise<{applied: string, allocations: object[]}>}
 */
const applyDepositsForStudent = async (studentId) => {
  await ensureStudentAccount(studentId);

  return prisma.$transaction(async (tx) => {
    // 1 ── LOCK
    const account = await tx.studentAccount.update({
      where: { studentId },
      data: { version: { increment: 1 } },
    });

    const balance = new Decimal(account.balance);
    if (balance.lessThanOrEqualTo(0)) return { applied: "0.00", allocations: [] };

    // 2 ── Ochiq hisob-fakturalar (lock ostida)
    const invoices = await tx.monthlyInvoice.findMany({
      where: { studentId, status: { in: ["unpaid", "partial"] } },
      orderBy: [{ month: "asc" }, { id: "asc" }],
    });
    if (invoices.length === 0) return { applied: "0.00", allocations: [] };

    const appliedAt = new Date();
    const { allocations, allocated } = allocateFifo(invoices, balance, appliedAt);
    if (allocations.length === 0) return { applied: "0.00", allocations: [] };

    // 3 ── Pul manbai: qoldig'i bor to'lovlar, eng eskisidan
    const payments = await tx.payment.findMany({
      where: { studentId, isVoided: false, depositAmount: { gt: 0 } },
      orderBy: [{ paidAt: "asc" }, { receiptNo: "asc" }],
    });

    const available = sumAmounts(payments.map((p) => p.depositAmount));
    if (available.lessThan(allocated)) {
      // Balans va to'lov qoldiqlari bir-biriga mos emas — reconciler ishi
      throw new ConflictError(
        "Depozit qoldig'i to'lovlar bilan mos kelmadi. Moliya bo'limiga murojaat qiling.",
      );
    }

    // 4 ── Ikki ko'rsatkichli yurish: to'lov qoldig'i → hisob-faktura ulushi
    const rows = [];
    const spentByPayment = new Map();
    let paymentIndex = 0;
    let paymentLeft = new Decimal(payments[0]?.depositAmount ?? 0);

    for (const allocation of allocations) {
      let need = allocation.amount;

      while (need.greaterThan(0)) {
        while (paymentLeft.lessThanOrEqualTo(0)) {
          paymentIndex += 1;
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

    // 5 ── Hisob-fakturalar: COMPARE-AND-SWAP
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

    // 6 ── To'lovlarning hosila summalari
    for (const [paymentId, spent] of spentByPayment) {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          allocatedAmount: { increment: spent },
          depositAmount: { decrement: spent },
        },
      });
    }

    // 7 ── Qoldiqni kamaytirish (kassaga TEGILMAYDI)
    await tx.studentAccount.update({
      where: { studentId },
      data: { balance: { decrement: allocated } },
    });

    return {
      applied: formatAmount(allocated),
      allocations: allocations.map((a) => ({
        invoiceId: a.invoiceId,
        month: a.month,
        monthLabel: formatMonthKey(a.month),
        amount: formatAmount(a.amount),
        status: a.status,
      })),
    };
  }, TX_OPTIONS);
};

/**
 * Ko'p o'quvchi uchun depozitni qo'llash — generatsiyadan keyin chaqiriladi.
 *
 * Har o'quvchi uchun ALOHIDA tranzaksiya: bitta o'quvchidagi poyga butun
 * passni to'xtatmasligi kerak. Faqat qoldig'i bor o'quvchilar tegiladi.
 *
 * @param {string[]} [studentIds] - berilmasa qoldig'i bor hammasi
 * @returns {Promise<{students: number, applied: string, failed: object[]}>}
 */
const applyDepositsForStudents = async (studentIds) => {
  const accounts = await prisma.studentAccount.findMany({
    where: {
      balance: { gt: 0 },
      ...(studentIds?.length ? { studentId: { in: studentIds } } : {}),
    },
    select: { studentId: true },
  });

  let applied = new Decimal(0);
  let touched = 0;
  const failed = [];

  for (const { studentId } of accounts) {
    try {
      const result = await applyDepositsForStudent(studentId);
      const amount = new Decimal(result.applied);
      if (amount.greaterThan(0)) {
        applied = applied.plus(amount);
        touched += 1;
      }
    } catch (error) {
      logger.error(
        `[deposit] Depozitni qo'llash muvaffaqiyatsiz: student=${studentId} — ${error.message}`,
      );
      failed.push({ studentId, reason: error.message });
    }
  }

  return { students: touched, applied: formatAmount(applied), failed };
};

/**
 * Hisob-faktura bekor qilinganda uning taqsimotlarini bo'shatadi va pulni
 * depozitga qaytaradi.
 *
 * "O'quvchi martda ketdi, mayga qadar to'lab qo'ygan edi" — ODATIY hol,
 * chekka emas. To'lovni bekor qilish noto'g'ri javob bo'lardi: pul haqiqatan
 * ham olingan.
 *
 * CHAQIRUVCHI tranzaksiya ichida va StudentAccount lock'i OLINGANDAN KEYIN
 * chaqirishi shart.
 *
 * @param {object} tx
 * @param {object} invoice - xom qator
 * @returns {Promise<Prisma.Decimal>} depozitga qaytarilgan summa
 */
const releaseInvoiceAllocations = async (tx, invoice) => {
  const allocations = await tx.paymentAllocation.findMany({
    where: { invoiceId: invoice.id, isVoided: false },
  });

  if (allocations.length === 0) return new Decimal(0);

  const total = sumAmounts(allocations.map((a) => a.amount));

  await tx.paymentAllocation.updateMany({
    where: { invoiceId: invoice.id, isVoided: false },
    data: { isVoided: true, voidedAt: new Date() },
  });

  // To'lovlarning qoldig'i tiklanadi — pul yana depozitga aylanadi
  const byPayment = new Map();
  for (const allocation of allocations) {
    byPayment.set(
      allocation.paymentId,
      (byPayment.get(allocation.paymentId) ?? new Decimal(0)).plus(allocation.amount),
    );
  }

  for (const [paymentId, amount] of byPayment) {
    await tx.payment.update({
      where: { id: paymentId },
      data: {
        allocatedAmount: { decrement: amount },
        depositAmount: { increment: amount },
      },
    });
  }

  const updated = await tx.monthlyInvoice.updateMany({
    where: { id: invoice.id, paidAmount: invoice.paidAmount },
    data: { paidAmount: 0, paidAt: null },
  });
  if (updated.count !== 1) {
    throw new ConflictError("Hisob-faktura holati o'zgardi. Qayta urinib ko'ring.");
  }

  await tx.studentAccount.update({
    where: { studentId: invoice.studentId },
    data: { balance: { increment: total } },
  });

  return total;
};

// ─────────────────────────────────────────────
// Qaytarish va to'g'rilash
// ─────────────────────────────────────────────

/**
 * Depozitni ota-onaga qaytaradi — pul kassadan chiqadi.
 *
 * @param {string} studentId
 * @param {object} data - { amount, accountId, reason, refundedAt }
 * @param {string} userId
 * @returns {Promise<object>}
 */
const refundDeposit = async (studentId, data, userId) => {
  const amount = parseAmount(data.amount, "Qaytarish summasi");
  if (amount.lessThanOrEqualTo(0)) {
    throw new BadRequestError("Qaytarish summasi noldan katta bo'lishi kerak");
  }

  const reason = data.reason?.trim();
  if (!reason) throw new BadRequestError("Qaytarish sababi majburiy");

  const account = await assertActiveAccount(data.accountId);
  const refundedAt = data.refundedAt ? new Date(data.refundedAt) : new Date();
  if (Number.isNaN(refundedAt.getTime())) throw new BadRequestError("Sana noto'g'ri");

  await ensureStudentAccount(studentId);

  logger.warn(
    `[deposit] Depozit qaytarildi: student=${studentId} summa=${amount.toFixed(2)} ` +
      `hisob=${account.name} actor=${userId} sabab="${reason}"`,
  );

  const refund = await prisma.$transaction(async (tx) => {
    // 1 ── LOCK
    const studentAccount = await tx.studentAccount.update({
      where: { studentId },
      data: { version: { increment: 1 } },
    });

    const balance = new Decimal(studentAccount.balance);
    if (amount.greaterThan(balance)) {
      throw new BadRequestError(
        `Depozitda ${formatAmount(balance)} so'm bor — bundan ko'pini qaytarib bo'lmaydi`,
      );
    }

    const created = await tx.refund.create({
      data: {
        studentId,
        accountId: account.id,
        amount,
        reason,
        refundedAt,
        createdBy: userId,
      },
    });

    // To'lovlarning qoldig'i eng ESKIsidan yeyiladi (FIFO — bekor qilish
    // xatti-harakati oldindan aytiladigan bo'lishi uchun)
    const payments = await tx.payment.findMany({
      where: { studentId, isVoided: false, depositAmount: { gt: 0 } },
      orderBy: [{ paidAt: "asc" }, { receiptNo: "asc" }],
    });

    let rest = amount;
    for (const payment of payments) {
      if (rest.lessThanOrEqualTo(0)) break;
      const take = Decimal.min(new Decimal(payment.depositAmount), rest);
      await tx.payment.update({
        where: { id: payment.id },
        data: { depositAmount: { decrement: take } },
      });
      rest = rest.minus(take);
    }

    await tx.studentAccount.update({
      where: { studentId },
      data: { balance: { decrement: amount } },
    });

    // 2 ── KASSA — oxirgi
    await postEntry(tx, {
      accountId: account.id,
      type: "refund",
      amount: amount.negated(),
      occurredAt: refundedAt,
      refundId: created.id,
      note: reason,
      createdBy: userId,
    });

    return created;
  }, TX_OPTIONS);

  return {
    ...refund,
    amount: formatAmount(refund.amount),
    balance: formatAmount(await getBalance(studentId)),
  };
};

/**
 * Qoldiqni qo'lda to'g'rilash — eski qarzni ko'chirish, sanoq farqi.
 *
 * Kassaga TEGILMAYDI: bu pul harakati emas, hisob tuzatishi. Kassa
 * qoldig'ini to'g'rilash uchun `paymentAccount.adjustBalance` bor.
 *
 * @param {string} studentId
 * @param {object} data - { amount (ishorali), reason }
 * @param {string} userId
 * @returns {Promise<object>}
 */
const adjustBalance = async (studentId, data, userId) => {
  const amount = parseSignedAmount(data.amount, "To'g'rilash summasi");
  if (amount.isZero()) {
    throw new BadRequestError("To'g'rilash summasi nol bo'lishi mumkin emas");
  }

  const reason = data.reason?.trim();
  if (!reason) throw new BadRequestError("To'g'rilash sababi majburiy");

  await ensureStudentAccount(studentId);

  logger.warn(
    `[deposit] Qoldiq qo'lda to'g'rilandi: student=${studentId} ` +
      `summa=${amount.toFixed(2)} actor=${userId} sabab="${reason}"`,
  );

  const row = await prisma.$transaction(async (tx) => {
    const account = await tx.studentAccount.update({
      where: { studentId },
      data: { version: { increment: 1 } },
    });

    const next = new Decimal(account.balance).plus(amount);
    if (next.isNegative()) {
      throw new BadRequestError(
        `Qoldiq manfiy bo'lib qoladi (${formatAmount(account.balance)} + ${formatAmount(amount)})`,
      );
    }

    const created = await tx.studentBalanceAdjustment.create({
      data: { studentId, amount, reason, createdBy: userId },
    });

    await tx.studentAccount.update({
      where: { studentId },
      data: { balance: next },
    });

    return created;
  }, TX_OPTIONS);

  return {
    ...row,
    amount: formatAmount(row.amount),
    balance: formatAmount(await getBalance(studentId)),
  };
};

// ─────────────────────────────────────────────
// Harakatlar tarixi (HOSILA)
// ─────────────────────────────────────────────

/**
 * Depozit harakatlari — alohida jadvaldan emas, haqiqiy qatorlardan.
 *
 * Manbalar: to'lovlar (+), taqsimotlar (−), qaytarishlar (−),
 * qo'lda to'g'rilashlar (±). O'quv yiliga ~50 qator, shuning uchun
 * to'rttasi ham to'liq o'qilib xotirada birlashtiriladi
 * (`getStudentInvoices` bilan bir xil yondashuv).
 *
 * @param {string} studentId
 * @returns {Promise<object>}
 */
const getMovements = async (studentId) => {
  const [account, payments, allocations, refunds, adjustments] = await Promise.all([
    prisma.studentAccount.findUnique({ where: { studentId } }),
    prisma.payment.findMany({
      where: { studentId, isVoided: false },
      select: { id: true, amount: true, paidAt: true, receiptNo: true, note: true },
    }),
    prisma.paymentAllocation.findMany({
      where: { studentId, isVoided: false },
      select: { id: true, amount: true, appliedAt: true, invoiceId: true, source: true },
    }),
    prisma.refund.findMany({
      where: { studentId, isVoided: false },
      select: { id: true, amount: true, refundedAt: true, reason: true },
    }),
    prisma.studentBalanceAdjustment.findMany({
      where: { studentId },
      select: { id: true, amount: true, createdAt: true, reason: true },
    }),
  ]);

  const invoiceIds = [...new Set(allocations.map((a) => a.invoiceId))];
  const invoices = invoiceIds.length
    ? await prisma.monthlyInvoice.findMany({
        where: { id: { in: invoiceIds } },
        select: { id: true, month: true },
      })
    : [];
  const monthById = new Map(invoices.map((i) => [i.id, i.month]));

  const items = [
    ...payments.map((p) => ({
      id: `payment:${p.id}`,
      type: "payment",
      amount: formatAmount(p.amount),
      direction: "in",
      occurredAt: p.paidAt,
      label: MOVEMENT_LABELS.payment,
      description: `Chek #${String(p.receiptNo).padStart(6, "0")}`,
      note: p.note,
    })),
    ...allocations.map((a) => {
      const month = monthById.get(a.invoiceId);
      return {
        id: `allocation:${a.id}`,
        type: "allocation",
        amount: formatAmount(a.amount),
        direction: "out",
        occurredAt: a.appliedAt,
        label: MOVEMENT_LABELS.allocation,
        description: month != null ? formatMonthKey(month) : "",
        source: a.source,
      };
    }),
    ...refunds.map((r) => ({
      id: `refund:${r.id}`,
      type: "refund",
      amount: formatAmount(r.amount),
      direction: "out",
      occurredAt: r.refundedAt,
      label: MOVEMENT_LABELS.refund,
      description: r.reason,
    })),
    ...adjustments.map((a) => ({
      id: `adjustment:${a.id}`,
      type: "adjustment",
      amount: formatAmount(new Decimal(a.amount).abs()),
      direction: new Decimal(a.amount).isNegative() ? "out" : "in",
      occurredAt: a.createdAt,
      label: MOVEMENT_LABELS.adjustment,
      description: a.reason,
    })),
  ].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));

  return {
    studentId,
    balance: formatAmount(new Decimal(account?.balance ?? 0)),
    items,
  };
};

/**
 * O'quvchining depozit holati — kartaga chiqadigan yig'ma.
 * @param {string} studentId
 * @returns {Promise<object>}
 */
const getStudentAccount = async (studentId) => {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, firstName: true, lastName: true, username: true },
  });
  if (!student) throw new NotFoundError("O'quvchi topilmadi");

  const [account, openDebt] = await Promise.all([
    prisma.studentAccount.findUnique({ where: { studentId } }),
    prisma.monthlyInvoice.aggregate({
      where: { studentId, status: { in: ["unpaid", "partial"] } },
      _sum: { amount: true, paidAmount: true },
    }),
  ]);

  const debt = new Decimal(openDebt._sum.amount ?? 0).minus(openDebt._sum.paidAmount ?? 0);

  return {
    student,
    balance: formatAmount(new Decimal(account?.balance ?? 0)),
    debt: formatAmount(debt.isNegative() ? new Decimal(0) : debt),
  };
};

module.exports = {
  MOVEMENT_LABELS,
  getBalance,
  getBalances,
  applyDepositsForStudent,
  applyDepositsForStudents,
  releaseInvoiceAllocations,
  refundDeposit,
  adjustBalance,
  getMovements,
  getStudentAccount,
};
