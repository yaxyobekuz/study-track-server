/**
 * OYLIK TO'LOVI — `payment.service.js` ning chiqim tomonidagi ko'zgusi.
 *
 * ⚠️ IKKI MUHIM FARQ:
 *
 * 1. DEPOZIT YO'Q. O'quvchida ortiqcha pul depozitga tushadi; xodimda esa
 *    QARZDAN ORTIQ TO'LOV RAD ETILADI. Avans tushunchasi qo'shilmagani
 *    uchun ortiqcha pulni saqlaydigan joy ham kerak emas — aks holda
 *    xodimda ikkinchi "hamyon" paydo bo'lardi.
 *
 * 2. PUL KASSADAN CHIQADI. Daftar qatori MANFIY (`salary_payment`),
 *    `assertSignMatchesType` buni invariant sifatida tekshiradi.
 *
 * ⚠️ LOCK TARTIBI:  PayrollEntry (month asc, id asc)  →  PaymentAccount
 * Kassa OXIRGI — o'quvchi to'lovi bilan bir vaqtda kelganda deadlock
 * bo'lmasligi shunga bog'liq (`finance.md` §8).
 *
 * Bitta oylikni BIR NECHA MARTA to'lash mumkin: qoldiq `paidAmount` da
 * yig'iladi va holat `partial` → `paid` ga o'tadi.
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
const logger = require("../utils/logger");
const {
  Decimal,
  parseAmount,
  formatAmount,
  sumAmounts,
} = require("../helpers/money.helpers");
const {
  formatMonthKey,
  parseDayRangeFilter,
  parseRecordedAt,
} = require("../helpers/month.helpers");
const { allocateFifo, deriveStatus } = require("../helpers/allocation.helpers");
const { postEntry, assertActiveAccount } = require("./paymentAccount.service");
const { assertStaff, STAFF_SELECT } = require("./staffSalary.service");
const { TX_OPTIONS } = require("./payment.service");

const snapshotOf = (staff) => ({
  firstName: staff.firstName,
  lastName: staff.lastName ?? "",
  username: staff.username,
  role: staff.role,
});

const serializePayment = (row, { staff, account, allocations } = {}) => ({
  ...row,
  amount: formatAmount(row.amount),
  staff: staff ?? null,
  staffName: staff
    ? `${staff.firstName} ${staff.lastName ?? ""}`.trim()
    : `${row.staffSnapshot?.firstName ?? ""} ${row.staffSnapshot?.lastName ?? ""}`.trim() ||
      "Noma'lum",
  accountName: account?.name ?? null,
  ...(allocations
    ? {
        allocations: allocations.map((a) => ({
          id: a.id,
          payrollEntryId: a.payrollEntryId,
          amount: formatAmount(a.amount),
          month: a.payrollEntry?.month ?? null,
          monthLabel: a.payrollEntry ? formatMonthKey(a.payrollEntry.month) : null,
          appliedAt: a.appliedAt,
        })),
      }
    : {}),
});

/** Sana kelajakda bo'la olmaydi — `payment.service.js` bilan BIR XIL qoida. */
const parsePaidAt = (value) => parseRecordedAt(value, { subject: "to'lov" });

/**
 * Taqsimotni OLDINDAN ko'rsatadi — kassir "bu pul qaysi oylarga ketadi"
 * degan savolga to'lovdan OLDIN javob oladi.
 *
 * @param {object} data - { staffId, amount }
 */
const previewPayment = async (data) => {
  const staff = await assertStaff(data.staffId);
  const amount = parseAmount(data.amount, "Summa");

  const entries = await prisma.payrollEntry.findMany({
    where: { staffId: staff.id, status: { in: ["unpaid", "partial"] } },
    orderBy: [{ month: "asc" }, { id: "asc" }],
  });

  const outstanding = sumAmounts(
    entries.map((e) => new Decimal(e.amount).minus(e.paidAmount)),
  );

  const { allocations, allocated, remainder } = allocateFifo(
    entries,
    amount,
    new Date(),
  );

  return {
    staff,
    amount: formatAmount(amount),
    outstanding: formatAmount(outstanding),
    allocated: formatAmount(allocated),
    // Ortiqcha qism — to'lov RAD ETILADI, bu faqat ogohlantirish uchun
    excess: formatAmount(remainder),
    exceedsDebt: remainder.greaterThan(0),
    allocations: allocations.map((a) => ({
      payrollEntryId: a.invoiceId,
      month: a.month,
      monthLabel: formatMonthKey(a.month),
      amount: formatAmount(a.amount),
      status: a.status,
    })),
  };
};

