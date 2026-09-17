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
const { deriveStatus } = require("../helpers/allocation.helpers");
const {
  formatMonthKey,
  parseRecordedAt,
} = require("../helpers/month.helpers");
const { postEntry, assertActiveAccount } = require("./paymentAccount.service");
const {
  TX_OPTIONS,
  SOURCE_LABELS,
  ensureStudentAccount,
} = require("./payment.service");
const { settleDepositInTx } = require("./depositSettlement.service");

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
 * Hisobning o'zi `depositSettlement.service.js` da — pul amallari uni o'z
 * tranzaksiyasi ichida chaqiradi, bu esa tashqaridan (cron, admin tugmasi)
 * chaqirish uchun lock'li o'ram.
 *
 * ⚠️ Bu yerda DAFTAR YOZUVI YOZILMAYDI. Pul to'lov turiga qabul qilinganda
 * kirgan; bu faqat ICHKI taqsimot. Yozilsa daromad ikki marta hisoblanardi.
 *
 * @param {string} studentId
 * @param {{manual?: boolean}} [options] - `manual` — admin tugmasi: sozlamaga
 *   qaramaydi va "avtomat yechish to'xtatilgan" oylarni ham qamraydi
 * @returns {Promise<{applied: string, allocations: object[]}>}
 */
