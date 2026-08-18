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
const { formatMonthKey } = require("../helpers/month.helpers");
const {
  postEntry,
  assertActiveAccount,
  serializeAccount,
} = require("./paymentAccount.service");

// 20 oylik qarzi bor o'quvchi + oy boshidagi kassa navbati Prisma'ning
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

const parsePaidAt = (value) => {
  if (value == null || value === "") return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestError("To'lov sanasi noto'g'ri");
  if (date.getTime() > Date.now() + 60_000) {
    throw new BadRequestError("Kelajakdagi sana bilan to'lov qayd etib bo'lmaydi");
  }
  return date;
};

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
    await tx.studentAccount.update({
      where: { studentId: student.id },
      data: { version: { increment: 1 } },
    });

    // 2 ── Lock OSTIDA o'qish. Lock'dan oldin o'qilgan ma'lumot ishonchsiz.
    //      `status` bo'yicha filtr: 0 so'mlik grant `paid` bo'lgani uchun
    //      nomzodlar orasiga tushmaydi.
    const invoices = await tx.monthlyInvoice.findMany({
      where: { studentId: student.id, status: { in: ["unpaid", "partial"] } },
      orderBy: [{ month: "asc" }, { id: "asc" }],
    });

    // 3 ── Chek qatori (taqsimotlar uchun id kerak)
    const payment = await tx.payment.create({
      data: {
        studentId: student.id,
        accountId: account.id,
        amount,
        allocatedAmount: 0,
        depositAmount: amount,
        paidAt,
        note: data.note?.trim() || "",
        studentSnapshot: snapshotOf(student),
        createdBy: userId,
      },
    });

    // 4 ── FIFO (sof Decimal; tenglik funksiya ichida tekshiriladi)
    const { allocations, allocated, remainder } = allocateFifo(invoices, amount, paidAt);

    // 5 ── Taqsimotlar bitta operatorda
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

    // 6 ── Har bir hisob-faktura: COMPARE-AND-SWAP
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
        throw new ConflictError(
          "Hisob-faktura holati o'zgardi. To'lovni qayta kiriting.",
        );
      }
    }

    // 7 ── Hosila summalar
    await tx.payment.update({
      where: { id: payment.id },
      data: { allocatedAmount: allocated, depositAmount: remainder },
    });

    if (remainder.greaterThan(0)) {
      await tx.studentAccount.update({
        where: { studentId: student.id },
        data: { balance: { increment: remainder } },
      });
    }

    // 8 ── KASSA — HAR DOIM OXIRGI (lock tartibi)
    await postEntry(tx, {
      accountId: account.id,
      type: "payment",
      amount,
      occurredAt: paidAt,
      paymentId: payment.id,
      note: data.note?.trim() || "",
      createdBy: userId,
    });

    return { payment, allocations, allocated, remainder };
  }, TX_OPTIONS);

  const fresh = await prisma.payment.findUnique({
    where: { id: result.payment.id },
    include: { account: true },
  });

  return {
    ...serializePayment(fresh, {
      student,
      allocations: result.allocations.map((a) => ({
        invoiceId: a.invoiceId,
        month: a.month,
        amount: a.amount,
        source: "payment",
      })),
    }),
    summary: {
      allocatedAmount: formatAmount(result.allocated),
      depositAmount: formatAmount(result.remainder),
      closedCount: result.allocations.filter((a) => a.status === "paid").length,
    },
  };
};