/**
 * Oylik to'lovi.
 *
 * @param {object} data - { staffId, accountId, amount, paidAt, note }
 * @param {string} userId
 */
const createPayment = async (data, userId) => {
  const amount = parseAmount(data.amount, "Summa");
  if (amount.lessThanOrEqualTo(0)) {
    throw new BadRequestError("To'lov summasi noldan katta bo'lishi kerak");
  }

  const [staff, account] = await Promise.all([
    assertStaff(data.staffId),
    assertActiveAccount(data.accountId),
  ]);

  const paidAt = parsePaidAt(data.paidAt);

  const result = await prisma.$transaction(async (tx) => {
    // 1 ── OYLIK MAJBURIYATLARI — lock tartibining birinchi bo'g'ini.
    //      `month asc, id asc` — FIFO ham, lock tartibi ham shu bilan
    //      determinlashadi.
    const entries = await tx.payrollEntry.findMany({
      where: { staffId: staff.id, status: { in: ["unpaid", "partial"] } },
      orderBy: [{ month: "asc" }, { id: "asc" }],
    });

    const outstanding = sumAmounts(
      entries.map((e) => new Decimal(e.amount).minus(e.paidAmount)),
    );

    // 2 ── ⚠️ QARZDAN ORTIQ TO'LOV RAD ETILADI.
    //      Avans yo'q, shuning uchun ortiqcha pulni qo'yadigan joy ham yo'q.
    if (amount.greaterThan(outstanding)) {
      throw new BadRequestError(
        outstanding.isZero()
          ? `${staff.firstName} ga to'lanmagan oylik yo'q — avval majburiyat shakllantiring`
          : `To'lov qarzdan ko'p: qarz ${formatAmount(outstanding)}, ` +
            `to'lov ${formatAmount(amount)}. Avans qo'llab-quvvatlanmaydi.`,
      );
    }

    // 3 ── Chek qatori (taqsimotlar uchun id kerak)
    const payment = await tx.salaryPayment.create({
      data: {
        staffId: staff.id,
        accountId: account.id,
        amount,
        paidAt,
        note: data.note?.trim() || "",
        staffSnapshot: snapshotOf(staff),
        createdBy: userId,
      },
    });

    // 4 ── FIFO — eng eski oylikdan boshlab
    const { allocations, allocated } = allocateFifo(entries, amount, paidAt);

    if (allocations.length > 0) {
      await tx.salaryAllocation.createMany({
        data: allocations.map((a) => ({
          paymentId: payment.id,
          // ⚠️ `allocateFifo` umumiy helper: natijani `invoiceId` deb
          // qaytaradi. Bu yerda u oylik majburiyatining id'si.
          payrollEntryId: a.invoiceId,
          staffId: staff.id,
          amount: a.amount,
          appliedAt: paidAt,
        })),
      });
    }

    // 5 ── Har bir majburiyat: COMPARE-AND-SWAP.
    //      Yo'qolgan yangilanish strukturaviy IMKONSIZ bo'ladi.
    //
    // ⚠️ `amount` HAM SOLISHTIRILADI. To'lanmagan qatorning summasi ushlab
    // qolish qo'shilganda/bekor qilinganda qayta yoziladi
    // (`payrollDeduction.service`). Faqat `paidAmount` tekshirilsa, shu
    // orada kamaygan summaga eski qarz bo'yicha pul yozilib, ortiqcha
    // to'lov paydo bo'lardi.
    const amountById = new Map(entries.map((e) => [e.id, e.amount]));

    for (const allocation of allocations) {
      const updated = await tx.payrollEntry.updateMany({
        where: {
          id: allocation.invoiceId,
          amount: amountById.get(allocation.invoiceId),
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
          "Oylik majburiyati shu orada o'zgardi — qaytadan urinib ko'ring",
        );
      }
    }

    // 6 ── KASSA — lock tartibining OXIRGI bo'g'ini. Pul CHIQADI → manfiy.
    await postEntry(tx, {
      accountId: account.id,
      type: "salary_payment",
      amount: amount.negated(),
      occurredAt: paidAt,
      salaryPaymentId: payment.id,
      note: `Oylik — ${staff.firstName} ${staff.lastName ?? ""}`.trim(),
      createdBy: userId,
    });

    return { payment, allocated, allocations };
  }, TX_OPTIONS);

  logger.info(
    `[salary] To'lov: ${formatAmount(amount)} · ${staff.firstName} ` +
      `${staff.lastName ?? ""} · ${account.name} · actor=${userId}`,
  );

  return {
    ...serializePayment(result.payment, { staff, account }),
    allocatedAmount: formatAmount(result.allocated),
    allocations: result.allocations.map((a) => ({
      payrollEntryId: a.invoiceId,
      month: a.month,
      monthLabel: formatMonthKey(a.month),
      amount: formatAmount(a.amount),
    })),
  };
};

/**
 * To'lovni bekor qilish.
 *
 * Uch narsa BIRGA qaytariladi: taqsimotlar bekor qilinadi, majburiyatlar
 * qarzga qaytadi, kassaga teskari qator yoziladi. Ularning biri qolib
 * ketsa hisobot va kassa bir-biriga to'g'ri kelmasdi.
 */
const voidPayment = async (id, reason, userId) => {
  const payment = await prisma.salaryPayment.findUnique({ where: { id } });
  if (!payment) throw new NotFoundError("To'lov topilmadi");
  if (payment.isVoided) throw new BadRequestError("To'lov allaqachon bekor qilingan");

  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError("Bekor qilish sababi majburiy");

  await prisma.$transaction(async (tx) => {
    // 1 ── Chekni bekor qilish — CAS (ikki marta bekor qilish poygasi)
    const voided = await tx.salaryPayment.updateMany({
      where: { id, isVoided: false },
      data: {
        isVoided: true,
        voidedAt: new Date(),
        voidedBy: userId,
        voidReason: trimmed,
      },
    });

    if (voided.count !== 1) {
      throw new ConflictError("To'lov allaqachon bekor qilingan");
    }

    // 2 ── Taqsimotlar — MAJBURIYAT TARTIBIDA (lock tartibi saqlanadi)
    const allocations = await tx.salaryAllocation.findMany({
      where: { paymentId: id, isVoided: false },
      include: { payrollEntry: true },
      orderBy: [{ payrollEntry: { month: "asc" } }, { payrollEntryId: "asc" }],
    });

    for (const allocation of allocations) {
      const entry = allocation.payrollEntry;
      const previousPaid = new Decimal(entry.paidAmount);
      const newPaid = previousPaid.minus(allocation.amount);

      if (newPaid.isNegative()) {
        throw new ConflictError(
          "Oylik majburiyatining to'langan summasi manfiy bo'lib qoladi",
        );
      }

      const updated = await tx.payrollEntry.updateMany({
        where: { id: entry.id, paidAmount: previousPaid },
        data: {
          paidAmount: newPaid,
          status: deriveStatus(new Decimal(entry.amount), newPaid),
          paidAt: newPaid.isZero() ? null : entry.paidAt,
        },
      });

      if (updated.count !== 1) {
        throw new ConflictError(
          "Oylik majburiyati shu orada o'zgardi — qaytadan urinib ko'ring",
        );
      }
    }

    await tx.salaryAllocation.updateMany({
      where: { paymentId: id, isVoided: false },
      data: { isVoided: true, voidedAt: new Date() },
    });

    // 3 ── KASSA — teskari qator (pul qaytadi → musbat)
    await postEntry(tx, {
      accountId: payment.accountId,
      type: "salary_payment_void",
      amount: new Decimal(payment.amount),
      occurredAt: new Date(),
      salaryPaymentId: payment.id,
      note: `Bekor qilindi: ${trimmed}`,
      createdBy: userId,
    });
  }, TX_OPTIONS);

  // ⚠️ AUDIT YOZUVI TRANZAKSIYADAN KEYIN — `payment.voidPayment` dagi bir
  // xil qoida: CAS yoki majburiyat poygasi tufayli rad etilgan urinish
  // logda BAJARILGAN bekor qilish bo'lib qolmasligi kerak.
  logger.warn(
    `[salary] To'lov bekor qilindi: payment=${id} staff=${payment.staffId} ` +
      `summa=${formatAmount(payment.amount)} actor=${userId} sabab="${trimmed}"`,
  );

  const fresh = await prisma.salaryPayment.findUnique({ where: { id } });
  return serializePayment(fresh);
};

/**
 * To'lovni TAHRIRLASH — "1 000 000 o'rniga adashib 2 000 000 kiritilgan".
 * Summa, sana, to'lov turi va izoh o'zgaradi; xodim O'ZGARMAYDI (boshqa
 * odamga yozilgan to'lov bekor qilinib, to'g'ri xodimga qaytadan kiritiladi).
 *
 * ⚠️ Daftar APPEND-ONLY — joyida o'zgartirish yo'q. Eski to'lov BEKOR
 * QILINADI (sababi "Tahrirlandi: ...") va to'g'ri qiymat bilan YANGI to'lov
 * yoziladi. Ikkalasi ham registrda qoladi. Faqat izoh o'zgarsa — pulga
 * tegmagani uchun joyida yangilanadi.
 *
 * ⚠️ BITTA TRANZAKSIYADA (o'quvchi tomonidagi `payment.editPayment` ham
 * endi shunday). Void va create ketma-ket chaqirilsa, qarzdan ko'p yangi summa
 * rad etilganda eski to'lov bekor bo'lib, yangisi yozilmay qolardi — xodim
 * jimgina "to'lanmagan" bo'lib, kassa qoldig'i o'zgarib ketardi.
 *
 * ⚠️ LOCK TARTIBI saqlanadi: bo'shatish va yangi taqsimot XOTIRADA
 * birlashtiriladi, har bir majburiyat BIR MARTA (month asc, id asc) yoziladi,
 * kassa(lar) esa oxirida — ikki xil to'lov turi bo'lsa `id` o'sish tartibida.
 *
 * @param {string} id
 * @param {object} data - { amount?, accountId?, paidAt?, note?, reason }
 * @param {string} userId
 */
const editPayment = async (id, data, userId) => {
  const existing = await prisma.salaryPayment.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("To'lov topilmadi");
  if (existing.isVoided) {
    throw new BadRequestError("Bekor qilingan to'lovni tahrirlab bo'lmaydi");
  }

  const reason = data.reason?.trim();
  if (!reason) throw new BadRequestError("Tahrirlash sababi majburiy");

  const hasValue = (value) => value != null && value !== "";

  const amount = hasValue(data.amount)
    ? parseAmount(data.amount, "Summa")
    : new Decimal(existing.amount);
  if (amount.lessThanOrEqualTo(0)) {
    throw new BadRequestError("To'lov summasi noldan katta bo'lishi kerak");
  }

  const accountId = data.accountId || existing.accountId;
  // Sana yuborilmasa eskisi qoladi (vaqti bilan) — kun o'zgarmagan bo'lsa
  // frontend uni yubormaydi
  const paidAt = hasValue(data.paidAt) ? parsePaidAt(data.paidAt) : existing.paidAt;
  const note = data.note != null ? String(data.note).trim() : existing.note;

  const moneyChanged =
    !amount.equals(existing.amount) ||
    accountId !== existing.accountId ||
    paidAt.getTime() !== existing.paidAt.getTime();

  if (!moneyChanged) {
    if (note === existing.note) throw new BadRequestError("Hech narsa o'zgarmadi");

    const updated = await prisma.salaryPayment.update({ where: { id }, data: { note } });
    return serializePayment(updated);
  }

  const account = await assertActiveAccount(accountId);
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    // 1 ── Eski chek — CAS (parallel bekor qilish / tahrirlash poygasi)
    const voided = await tx.salaryPayment.updateMany({
      where: { id, isVoided: false },
      data: {
        isVoided: true,
        voidedAt: now,
        voidedBy: userId,
        voidReason: `Tahrirlandi: ${reason}`,
      },
    });

    if (voided.count !== 1) {
      throw new ConflictError("To'lov shu orada bekor qilingan yoki tahrirlangan");
    }

    // 2 ── Eski taqsimotlar: qaysi oylikdan qancha pul bo'shaydi
    const oldAllocations = await tx.salaryAllocation.findMany({
      where: { paymentId: id, isVoided: false },
    });

    const released = new Map();
    for (const a of oldAllocations) {
      const sum = released.get(a.payrollEntryId) ?? new Decimal(0);
      released.set(a.payrollEntryId, sum.plus(a.amount));
    }

    // 3 ── Tegishli majburiyatlar: bo'shaydiganlari + ochiq qarzlar
    const entries = await tx.payrollEntry.findMany({
      where: {
        staffId: existing.staffId,
        OR: [
          { status: { in: ["unpaid", "partial"] } },
          { id: { in: [...released.keys()] } },
        ],
      },
      orderBy: [{ month: "asc" }, { id: "asc" }],
    });

    // Eski to'lov bo'shatilgandan keyingi holat — faqat xotirada
    const afterRelease = entries.map((entry) => {
      const paid = new Decimal(entry.paidAmount).minus(released.get(entry.id) ?? 0);
      if (paid.isNegative()) {
        throw new ConflictError(
          "Oylik majburiyatining to'langan summasi manfiy bo'lib qoladi",
        );
      }
      const status = deriveStatus(new Decimal(entry.amount), paid);
      return {
        ...entry,
        paidAmount: paid,
        status,
        paidAt: status === "paid" ? entry.paidAt : null,
      };
    });

    const candidates = afterRelease.filter((_, i) => entries[i].status !== "cancelled");
    const outstanding = sumAmounts(
      candidates.map((e) => Decimal.max(0, new Decimal(e.amount).minus(e.paidAmount))),
    );

    // ⚠️ QARZDAN ORTIQ TO'LOV RAD ETILADI — `createPayment` bilan AYNI qoida.
    // Tranzaksiya orqaga qaytadi: eski to'lov ham o'z holida qoladi.
    if (amount.greaterThan(outstanding)) {
      throw new BadRequestError(
        `Yangi summa qarzdan ko'p: bu to'lovsiz qarz ${formatAmount(outstanding)}, ` +
          `yangi summa ${formatAmount(amount)}. Avans qo'llab-quvvatlanmaydi.`,
      );
    }

    const { allocations, allocated } = allocateFifo(candidates, amount, paidAt);
    const allocationByEntry = new Map(allocations.map((a) => [a.invoiceId, a]));

    // 4 ── Har bir majburiyat BIR MARTA, month asc/id asc — CAS
    for (let i = 0; i < entries.length; i++) {
      const original = entries[i];
      const allocation = allocationByEntry.get(original.id);
      if (!allocation && !released.has(original.id)) continue;

      const next = allocation
        ? {
            paidAmount: allocation.newPaidAmount,
            status: allocation.status,
            paidAt: allocation.paidAt,
          }
        : {
            paidAmount: afterRelease[i].paidAmount,
            status: afterRelease[i].status,
            paidAt: afterRelease[i].paidAt,
          };

      const updated = await tx.payrollEntry.updateMany({
        where: {
          id: original.id,
          amount: original.amount,
          paidAmount: original.paidAmount,
          status: original.status,
        },
        data: next,
      });

      if (updated.count !== 1) {
        throw new ConflictError(
          "Oylik majburiyati shu orada o'zgardi — qaytadan urinib ko'ring",
        );
      }
    }

    await tx.salaryAllocation.updateMany({
      where: { paymentId: id, isVoided: false },
      data: { isVoided: true, voidedAt: now },
    });

    // 5 ── Yangi chek va taqsimotlari
    const payment = await tx.salaryPayment.create({
      data: {
        staffId: existing.staffId,
        accountId: account.id,
        amount,
        paidAt,
        note,
        staffSnapshot: existing.staffSnapshot,
        createdBy: userId,
      },
    });

    if (allocations.length > 0) {
      await tx.salaryAllocation.createMany({
        data: allocations.map((a) => ({
          paymentId: payment.id,
          payrollEntryId: a.invoiceId,
          staffId: existing.staffId,
          amount: a.amount,
          appliedAt: paidAt,
        })),
      });
    }

    // 6 ── KASSA — OXIRGI. Ikki xil to'lov turi bo'lsa `id` o'sish tartibida.
    const staffLabel =
      `${existing.staffSnapshot?.firstName ?? ""} ${existing.staffSnapshot?.lastName ?? ""}`.trim();

    const postReversal = () =>
      postEntry(tx, {
        accountId: existing.accountId,
        type: "salary_payment_void",
        amount: new Decimal(existing.amount),
        occurredAt: now,
        salaryPaymentId: existing.id,
        note: `Tahrirlandi: ${reason}`,
        createdBy: userId,
      });

    const postPayment = () =>
      postEntry(tx, {
        accountId: account.id,
        type: "salary_payment",
        amount: amount.negated(),
        occurredAt: paidAt,
        salaryPaymentId: payment.id,
        note: `Oylik — ${staffLabel}`,
        createdBy: userId,
      });

    if (existing.accountId <= account.id) {
      await postReversal();
      await postPayment();
    } else {
      await postPayment();
      await postReversal();
    }

    return { payment, allocations, allocated };
  }, TX_OPTIONS);

  // Audit — tranzaksiyadan KEYIN (`voidPayment` bilan bir xil tartib)
  logger.warn(
    `[salary] To'lov tahrirlandi: eski=${id} (${formatAmount(existing.amount)}) → ` +
      `yangi=${result.payment.id} (${formatAmount(amount)}) staff=${existing.staffId} ` +
      `actor=${userId} sabab="${reason}"`,
  );

  return {
    ...serializePayment(result.payment, { account }),
    replacedPaymentId: id,
    allocatedAmount: formatAmount(result.allocated),
    allocations: result.allocations.map((a) => ({
      payrollEntryId: a.invoiceId,
      month: a.month,
      monthLabel: formatMonthKey(a.month),
      amount: formatAmount(a.amount),
    })),
  };
};

