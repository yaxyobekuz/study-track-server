/**
 * To'lov qabul qilish — kassirning asosiy amali.
 *
 * Kassir BITTA summa kiritadi; tizim uni eng eski qarzdan boshlab
 * taqsimlaydi, ortiq qolgani depozit bo'ladi. `invoice_payments` jadvali
 * shu sababli ikkiga bo'lingan: `Payment` (pulni qabul qilish akti) va
 * `PaymentAllocation` (chekning bitta oyga tushgan ulushi).
 *
 * ── DEPOZIT ALOHIDA "HAMYON" EMAS ──
 * U shu chekning taqsimlanmagan qoldig'i. Keyingi oy depozitdan yopilganda
 * SHU chekka yana bir taqsimot qatori yoziladi (`source: deposit`). Shuning
 * uchun bekor qilish qoidasi bitta: chekning barcha taqsimotlarini qaytar.
 * Manfiy balans muammosi tug'ilmaydi — batafsil izoh schema.prisma da.
 *
 * ── POYGA HIMOYASI (ikki qavat) ──
 * 1. `StudentAccount` qatorini lock qilish — tranzaksiyaning BIRINCHI
 *    operatori. Ikki kassir bir o'quvchiga bir vaqtda to'lov kiritsa,
 *    ikkinchisi birinchisini kutadi.
 * 2. Har bir hisob-fakturaga COMPARE-AND-SWAP yozuv: `paidAmount` o'qilgan
 *    qiymatga teng bo'lsagina yoziladi. Yo'qolgan yangilanish STRUKTURAVIY
 *    imkonsiz bo'ladi — kelajakda lock intizomi buzilsa ham.
 *    Ayni shu predikat `cancelled` hisob-fakturaga pul tushib qolishini
 *    ham to'xtatadi (`getSummary` bekor qilinganlarni tashlab ketadi —
 *    pul hisobotdan g'oyib bo'lardi).
 *
 * QISMAN BEKOR QILISH YO'Q: xato summa → to'liq bekor + qayta kiritish.
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
} = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const logger = require("../utils/logger");
const { Decimal, parseAmount, formatAmount, sumAmounts } = require("../helpers/money.helpers");
const { allocateFifo, deriveStatus } = require("../helpers/allocation.helpers");
const {
  formatMonthKey,
  parseDayRangeFilter,
  parseRecordedAt,
} = require("../helpers/month.helpers");
const {
  postEntry,
  assertActiveAccount,
  serializeAccount,
} = require("./paymentAccount.service");
const { settleDepositInTx } = require("./depositSettlement.service");

// 20 oylik qarzi bor o'quvchi + oy boshidagi to'lov navbati Prisma'ning
// standart 5 soniyasiga sig'maydi.
const TX_OPTIONS = { timeout: 15000, maxWait: 10000 };

const STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  isArchived: true,
};

const SOURCE_LABELS = {
  payment: "To'lovdan",
  deposit: "Depozitdan",
};

// ─────────────────────────────────────────────
// Serializatsiya
// ─────────────────────────────────────────────

const serializeAllocation = (row) => ({
  ...row,
  amount: formatAmount(row.amount),
  monthLabel: row.month != null ? formatMonthKey(row.month) : null,
  sourceLabel: SOURCE_LABELS[row.source] ?? row.source,
});

const serializePayment = (row, { student, account, allocations } = {}) => {
  const { allocations: included, account: joinedAccount, ...rest } = row;
  const list = allocations ?? included;
  const resolvedAccount = account ?? joinedAccount ?? null;

  return {
    ...rest,
    amount: formatAmount(row.amount),
    allocatedAmount: formatAmount(row.allocatedAmount),
    depositAmount: formatAmount(row.depositAmount),
    receiptLabel: `#${String(row.receiptNo).padStart(6, "0")}`,
    student: student ?? null,
    studentName:
      student != null
        ? `${student.firstName} ${student.lastName ?? ""}`.trim()
        : `${row.studentSnapshot?.firstName ?? ""} ${row.studentSnapshot?.lastName ?? ""}`.trim() ||
          "Noma'lum",
    account: resolvedAccount ? serializeAccount(resolvedAccount) : null,
    ...(list ? { allocations: list.map(serializeAllocation) } : {}),
  };
};

// ─────────────────────────────────────────────
// Yordamchilar
// ─────────────────────────────────────────────

const assertStudent = async (studentId) => {
  if (!studentId) throw new BadRequestError("O'quvchi tanlanmagan");

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: {
      ...STUDENT_SELECT,
      role: true,
      classes: { select: { class: { select: { id: true, name: true } } } },
    },
  });

  if (!student || student.role !== ROLES.STUDENT) {
    throw new NotFoundError("O'quvchi topilmadi");
  }

  return student;
};

const snapshotOf = (student) => {
  const klass = student.classes?.[0]?.class ?? null;
  return {
    firstName: student.firstName,
    lastName: student.lastName ?? "",
    username: student.username,
    classId: klass?.id ?? null,
    className: klass?.name ?? null,
  };
};

// Sana qoidasi modul bo'ylab BITTA joyda (`month.helpers.js`): bo'sh —
// hozir, kelajakda — rad, mijoz soatiga bir daqiqa yo'l qo'yiladi.
const parsePaidAt = (value) =>
  parseRecordedAt(value, { label: "To'lov sanasi", subject: "to'lov" });

/**
 * Lock qatori BO'LISHI SHART — yo'q qatorni lock qilib bo'lmaydi.
 * Tranzaksiyadan TASHQARIDA: lock ushlab turmaydi, idempotent.
 *
 * @param {string} studentId
 */