const applyDepositsForStudent = async (studentId, { manual = false } = {}) => {
  await ensureStudentAccount(studentId);

  const result = await prisma.$transaction(async (tx) => {
    // LOCK — hisobdan OLDIN
    await tx.studentAccount.update({
      where: { studentId },
      data: { version: { increment: 1 } },
    });

    return settleDepositInTx(tx, studentId, { manual });
  }, TX_OPTIONS);

  return { applied: formatAmount(result.applied), allocations: result.allocations };
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
// Yechimni qo'lda o'zgartirish ("Hisob-fakturaga yechildi" qatori)
// ─────────────────────────────────────────────

/**
 * Bitta yechimni (chekning bitta oyga tushgan ulushini) qo'lda o'zgartiradi:
 * summasini KAMAYTIRADI, boshqa ochiq oyga KO'CHIRADI yoki butunlay OLIB
 * TASHLAYDI (`amount = 0`).
 *
 * ── NIMA BO'LADI ──
 *  - Eski qator bekor qilinadi (sabab + aktyor), kerak bo'lsa yangi summa /
 *    yangi oy bilan O'SHA chekka, O'SHA manba va sana bilan yangi qator
 *    yoziladi. Taqsimot tarixi o'chirilmaydi.
 *  - Oydan olingan, lekin boshqa oyga ko'chirilmagan pul (`released`) chekning
 *    depozit qoldig'iga qaytadi va oyga `depositHold` belgisi qo'yiladi.
 *  - Tranzaksiya oxirida depozit BOSHQA ochiq qarzlarga avtomat yechiladi;
 *    qolgani depozitda turadi.
 *
 * ⚠️ `depositHold` NIMA UCHUN: avtomat qoida ("qarz va depozit birga
 * turmaydi") pulni darhol o'sha oyga qaytarib yechardi — o'chirish hech
 * narsani o'zgartirmagandek ko'rinardi. Belgi faqat DEPOZITGA ta'sir qiladi,
 * "Qarzlarga qo'llash" tugmasi uni tozalaydi.
 *
 * ⚠️ Pul kassaga kirmaydi ham, chiqmaydi ham — DAFTAR YOZUVI YO'Q. Shuning
 * uchun ruxsat `finance.adjust` ("amaldagi yozuvni to'g'rilash").
 *
 * @param {string} allocationId
 * @param {object} params
 * @param {Prisma.Decimal} params.amount - yangi summa, 0..joriy
 * @param {string|null} params.targetInvoiceId - boshqa oyga ko'chirish (yoki null)
 * @param {string} params.reason
 * @param {string} params.userId
 * @returns {Promise<object>}
 */
const reworkAllocation = async (allocationId, { amount, targetInvoiceId, reason, userId }) => {
  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError("Sabab majburiy");

  const allocation = await prisma.paymentAllocation.findUnique({
    where: { id: allocationId },
  });
  if (!allocation) throw new NotFoundError("Yechim topilmadi");
  if (allocation.isVoided) {
    throw new BadRequestError("Bu yechim allaqachon bekor qilingan — sahifani yangilang");
  }

  const { studentId } = allocation;
  await ensureStudentAccount(studentId);

  const result = await prisma.$transaction(async (tx) => {
    // 1 ── LOCK
    await tx.studentAccount.update({
      where: { studentId },
      data: { version: { increment: 1 } },
    });

    // 2 ── Lock ostida qayta o'qish
    const fresh = await tx.paymentAllocation.findUnique({
      where: { id: allocationId },
      include: { payment: { select: { id: true, receiptNo: true, isVoided: true } } },
    });
    if (!fresh || fresh.isVoided || fresh.payment.isVoided) {
      throw new ConflictError("Yechim shu orada o'zgardi — sahifani yangilang");
    }

    const current = new Decimal(fresh.amount);
    const source = await tx.monthlyInvoice.findUnique({ where: { id: fresh.invoiceId } });
    if (!source || source.status === "cancelled") {
      throw new ConflictError("Hisob-faktura shu orada bekor qilingan — sahifani yangilang");
    }

    const moving = Boolean(targetInvoiceId) && targetInvoiceId !== source.id;
    let target = source;

    if (moving) {
      target = await tx.monthlyInvoice.findUnique({ where: { id: targetInvoiceId } });
      if (!target || target.studentId !== studentId) {
        throw new BadRequestError("Ko'chiriladigan oy topilmadi");
      }
      if (!["unpaid", "partial"].includes(target.status)) {
        throw new BadRequestError(
          `${formatMonthKey(target.month)} — ochiq qarz emas, unga ko'chirib bo'lmaydi`,
        );
      }
    }

    // 3 ── Summa chegaralari
    if (amount.greaterThan(current)) {
      throw new BadRequestError(
        `Yechim summasini faqat kamaytirish mumkin (hozir ${formatAmount(current)} so'm). ` +
          "Depozitdan ko'proq yechish uchun \"Qarzlarga qo'llash\" tugmasidan foydalaning.",
      );
    }
    if (moving) {
      if (amount.lessThanOrEqualTo(0)) {
        throw new BadRequestError("Ko'chiriladigan summa noldan katta bo'lishi kerak");
      }
      const room = new Decimal(target.amount).minus(target.paidAmount);
      if (amount.greaterThan(room)) {
        throw new BadRequestError(
          `${formatMonthKey(target.month)} oyida qarz ${formatAmount(room)} so'm — ` +
            "bundan ko'pini ko'chirib bo'lmaydi",
        );
      }
    } else if (amount.equals(current)) {
      throw new BadRequestError("Hech narsa o'zgarmadi");
    }

    const released = current.minus(amount);
    const now = new Date();

    // 4 ── Eski qator — CAS (ikki admin bir vaqtda bosgan poyga)
    const voided = await tx.paymentAllocation.updateMany({
      where: { id: fresh.id, isVoided: false },
      data: { isVoided: true, voidedAt: now, voidedBy: userId, voidReason: trimmed },
    });
    if (voided.count !== 1) {
      throw new ConflictError("Yechim shu orada o'zgardi — sahifani yangilang");
    }

    // 5 ── O'rnini bosuvchi qator: o'sha chek, o'sha manba, o'sha sana
    if (amount.greaterThan(0)) {
      await tx.paymentAllocation.create({
        data: {
          paymentId: fresh.paymentId,
          invoiceId: target.id,
          studentId,
          amount,
          source: fresh.source,
          appliedAt: fresh.appliedAt,
        },
      });
    }

    // 6 ── Oylar: har biri BIR MARTA, month asc / id asc, COMPARE-AND-SWAP
    const writes = [
      {
        invoice: source,
        paid: new Decimal(source.paidAmount).minus(current).plus(moving ? 0 : amount),
        hold: released.greaterThan(0),
      },
    ];
    if (moving) {
      writes.push({
        invoice: target,
        paid: new Decimal(target.paidAmount).plus(amount),
        hold: false,
      });
    }
    writes.sort(
      (a, b) =>
        a.invoice.month - b.invoice.month ||
        (a.invoice.id < b.invoice.id ? -1 : a.invoice.id > b.invoice.id ? 1 : 0),
    );

    for (const write of writes) {
      if (write.paid.isNegative()) {
        throw new ConflictError("Hisob-faktura holati o'zgardi. Qayta urinib ko'ring.");
      }

      const status = deriveStatus(new Decimal(write.invoice.amount), write.paid);
      const updated = await tx.monthlyInvoice.updateMany({
        where: {
          id: write.invoice.id,
          paidAmount: write.invoice.paidAmount,
          status: write.invoice.status,
        },
        data: {
          paidAmount: write.paid,
          status,
          paidAt: status === "paid" ? (write.invoice.paidAt ?? fresh.appliedAt) : null,
          ...(write.hold ? { depositHold: true } : {}),
        },
      });

      if (updated.count !== 1) {
        throw new ConflictError("Hisob-faktura holati o'zgardi. Qayta urinib ko'ring.");
      }
    }

    // 7 ── Oydan olingan pul chekning depozit qoldig'iga qaytadi
    if (released.greaterThan(0)) {
      await tx.payment.update({
        where: { id: fresh.paymentId },
        data: {
          allocatedAmount: { decrement: released },
          depositAmount: { increment: released },
        },
      });

      await tx.studentAccount.update({
        where: { studentId },
        data: { balance: { increment: released } },
      });
    }

    // 8 ── Boshqa ochiq qarzlar depozitdan yopiladi (to'xtatilgan oy — yo'q)
    const settled = await settleDepositInTx(tx, studentId);

    return {
      receiptNo: fresh.payment.receiptNo,
      current,
      source,
      target,
      moving,
      released,
      settled,
    };
  }, TX_OPTIONS);

  const balance = await getBalance(studentId);

  // AUDIT — tranzaksiyadan KEYIN (rad etilgan urinish logda bajarilgan
  // bo'lib qolmasin, modul bo'ylab bitta tartib)
  logger.warn(
    `[deposit] Yechim qo'lda o'zgartirildi: allocation=${allocationId} ` +
      `chek=#${result.receiptNo} student=${studentId} ` +
      `${formatMonthKey(result.source.month)} ${formatAmount(result.current)} → ` +
      `${result.moving ? `${formatMonthKey(result.target.month)} ` : ""}${formatAmount(amount)} ` +
      `depozitga=${formatAmount(result.released)} ` +
      `boshqa oylarga=${formatAmount(result.settled.applied)} ` +
      `actor=${userId} sabab="${trimmed}"`,
  );

  return {
    sourceMonth: result.source.month,
    sourceMonthLabel: formatMonthKey(result.source.month),
    targetMonth: result.target.month,
    targetMonthLabel: formatMonthKey(result.target.month),
    moved: result.moving,
    amount: formatAmount(amount),
    releasedToDeposit: formatAmount(result.released),
    // Qaytgan pulning boshqa ochiq oylarga darhol yechilgan qismi
    appliedToOthers: formatAmount(result.settled.applied),
    appliedAllocations: result.settled.allocations,
    depositHold: result.released.greaterThan(0),
    balance: formatAmount(balance),
  };
};

/**
 * Yechimni butunlay olib tashlaydi ("Hisob-fakturaga yechildi" → o'chirish).
 *
 * @param {string} allocationId
 * @param {{reason: string}} data
 * @param {string} userId
 */
const releaseAllocation = (allocationId, data, userId) =>
  reworkAllocation(allocationId, {
    amount: new Decimal(0),
    targetInvoiceId: null,
    reason: data?.reason,
    userId,
  });

/**
 * Yechimni tahrirlaydi: summani kamaytirish va/yoki boshqa ochiq oyga ko'chirish.
 *
 * @param {string} allocationId
 * @param {{amount: string, invoiceId?: string, reason: string}} data
 * @param {string} userId
 */
const editAllocation = (allocationId, data, userId) =>
  reworkAllocation(allocationId, {
    amount: parseAmount(data?.amount, "Yechim summasi"),
    targetInvoiceId: data?.invoiceId || null,
    reason: data?.reason,
    userId,
  });

// ─────────────────────────────────────────────
// Qaytarish va to'g'rilash
// ─────────────────────────────────────────────

/**
 * Depozitni ota-onaga qaytaradi — pul to'lov turidan chiqadi.
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
  // Kelajakdagi sana bilan qaytarish qayd etilmaydi (modul bo'ylab bitta qoida)
  const refundedAt = parseRecordedAt(data.refundedAt, { subject: "qaytarish" });

  await ensureStudentAccount(studentId);

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

    // 2 ── TO'LOV TURI — oxirgi
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

  const newBalance = await getBalance(studentId);

  // ⚠️ AUDIT YOZUVI TRANZAKSIYADAN KEYIN — `payment.voidPayment` dagi bir
  // xil mulohaza: rad etilgan qaytarish ("depozitda bunchalik pul yo'q")
  // logda BAJARILGAN bo'lib qolmasligi kerak.
  logger.warn(
    `[deposit] Depozit qaytarildi: student=${studentId} summa=${amount.toFixed(2)} ` +
      `tur=${account.name} qoldiq=${formatAmount(newBalance)} ` +
      `actor=${userId} sabab="${reason}"`,
  );

  return {
    ...refund,
    amount: formatAmount(refund.amount),
    balance: formatAmount(newBalance),
  };
};

/**
 * Qoldiqni qo'lda to'g'rilash — eski qarzni ko'chirish, sanoq farqi.
 *
 * To'lov turiga TEGILMAYDI: bu pul harakati emas, hisob tuzatishi. To'lov turi
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

  const newBalance = await getBalance(studentId);

  // AUDIT YOZUVI TRANZAKSIYADAN KEYIN (yuqoridagi izohga qarang):
  // "qoldiq manfiy bo'lib qoladi" deb rad etilgan urinish logda
  // bajarilgan to'g'rilash bo'lib ko'rinmasligi kerak.
  logger.warn(
    `[deposit] Qoldiq qo'lda to'g'rilandi: student=${studentId} ` +
      `summa=${amount.toFixed(2)} yangi qoldiq=${formatAmount(newBalance)} ` +
      `actor=${userId} sabab="${reason}"`,
  );

  return {
    ...row,
    amount: formatAmount(row.amount),
    balance: formatAmount(newBalance),
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
      select: {
        id: true,
        studentId: true,
        accountId: true,
        amount: true,
        paidAt: true,
        receiptNo: true,
        note: true,
      },
    }),
    prisma.paymentAllocation.findMany({
      where: { studentId, isVoided: false },
      select: {
        id: true,
        amount: true,
        appliedAt: true,
        invoiceId: true,
        paymentId: true,
        source: true,
      },
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
  // Faol yechim faqat faol chekka tegishli (chek bekor qilinsa yechimlari
  // ham bekor bo'ladi), shuning uchun chek raqami shu ro'yxatdan topiladi
  const receiptByPayment = new Map(
    payments.map((p) => [p.id, `#${String(p.receiptNo).padStart(6, "0")}`]),
  );

  const items = [
    ...payments.map((p) => {
      const receiptLabel = receiptByPayment.get(p.id);
      return {
        id: `payment:${p.id}`,
        type: "payment",
        amount: formatAmount(p.amount),
        direction: "in",
        occurredAt: p.paidAt,
        label: MOVEMENT_LABELS.payment,
        description: `Chek ${receiptLabel}`,
        note: p.note,
        // Qatordagi "Tahrirlash" / "Bekor qilish" — to'lovlar registridagi
        // AYNI oynalar, shuning uchun chekning xom maydonlari
        paymentId: p.id,
        receiptLabel,
        payment: {
          id: p.id,
          studentId: p.studentId,
          accountId: p.accountId,
          amount: formatAmount(p.amount),
          paidAt: p.paidAt,
          note: p.note,
          receiptLabel,
        },
      };
    }),
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
        sourceLabel: SOURCE_LABELS[a.source] ?? a.source,
        // Qatordagi "Tahrirlash" / "O'chirish" uchun
        allocationId: a.id,
        paymentId: a.paymentId,
        invoiceId: a.invoiceId,
        month: month ?? null,
        receiptLabel: receiptByPayment.get(a.paymentId) ?? null,
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
  releaseAllocation,
  editAllocation,
  refundDeposit,
  adjustBalance,
  getMovements,
  getStudentAccount,
};