/** To'lovlar registri (sahifalangan). */
const getPayments = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const includeVoided = query.includeVoided === "true";

  const where = {};
  if (query.staffId) where.staffId = query.staffId;
  if (query.accountId) where.accountId = query.accountId;
  if (!includeVoided) where.isVoided = false;
  // Bitta oylikka tushgan to'lovlar ("Majburiyatlar" qatoridan tahrirlash uchun)
  if (query.payrollEntryId) {
    where.allocations = {
      some: {
        payrollEntryId: query.payrollEntryId,
        ...(includeVoided ? {} : { isVoided: false }),
      },
    };
  }

  // Kun chegarasi TOSHKENT bo'yicha — modul bo'ylab bitta manbadan
  // (yaroqsiz sana ham shu yerda rad etiladi, Prisma'ga tushmaydi)
  const range = parseDayRangeFilter(query);
  if (range) where.paidAt = range;

  const [rows, total, agg] = await Promise.all([
    prisma.salaryPayment.findMany({
      where,
      orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
      include: {
        account: { select: { name: true } },
        allocations: {
          where: { isVoided: false },
          include: { payrollEntry: { select: { month: true } } },
        },
      },
    }),
    prisma.salaryPayment.count({ where }),
    prisma.salaryPayment.aggregate({
      where: { ...where, isVoided: false },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const staff = rows.length
    ? await prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.staffId))] } },
        select: STAFF_SELECT,
      })
    : [];
  const staffMap = new Map(staff.map((s) => [s.id, s]));

  return {
    ...formatPaginationResponse(
      rows.map(({ account, allocations, ...row }) =>
        serializePayment(row, {
          staff: staffMap.get(row.staffId),
          account,
          allocations,
        }),
      ),
      total,
      page,
      limit,
    ),
    totals: {
      amount: formatAmount(new Decimal(agg._sum.amount ?? 0)),
      count: agg._count._all,
    },
  };
};

module.exports = {
  serializePayment,
  previewPayment,
  createPayment,
  voidPayment,
  editPayment,
  getPayments,
};