const ensureStudentAccount = async (studentId) => {
  try {
    await prisma.studentAccount.upsert({
      where: { studentId },
      create: { studentId, balance: 0 },
      update: {},
    });
  } catch (error) {
    // Postgres'da `upsert` atomar EMAS: ikki kassir bir o'quvchining
    // birinchi to'lovini bir vaqtda kiritsa, ikkalasi ham "qator yo'q" deb
    // ko'radi va biri unique cheklovga uriladi. Bu yerda P2002 aynan
    // KUTILGAN natija — qator endi bor, davom etaveramiz.
    if (error?.code !== "P2002") throw error;
  }
};

/**
 * Taqsimot oldindan ko'rinishi — kassir TASDIQLASHDAN OLDIN qaysi oyga
 * qancha tushishini ko'radi. Yozmaydi.
 *
 * @param {string} studentId
 * @param {string|number} amountInput
 * @returns {Promise<object>}
 */
const previewPayment = async (studentId, amountInput) => {
  const student = await assertStudent(studentId);
  const amount = parseAmount(amountInput, "To'lov summasi");

  if (amount.lessThanOrEqualTo(0)) {
    throw new BadRequestError("To'lov summasi noldan katta bo'lishi kerak");
  }

  const [invoices, account] = await Promise.all([
    prisma.monthlyInvoice.findMany({
      where: { studentId, status: { in: ["unpaid", "partial"] } },
      orderBy: [{ month: "asc" }, { id: "asc" }],
    }),
    prisma.studentAccount.findUnique({ where: { studentId } }),
  ]);

  const { allocations, allocated, remainder } = allocateFifo(invoices, amount, new Date());

  return {
    student,
    amount: formatAmount(amount),
    allocatedAmount: formatAmount(allocated),
    depositAmount: formatAmount(remainder),
    currentBalance: formatAmount(new Decimal(account?.balance ?? 0)),
    allocations: allocations.map((a) => ({
      invoiceId: a.invoiceId,
      month: a.month,
      monthLabel: formatMonthKey(a.month),
      amount: formatAmount(a.amount),
      previousPaidAmount: formatAmount(a.previousPaidAmount),
      newPaidAmount: formatAmount(a.newPaidAmount),
      status: a.status,
      closes: a.status === "paid",
    })),
  };
};

// ─────────────────────────────────────────────
// To'lov qabul qilish
// ─────────────────────────────────────────────

/**
 * O'quvchi(lar) lock'ini oladi — `studentId` O'SISH tartibida.
 *
 * Bitta o'quvchi uchun bu oddiy `version` increment. Tahrirlashda chek
 * boshqa o'quvchiga o'tkazilsa IKKALASI lock qilinadi va tartib qat'iy
 * bo'lishi shart: A→B va B→A tahrirlari parallel kelganda deadlock bo'lmasin.
 *
 * @param {object} tx
 * @param {string[]} studentIds
 */
const lockStudentAccounts = async (tx, studentIds) => {
  for (const studentId of [...new Set(studentIds)].sort()) {
    await tx.studentAccount.update({
      where: { studentId },
      data: { version: { increment: 1 } },
    });
  }
};

/**
 * Daftar yozuvlari — HAR DOIM tranzaksiya OXIRIDA va to'lov turi `id` O'SISH
 * tartibida (lock tartibi: ... → PaymentAccount). Bir xil turdagi yozuvlar
 * berilgan tartibda qoladi (avval teskari qator, keyin yangi to'lov).
 *
 * @param {object} tx
 * @param {object[]} entries - `postEntry` parametrlari
 */
const postEntriesInOrder = async (tx, entries) => {
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      a.entry.accountId === b.entry.accountId
        ? a.index - b.index
        : a.entry.accountId < b.entry.accountId
          ? -1
          : 1,
    );

  for (const { entry } of ordered) {
    await postEntry(tx, entry);
  }
};

/**
 * To'lovni yozadi va FIFO taqsimlaydi — TRANZAKSIYA ICHIDAGI yadro.
 *
 * Chaqiruvchi o'quvchi lock'ini OLGAN bo'lishi kerak. Daftar yozuvi bu yerda
 * YOZILMAYDI — u `entry` sifatida qaytadi va chaqiruvchi uni barcha
 * hisob-faktura yozuvlaridan KEYIN yozadi (lock tartibi).
 *
 * @param {object} tx
 * @param {object} params - { student, account, amount, paidAt, note, userId }
 * @returns {Promise<{payment, allocations, allocated, remainder, entry}>}
 */