/**
 * To'lovni bekor qiladi (soft void).
 *
 * SHU chekning barcha taqsimotlari qaytariladi — keyinroq depozitdan
 * qo'llangan (`source: deposit`) qatorlar ham. Aynan shu sababli
 * "depozit allaqachon sarflangan" holati muammo bo'lmaydi.
 *
 * YAGONA qolgan teshik: chekning depozit qismi ALLAQACHON ota-onaga
 * qaytarilgan bo'lsa. To'liq lot-tracking maktab uchun ortiqcha, shuning
 * uchun aniq xabar bilan RAD ETILADI — jim tuzatilmaydi.
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

  logger.warn(
    `[payments] To'lov bekor qilindi: payment=${id} chek=#${payment.receiptNo} ` +
      `student=${payment.studentId} summa=${payment.amount.toFixed(2)} ` +
      `actor=${userId} sabab="${trimmed}"`,
  );

  const result = await prisma.$transaction(async (tx) => {
    // 1 ── O'QUVCHI LOCK'I (createPayment bilan bir xil tartibda)
    const account = await tx.studentAccount.update({
      where: { studentId: payment.studentId },
      data: { version: { increment: 1 } },
    });

    // 2 ── Lock ostida qayta o'qish
    const fresh = await tx.payment.findUnique({
      where: { id },
      include: { allocations: { where: { isVoided: false } } },
    });
    if (fresh.isVoided) throw new ConflictError("To'lov allaqachon bekor qilingan");

    const allocatedNow = sumAmounts(fresh.allocations.map((a) => a.amount));
    const depositHeld = new Decimal(fresh.amount).minus(allocatedNow);

    // 3 ── Depozit qismi qaytarib yuborilganmi?
    if (depositHeld.greaterThan(account.balance)) {
      throw new BadRequestError(
        `Bu to'lovning ${formatAmount(depositHeld)} so'mi depozitda qolmagan ` +
          "(qaytarilgan yoki to'g'rilangan). Avval o'sha amalni bekor qiling.",
      );
    }

    // 4 ── Chekni bekor qilish — CAS (ikki marta bekor qilish poygasi)
    const voided = await tx.payment.updateMany({
      where: { id, isVoided: false },
      data: {
        isVoided: true,
        voidedAt: new Date(),
        voidedBy: userId,
        voidReason: trimmed,
        allocatedAmount: 0,
        depositAmount: 0,
      },
    });
    if (voided.count !== 1) throw new ConflictError("To'lov allaqachon bekor qilingan");

    await tx.paymentAllocation.updateMany({
      where: { paymentId: id, isVoided: false },
      data: { isVoided: true, voidedAt: new Date() },
    });

    // 5 ── Hisob-fakturalarni orqaga qaytarish (CAS bilan)
    const reopened = [];
    for (const allocation of fresh.allocations) {
      const invoice = await tx.monthlyInvoice.findUnique({
        where: { id: allocation.invoiceId },
      });
      if (!invoice) continue;

      const newPaid = new Decimal(invoice.paidAmount).minus(allocation.amount);
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

    // 6 ── Sarflanmagan depozit qismini yechish (3-qadam manfiyga tushmasligini kafolatladi)
    if (depositHeld.greaterThan(0)) {
      await tx.studentAccount.update({
        where: { studentId: payment.studentId },
        data: { balance: { decrement: depositHeld } },
      });
    }

    // 7 ── KASSA — oxirgi. `occurredAt` = HOZIR, `payment.paidAt` EMAS:
    //      pul kassadan BUGUN chiqadi va kunlik hisobot shunga tayanadi.
    await postEntry(tx, {
      accountId: payment.accountId,
      type: "payment_void",
      amount: new Decimal(payment.amount).negated(),
      occurredAt: new Date(),
      paymentId: payment.id,
      note: trimmed,
      createdBy: userId,
    });

    return { reopened, depositReversed: depositHeld };
  }, TX_OPTIONS);

  return {
    message: "To'lov bekor qilindi",
    reopened: result.reopened.map((r) => ({ ...r, monthLabel: formatMonthKey(r.month) })),
    depositReversed: formatAmount(result.depositReversed),
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
 * To'lovlar registri — kassaning kunlik/oylik hisoboti.
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

  if (query.from || query.to) {
    filter.paidAt = {};
    if (query.from) {
      const from = new Date(query.from);
      if (Number.isNaN(from.getTime())) throw new BadRequestError("Boshlanish sanasi noto'g'ri");
      filter.paidAt.gte = from;
    }
    if (query.to) {
      const to = new Date(query.to);
      if (Number.isNaN(to.getTime())) throw new BadRequestError("Tugash sanasi noto'g'ri");
      to.setHours(23, 59, 59, 999);
      filter.paidAt.lte = to;
    }
  }

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
    prisma.payment.aggregate({ where: filter, _sum: { amount: true } }),
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
      count: total,
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
  getPayments,
  getPaymentById,
  getStudentPayments,
  getInvoiceAllocations,
};