const createPaymentInTx = async (tx, { student, account, amount, paidAt, note, userId }) => {
  // Lock OSTIDA o'qish. `status` bo'yicha filtr: 0 so'mlik grant `paid`
  // bo'lgani uchun nomzodlar orasiga tushmaydi. `depositHold` bu yerda
  // FILTRLANMAYDI: kassir olib kelgan naqd pul — ochiq qaror, u eng eski
  // qarzni yopadi; belgi faqat DEPOZITDAN avtomat yechishni to'xtatadi.
  const invoices = await tx.monthlyInvoice.findMany({
    where: { studentId: student.id, status: { in: ["unpaid", "partial"] } },
    orderBy: [{ month: "asc" }, { id: "asc" }],
  });

  // Chek qatori (taqsimotlar uchun id kerak)
  const payment = await tx.payment.create({
    data: {
      studentId: student.id,
      accountId: account.id,
      amount,
      allocatedAmount: 0,
      depositAmount: amount,
      paidAt,
      note,
      studentSnapshot: snapshotOf(student),
      createdBy: userId,
    },
  });

  // FIFO (sof Decimal; tenglik funksiya ichida tekshiriladi)
  const { allocations, allocated, remainder } = allocateFifo(invoices, amount, paidAt);

  if (allocations.length > 0) {
    await tx.paymentAllocation.createMany({
      data: allocations.map((a) => ({
        paymentId: payment.id,
        invoiceId: a.invoiceId,
        studentId: student.id,
        amount: a.amount,
        source: "payment",
        appliedAt: paidAt,
      })),
    });
  }

  // Har bir hisob-faktura: COMPARE-AND-SWAP
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
      throw new ConflictError("Hisob-faktura holati o'zgardi. To'lovni qayta kiriting.");
    }
  }

  // Hosila summalar
  const fresh = await tx.payment.update({
    where: { id: payment.id },
    data: { allocatedAmount: allocated, depositAmount: remainder },
  });

  if (remainder.greaterThan(0)) {
    await tx.studentAccount.update({
      where: { studentId: student.id },
      data: { balance: { increment: remainder } },
    });
  }

  return {
    payment: fresh,
    allocations,
    allocated,
    remainder,
    entry: {
      accountId: account.id,
      type: "payment",
      amount,
      occurredAt: paidAt,
      paymentId: payment.id,
      note,
      createdBy: userId,
    },
  };
};

/**
 * `createPayment` / `editPayment` javobi — ikkalasida AYNI shakl.
 */
const buildCreatedResponse = async (created, student, settled) => {
  const fresh = await prisma.payment.findUnique({
    where: { id: created.payment.id },
    include: { account: true },
  });

  return {
    ...serializePayment(fresh, {
      student,
      allocations: created.allocations.map((a) => ({
        invoiceId: a.invoiceId,
        month: a.month,
        amount: a.amount,
        source: "payment",
      })),
    }),
    summary: {
      allocatedAmount: formatAmount(created.allocated),
      depositAmount: formatAmount(created.remainder),
      closedCount: created.allocations.filter((a) => a.status === "paid").length,
      // Boshqa cheklarning depozitidan shu amal oxirida yechilgani
      depositApplied: formatAmount(settled?.applied ?? 0),
    },
  };
};

/**
 * To'lovni qabul qiladi va FIFO taqsimlaydi.
 *
 * @param {object} data - { studentId, accountId, amount, paidAt, note }
 * @param {string} userId
 * @returns {Promise<object>}
 */
const createPayment = async (data, userId) => {
  // ── Lock'siz tekshiruvlar ─────────────────
  const amount = parseAmount(data.amount, "To'lov summasi");
  if (amount.lessThanOrEqualTo(0)) {
    throw new BadRequestError("To'lov summasi noldan katta bo'lishi kerak");
  }

  const paidAt = parsePaidAt(data.paidAt);
  const [student, account] = await Promise.all([
    assertStudent(data.studentId),
    assertActiveAccount(data.accountId),
  ]);

  await ensureStudentAccount(student.id);

  const result = await prisma.$transaction(async (tx) => {
    // 1 ── O'QUVCHI LOCK'I. Bundan keyin uning puliga hech kim tega olmaydi.
    await lockStudentAccounts(tx, [student.id]);

    // 2 ── Chek + FIFO taqsimot
    const created = await createPaymentInTx(tx, {
      student,
      account,
      amount,
      paidAt,
      note: data.note?.trim() || "",
      userId,
    });

    // 3 ── Qarz va depozit birga turmaydi. Odatda bo'sh o'tadi (yangi pul
    //      ochiq oylarni allaqachon yopgan), lekin oldingi depozit bilan
    //      ochiq oy yonma-yon qolgan bo'lsa shu yerda tekislanadi.
    const settled = await settleDepositInTx(tx, student.id);

    // 4 ── TO'LOV TURI — HAR DOIM OXIRGI (lock tartibi)
    await postEntriesInOrder(tx, [created.entry]);

    return { created, settled };
  }, TX_OPTIONS);

  return buildCreatedResponse(result.created, student, result.settled);
};

/**
 * To'lovni bekor qiladi — TRANZAKSIYA ICHIDAGI yadro.
 *
 * SHU chekning barcha taqsimotlari qaytariladi — keyinroq depozitdan
 * qo'llangan (`source: deposit`) qatorlar ham. Aynan shu sababli
 * "depozit allaqachon sarflangan" holati muammo bo'lmaydi.
 *
 * YAGONA qolgan teshik: chekning depozit qismi ALLAQACHON ota-onaga
 * qaytarilgan bo'lsa. To'liq lot-tracking maktab uchun ortiqcha, shuning
 * uchun aniq xabar bilan RAD ETILADI — jim tuzatilmaydi.
 *
 * Chaqiruvchi o'quvchi lock'ini OLGAN bo'lishi kerak; daftar yozuvi `entry`
 * sifatida qaytadi.
 *
 * @param {object} tx
 * @param {object} params - { id, reason, userId, now }
 * @returns {Promise<{payment, reopened, depositReversed, entry}>}
 */
const voidPaymentInTx = async (tx, { id, reason, userId, now }) => {
  // Lock ostida qayta o'qish
  const fresh = await tx.payment.findUnique({
    where: { id },
    include: { allocations: { where: { isVoided: false } } },
  });
  if (!fresh) throw new NotFoundError("To'lov topilmadi");
  if (fresh.isVoided) throw new ConflictError("To'lov allaqachon bekor qilingan");

  const studentAccount = await tx.studentAccount.findUnique({
    where: { studentId: fresh.studentId },
  });

  const allocatedNow = sumAmounts(fresh.allocations.map((a) => a.amount));
  const depositHeld = new Decimal(fresh.amount).minus(allocatedNow);

  // Depozit qismi qaytarib yuborilganmi?
  if (depositHeld.greaterThan(studentAccount?.balance ?? 0)) {
    throw new BadRequestError(
      `Bu to'lovning ${formatAmount(depositHeld)} so'mi depozitda qolmagan ` +
        "(qaytarilgan yoki to'g'rilangan). Avval o'sha amalni bekor qiling.",
    );
  }

  // Chekni bekor qilish — CAS (ikki marta bekor qilish poygasi)
  const voided = await tx.payment.updateMany({
    where: { id, isVoided: false },
    data: {
      isVoided: true,
      voidedAt: now,
      voidedBy: userId,
      voidReason: reason,
      allocatedAmount: 0,
      depositAmount: 0,
    },
  });
  if (voided.count !== 1) throw new ConflictError("To'lov allaqachon bekor qilingan");

  await tx.paymentAllocation.updateMany({
    where: { paymentId: id, isVoided: false },
    data: { isVoided: true, voidedAt: now },
  });

  // Hisob-fakturalarni orqaga qaytarish. Bitta chek bitta oyga IKKI marta
  // tushgan bo'lishi mumkin (to'lovdan + keyin depozitdan) — shuning uchun
  // oy bo'yicha yig'iladi va har oy BIR MARTA, month asc/id asc yoziladi.
  const releasedByInvoice = new Map();
  for (const allocation of fresh.allocations) {
    releasedByInvoice.set(
      allocation.invoiceId,
      (releasedByInvoice.get(allocation.invoiceId) ?? new Decimal(0)).plus(allocation.amount),
    );
  }

  const invoices = releasedByInvoice.size
    ? await tx.monthlyInvoice.findMany({
        where: { id: { in: [...releasedByInvoice.keys()] } },
        orderBy: [{ month: "asc" }, { id: "asc" }],
      })
    : [];

  const reopened = [];
  for (const invoice of invoices) {
    const newPaid = new Decimal(invoice.paidAmount).minus(releasedByInvoice.get(invoice.id));
    if (newPaid.isNegative()) {
      throw new ConflictError("Hisob-faktura holati o'zgardi. Qayta urinib ko'ring.");
    }

    // Bekor qilingan hisob-faktura ALOHIDA qaror — holati tiklanmaydi
    const status =
      invoice.status === "cancelled"
        ? "cancelled"
        : deriveStatus(new Decimal(invoice.amount), newPaid);

    const updated = await tx.monthlyInvoice.updateMany({
      where: { id: invoice.id, paidAmount: invoice.paidAmount },
      data: {
        paidAmount: newPaid,
        status,
        paidAt: status === "paid" ? invoice.paidAt : null,
      },
    });

    if (updated.count !== 1) {
      throw new ConflictError("Hisob-faktura holati o'zgardi. Qayta urinib ko'ring.");
    }

    reopened.push({ invoiceId: invoice.id, month: invoice.month, status });
  }

  // Sarflanmagan depozit qismini yechish (yuqoridagi tekshiruv manfiyga
  // tushmasligini kafolatladi)
  if (depositHeld.greaterThan(0)) {
    await tx.studentAccount.update({
      where: { studentId: fresh.studentId },
      data: { balance: { decrement: depositHeld } },
    });
  }

  return {
    payment: fresh,
    reopened,
    depositReversed: depositHeld,
    // `occurredAt` = HOZIR, `payment.paidAt` EMAS: pul BUGUN chiqadi va
    // kunlik hisobot shunga tayanadi.
    entry: {
      accountId: fresh.accountId,
      type: "payment_void",
      amount: new Decimal(fresh.amount).negated(),
      occurredAt: now,
      paymentId: fresh.id,
      note: reason,
      createdBy: userId,
    },
  };
};

/**
 * To'lovni bekor qiladi (soft void).
 *
 * Qayta ochilgan oylar tranzaksiya oxirida boshqa cheklarning DEPOZITIDAN
 * avtomat yopiladi ("qarz va depozit birga turmaydi").
 *
 * @param {string} id
 * @param {string} reason
 * @param {string} userId
 * @returns {Promise<object>}
 */
const voidPayment = async (id, reason, userId) => {
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) throw new NotFoundError("To'lov topilmadi");
  if (payment.isVoided) throw new BadRequestError("To'lov allaqachon bekor qilingan");

  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError("Bekor qilish sababi majburiy");

  await ensureStudentAccount(payment.studentId);

  const result = await prisma.$transaction(async (tx) => {
    // 1 ── O'QUVCHI LOCK'I (createPayment bilan bir xil tartibda)
    await lockStudentAccounts(tx, [payment.studentId]);

    // 2 ── Chek, taqsimotlar, oylar, depozit
    const voided = await voidPaymentInTx(tx, {
      id,
      reason: trimmed,
      userId,
      now: new Date(),
    });

    // 3 ── Qayta ochilgan oylar boshqa cheklarning depozitidan yopiladi
    const settled = await settleDepositInTx(tx, payment.studentId);

    // 4 ── TO'LOV TURI — oxirgi
    await postEntriesInOrder(tx, [voided.entry]);

    return { ...voided, settled };
  }, TX_OPTIONS);

  // ⚠️ AUDIT YOZUVI TRANZAKSIYADAN KEYIN. Ilgari u oldinda turardi va
  // tranzaksiya yiqilganda ham (poyga, yetarli bo'lmagan depozit) logda
  // "To'lov bekor qilindi" bo'lib qolaverardi — tergovda mavjud bo'lmagan
  // amal ko'rinardi. Yozuvchi funksiyalar (`createPayment`, `createExpense`)
  // allaqachon shu tartibda ishlaydi.
  logger.warn(
    `[payments] To'lov bekor qilindi: payment=${id} chek=#${payment.receiptNo} ` +
      `student=${payment.studentId} summa=${payment.amount.toFixed(2)} ` +
      `depozitdan=${formatAmount(result.depositReversed)} ` +
      `qayta ochildi=${result.reopened.length} ta ` +
      `depozitdan yopildi=${formatAmount(result.settled.applied)} ` +
      `actor=${userId} sabab="${trimmed}"`,
  );

  return {
    message: "To'lov bekor qilindi",
    reopened: result.reopened.map((r) => ({ ...r, monthLabel: formatMonthKey(r.month) })),
    depositReversed: formatAmount(result.depositReversed),
    depositApplied: formatAmount(result.settled.applied),
  };
};

/**
 * To'lov izohini yangilaydi — o'zgartirish mumkin bo'lgan yagona maydon.
 * @param {string} id
 * @param {string} note
 * @returns {Promise<object>}
 */
const updatePaymentNote = async (id, note) => {
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) throw new NotFoundError("To'lov topilmadi");

  await prisma.payment.update({
    where: { id },
    data: { note: note?.trim() || "" },
  });

  return getPaymentById(id);
};

/**
 * To'lovni TAHRIRLASH.
 *
 * ⚠️ Daftar APPEND-ONLY — "joyida o'zgartirish" yo'q. Shuning uchun pulga
 * tegadigan tahrir = eski to'lovni BEKOR QILISH (taqsimotlar bo'shaydi, pul
 * depozit/qarzga qaytadi, kassaga teskari qator) + tahrirlangan qiymatlar
 * bilan YANGI to'lov. Ikkalasi ham auditda qoladi.
 *
 * ⚠️ BITTA TRANZAKSIYADA. Ilgari `voidPayment` va `createPayment` ketma-ket
 * ikki tranzaksiya edi: yangi chek yiqilsa (to'lov turi arxivlangan, poyga)
 * eski to'lov bekor bo'lib, yangisi yozilmay qolardi — o'quvchi jimgina
 * qarzdor bo'lib, kassa qoldig'i o'zgarib ketardi (`salaryPayment.editPayment`
 * shu sababli allaqachon bitta tranzaksiyada).
 *
 * ⚠️ Lock tartibi: o'quvchi(lar) `studentId` o'sish tartibida → oylar →
 * to'lov turi(lar) oxirida, `id` o'sish tartibida.
 *
 * O'quvchi, summa, sana, to'lov turi va izoh — hammasi o'zgartirilishi mumkin.
 *
 * @param {string} id
 * @param {object} data - { studentId?, accountId?, amount?, paidAt?, note?, reason? }
 * @param {string} userId
 * @returns {Promise<object>} yangi (tahrirlangan) to'lov
 */
const editPayment = async (id, data, userId) => {
  const existing = await prisma.payment.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("To'lov topilmadi");
  if (existing.isVoided) {
    throw new BadRequestError("Bekor qilingan to'lovni tahrirlab bo'lmaydi");
  }

  // Yangi qiymatlar — bo'sh maydonlar eskisidan olinadi.
  const nextStudentId = data.studentId || existing.studentId;
  const nextAccountId = data.accountId || existing.accountId;
  const nextAmount =
    data.amount != null && data.amount !== ""
      ? parseAmount(data.amount, "To'lov summasi")
      : new Decimal(existing.amount);
  if (nextAmount.lessThanOrEqualTo(0)) {
    throw new BadRequestError("To'lov summasi noldan katta bo'lishi kerak");
  }
  const nextPaidAt = data.paidAt ? parsePaidAt(data.paidAt) : existing.paidAt;
  const nextNote = data.note != null ? String(data.note).trim() : existing.note;

  // ⚠️ Pulga tegadigan maydonlar (o'quvchi, summa, to'lov turi) O'ZGARMAGAN
  // bo'lsa — taqsimot, depozit va kassa qoldig'i AYNAN o'sha bo'ladi, faqat
  // sana/izoh o'zgargan. Bunda JOYIDA yangilaymiz: bekor+qayta yo'li chek
  // raqamini almashtirib, "bekor qilingan" qator qoldirib, summani jamiga
  // IKKI marta qo'shib yuborardi.
  const moneyUnchanged =
    nextStudentId === existing.studentId &&
    nextAccountId === existing.accountId &&
    nextAmount.equals(existing.amount);

  if (moneyUnchanged) {
    const paidAtChanged = nextPaidAt.getTime() !== existing.paidAt.getTime();

    await prisma.$transaction(async (tx) => {
      await lockStudentAccounts(tx, [existing.studentId]);

      const fresh = await tx.payment.findUnique({ where: { id } });
      if (!fresh || fresh.isVoided) {
        throw new ConflictError("To'lov shu orada bekor qilingan yoki tahrirlangan");
      }

      await tx.payment.update({
        where: { id },
        data: { paidAt: nextPaidAt, note: nextNote },
      });

      // Kassa daftaridagi qator ham shu to'lovniki — sana bilan birga suriladi.
      // Kunlik hisobot `occurredAt` bo'yicha guruhlanadi; running balance esa
      // `seq` ga bog'liq, shuning uchun qoldiqlar o'zgarmaydi (finance.md §7).
      await tx.accountEntry.updateMany({
        where: { paymentId: id, type: "payment" },
        data: { occurredAt: nextPaidAt, note: nextNote },
      });

      if (paidAtChanged) {
        // ⚠️ Chekdan TO'G'RIDAN-TO'G'RI tushgan ulushlarning sanasi = to'lov
        // sanasi. Ilgari faqat chek surilardi va "Depozit harakatlari" da
        // "To'lov qabul qilindi" yangi kunda, "Hisob-fakturaga yechildi" esa
        // eski kunda qolib ketardi. Depozitdan keyin yechilgan ulushlar
        // (`source: deposit`) o'z kunida qoladi — ular boshqa hodisa.
        const own = await tx.paymentAllocation.findMany({
          where: { paymentId: id, source: "payment", isVoided: false },
          select: { invoiceId: true },
        });

        await tx.paymentAllocation.updateMany({
          where: { paymentId: id, source: "payment" },
          data: { appliedAt: nextPaidAt },
        });

        // Shu chek yopgan oylarning "to'langan payti" ham suriladi
        if (own.length > 0) {
          await tx.monthlyInvoice.updateMany({
            where: {
              id: { in: [...new Set(own.map((a) => a.invoiceId))] },
              status: "paid",
              paidAt: fresh.paidAt,
            },
            data: { paidAt: nextPaidAt },
          });
        }
      }
    }, TX_OPTIONS);

    logger.info(
      `[payment] To'lov joyida tahrirlandi (sana/izoh): payment=${id} actor=${userId}`,
    );

    return getPaymentById(id);
  }

  // ── Pulga tegadigan o'zgarish: bekor qilib qayta yaratish, BITTA tranzaksiyada
  const reason = data.reason?.trim()
    ? `Tahrirlandi: ${data.reason.trim()}`
    : "To'lov tahrirlandi (qayta kiritildi)";

  const [student, account] = await Promise.all([
    assertStudent(nextStudentId),
    assertActiveAccount(nextAccountId),
  ]);

  await Promise.all([
    ensureStudentAccount(existing.studentId),
    ensureStudentAccount(student.id),
  ]);

  const studentIds = [...new Set([existing.studentId, student.id])].sort();

  const result = await prisma.$transaction(async (tx) => {
    // 1 ── O'quvchi(lar) lock'i — o'sish tartibida
    await lockStudentAccounts(tx, studentIds);

    // 2 ── Eski chek: taqsimotlar bo'shaydi, oylar qayta ochiladi
    const voided = await voidPaymentInTx(tx, { id, reason, userId, now: new Date() });

    // 3 ── Yangi chek: qayta ochilgan oylarni BIRINCHI bo'lib u yopadi
    //      (tahrir eski chekning O'RNINI egallaydi)
    const created = await createPaymentInTx(tx, {
      student,
      account,
      amount: nextAmount,
      paidAt: nextPaidAt,
      note: nextNote,
      userId,
    });

    // 4 ── Qarz va depozit birga turmaydi — ikkala o'quvchida ham
    const settled = [];
    for (const studentId of studentIds) {
      settled.push(await settleDepositInTx(tx, studentId));
    }

    // 5 ── To'lov turi(lar) — oxirida, `id` o'sish tartibida
    await postEntriesInOrder(tx, [voided.entry, created.entry]);

    return {
      voided,
      created,
      settled: {
        applied: settled.reduce((sum, s) => sum.plus(s.applied), new Decimal(0)),
      },
    };
  }, TX_OPTIONS);

  logger.warn(
    `[payment] To'lov tahrirlandi (bekor+qayta, bitta tranzaksiya): eski=${id} ` +
      `(#${existing.receiptNo}, ${formatAmount(existing.amount)}) → ` +
      `yangi=${result.created.payment.id} (#${result.created.payment.receiptNo}, ` +
      `${formatAmount(nextAmount)}) student=${existing.studentId}→${student.id} ` +
      `actor=${userId} sabab="${reason}"`,
  );

  return buildCreatedResponse(result.created, student, result.settled);
};

// ─────────────────────────────────────────────
// O'qish
// ─────────────────────────────────────────────

const loadStudentMap = async (rows) => {
  const ids = [...new Set(rows.map((r) => r.studentId))];
  if (ids.length === 0) return new Map();

  const students = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: STUDENT_SELECT,
  });

  return new Map(students.map((s) => [s.id, s]));
};

/**
 * To'lovlar registri — kunlik/oylik tushum hisoboti.
 *
 * @param {object} req - query: page, limit, studentId, accountId, from, to, includeVoided, search
 * @returns {Promise<object>}
 */
const getPayments = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const filter = {};
  if (query.studentId) filter.studentId = query.studentId;
  if (query.accountId) filter.accountId = query.accountId;
  if (query.includeVoided !== "true") filter.isVoided = false;

  // ⚠️ Kun chegarasi TOSHKENT bo'yicha — `parseDayRangeFilter` orqali.
  // Ilgari bu yerda `new Date(iso)` + `setHours()` turardi va u HOST
  // taymzonasida ishlagani uchun UTC serverda kunlik tushum ro'yxati
  // hisobot sahifasidagi o'sha kun raqamiga to'g'ri kelmasdi.
  const range = parseDayRangeFilter(query);
  if (range) filter.paidAt = range;

  const search = query.search?.trim();
  if (search) {
    const students = await prisma.user.findMany({
      where: {
        role: ROLES.STUDENT,
        OR: [
          { firstName: { contains: search, mode: "insensitive" } },
          { lastName: { contains: search, mode: "insensitive" } },
          { username: { contains: search, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });

    const ids = students.map((s) => s.id);
    if (ids.length === 0) {
      return {
        ...formatPaginationResponse([], 0, page, limit),
        totals: { count: 0, totalAmount: "0.00" },
      };
    }
    filter.studentId = query.studentId
      ? { in: ids.filter((id) => id === query.studentId) }
      : { in: ids };
  }

  // ⚠️ JAMI summa HAR DOIM bekor qilingan to'lovlarni chiqarib tashlaydi.
  // Bekor qilingan to'lov puli kassaga teskari qator bilan qaytarilgan —
  // demak u "umumiy tushum" emas. Ro'yxatning O'ZI `filter` bo'yicha
  // (so'ralsa voided'ni ham ko'rsatadi), lekin `agg` (jami) hech qachon
  // voided'ni sanamaydi — aks holda tahrirlangan (bekor+qayta) to'lov
  // summasi ikki marta qo'shilib ketardi.
  const activeFilter = { ...filter, isVoided: false };
  const [rows, total, agg] = await Promise.all([
    prisma.payment.findMany({
      where: filter,
      orderBy: [{ paidAt: "desc" }, { receiptNo: "desc" }],
      skip,
      take: limit,
      include: {
        account: true,
        allocations: { where: { isVoided: false } },
      },
    }),
    prisma.payment.count({ where: filter }),
    prisma.payment.aggregate({ where: activeFilter, _sum: { amount: true }, _count: true }),
  ]);

  const studentMap = await loadStudentMap(rows);

  // Taqsimotlarga oy yorlig'ini qo'shish uchun hisob-fakturalar
  const invoiceIds = [...new Set(rows.flatMap((r) => r.allocations.map((a) => a.invoiceId)))];
  const invoices = invoiceIds.length
    ? await prisma.monthlyInvoice.findMany({
        where: { id: { in: invoiceIds } },
        select: { id: true, month: true },
      })
    : [];
  const monthById = new Map(invoices.map((i) => [i.id, i.month]));

  const items = rows.map((row) =>
    serializePayment(row, {
      student: studentMap.get(row.studentId),
      allocations: row.allocations.map((a) => ({
        ...a,
        month: monthById.get(a.invoiceId) ?? null,
      })),
    }),
  );

  return {
    ...formatPaginationResponse(items, total, page, limit),
    totals: {
      count: agg._count ?? 0,
      totalAmount: formatAmount(new Decimal(agg._sum.amount ?? 0)),
    },
  };
};

/**
 * Bitta to'lov — taqsimotlari bilan.
 * @param {string} id
 * @returns {Promise<object>}
 */
const getPaymentById = async (id) => {
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: { account: true, allocations: { orderBy: { appliedAt: "asc" } } },
  });

  if (!payment) throw new NotFoundError("To'lov topilmadi");

  const [student, invoices] = await Promise.all([
    prisma.user.findUnique({ where: { id: payment.studentId }, select: STUDENT_SELECT }),
    payment.allocations.length
      ? prisma.monthlyInvoice.findMany({
          where: { id: { in: payment.allocations.map((a) => a.invoiceId) } },
          select: { id: true, month: true, amount: true, status: true },
        })
      : [],
  ]);

  const invoiceById = new Map(invoices.map((i) => [i.id, i]));

  return serializePayment(payment, {
    student,
    allocations: payment.allocations.map((a) => ({
      ...a,
      month: invoiceById.get(a.invoiceId)?.month ?? null,
      invoiceStatus: invoiceById.get(a.invoiceId)?.status ?? null,
    })),
  });
};

/**
 * Bitta o'quvchining to'lov tarixi.
 * @param {string} studentId
 * @param {{includeVoided?: boolean}} options
 * @returns {Promise<object[]>}
 */
const getStudentPayments = async (studentId, { includeVoided = false } = {}) => {
  const rows = await prisma.payment.findMany({
    where: { studentId, ...(includeVoided ? {} : { isVoided: false }) },
    orderBy: [{ paidAt: "desc" }, { receiptNo: "desc" }],
    include: { account: true, allocations: { where: { isVoided: false } } },
  });

  const invoiceIds = [...new Set(rows.flatMap((r) => r.allocations.map((a) => a.invoiceId)))];
  const invoices = invoiceIds.length
    ? await prisma.monthlyInvoice.findMany({
        where: { id: { in: invoiceIds } },
        select: { id: true, month: true },
      })
    : [];
  const monthById = new Map(invoices.map((i) => [i.id, i.month]));

  return rows.map((row) =>
    serializePayment(row, {
      allocations: row.allocations.map((a) => ({
        ...a,
        month: monthById.get(a.invoiceId) ?? null,
      })),
    }),
  );
};

/**
 * Bitta hisob-fakturaga tushgan to'lovlar (chek raqami bilan).
 * @param {string} invoiceId
 * @param {{includeVoided?: boolean}} options
 * @returns {Promise<object[]>}
 */
const getInvoiceAllocations = async (invoiceId, { includeVoided = false } = {}) => {
  const rows = await prisma.paymentAllocation.findMany({
    where: { invoiceId, ...(includeVoided ? {} : { isVoided: false }) },
    orderBy: { appliedAt: "desc" },
    include: { payment: { include: { account: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    amount: formatAmount(row.amount),
    source: row.source,
    sourceLabel: SOURCE_LABELS[row.source] ?? row.source,
    appliedAt: row.appliedAt,
    isVoided: row.isVoided,
    paymentId: row.paymentId,
    receiptNo: row.payment.receiptNo,
    receiptLabel: `#${String(row.payment.receiptNo).padStart(6, "0")}`,
    paidAt: row.payment.paidAt,
    account: row.payment.account
      ? { id: row.payment.account.id, name: row.payment.account.name }
      : null,
  }));
};

module.exports = {
  TX_OPTIONS,
  SOURCE_LABELS,
  serializePayment,
  serializeAllocation,
  ensureStudentAccount,
  snapshotOf,
  previewPayment,
  createPayment,
  voidPayment,
  updatePaymentNote,
  editPayment,
  getPayments,
  getPaymentById,
  getStudentPayments,
  getInvoiceAllocations,
};
