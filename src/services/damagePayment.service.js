/**
 * ZARAR UNDIRUVI — `salaryPayment.service.js` ning ko'zgusi, LEKIN PUL
 * KASSAGA KIRADI.
 *
 * ⚠️ UCH MUHIM QOIDA:
 *
 * 1. DEPOZIT YO'Q va AVANS YO'Q. Qarzdan ortiq to'lov RAD ETILADI.
 *    O'quvchining o'qish to'lovida ortiqcha pul depozitga tushadi, chunki
 *    keyingi oy majburiyati ANIQ keladi. Zararda esa "keyingi zarar"
 *    degan narsa yo'q — ortiqcha pulni saqlaydigan joy ochilsa, u ikkinchi
 *    "hamyon" bo'lib depozit bilan chalkashardi va `StudentAccount.balance`
 *    invarianti (`= Σ Payment.depositAmount`) buzilardi.
 *
 * 2. PUL KASSAGA KIRADI. Daftar qatori MUSBAT (`damage_payment`),
 *    `assertSignMatchesType` buni invariant sifatida tekshiradi.
 *
 * 3. LOCK TARTIBI:  DamageCharge (createdAt asc, id asc)  →  PaymentAccount
 *    Kassa OXIRGI — o'quvchi to'lovi, xodim oyligi va zarar undiruvi bir
 *    vaqtda kelganda deadlock aynan shu sababli bo'lmaydi (`finance.md` §8).
 *
 * Bo'lib to'lash MUMKIN: bitta qarz bir necha marta to'lanadi
 * (`partial` → `paid`).
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
const { allocateFifo, deriveStatus } = require("../helpers/allocation.helpers");
const {
  personSnapshotOf,
  displayNameOf,
} = require("../helpers/inventory.helpers");
const { postEntry, assertActiveAccount } = require("./paymentAccount.service");
const { assertPerson, PERSON_SELECT } = require("./damageCharge.service");
const { TX_OPTIONS } = require("./inventoryStock.service");

// FIFO ham, lock tartibi ham SHU tartibdan kelib chiqadi: eng eski qarz
// birinchi yopiladi va parallel to'lovlar qatorlarni bir xil ketma-ketlikda
// lock qiladi.
const CHARGE_ORDER = [{ createdAt: "asc" }, { id: "asc" }];

const serializePayment = (row, { person, account, allocations } = {}) => ({
  ...row,
  amount: formatAmount(row.amount),
  person: person ?? null,
  personName: displayNameOf(person, row.personSnapshot),
  accountName: account?.name ?? null,
  ...(allocations
    ? {
        allocations: allocations.map((a) => ({
          id: a.id,
          chargeId: a.chargeId,
          amount: formatAmount(a.amount),
          appliedAt: a.appliedAt,
          itemName:
            a.charge?.damage?.item?.name ??
            a.charge?.damage?.itemSnapshot?.name ??
            null,
        })),
      }
    : {}),
});

/** Sana kelajakda bo'la olmaydi (`payment.service.js` bilan bir xil qoida). */
const parsePaidAt = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new BadRequestError("Sana noto'g'ri");
  if (date.getTime() > Date.now()) {
    throw new BadRequestError("Kelajakdagi sana bilan to'lov qayd etib bo'lmaydi");
  }
  return date;
};

/**
 * Taqsimotni OLDINDAN ko'rsatadi — kassir "bu pul qaysi zararlarga ketadi"
 * degan savolga to'lovdan OLDIN javob oladi.
 *
 * @param {object} data - { personId, amount }
 */
const previewPayment = async (data) => {
  const person = await assertPerson(data.personId);
  const amount = parseAmount(data.amount, "Summa");

  const charges = await prisma.damageCharge.findMany({
    where: { personId: person.id, status: { in: ["unpaid", "partial"] } },
    orderBy: CHARGE_ORDER,
    include: {
      damage: {
        select: { itemSnapshot: true, item: { select: { name: true } } },
      },
    },
  });

  const outstanding = sumAmounts(
    charges.map((c) => new Decimal(c.amount).minus(c.paidAmount)),
  );

  const { allocations, allocated, remainder } = allocateFifo(charges, amount, new Date());
  const byId = new Map(charges.map((c) => [c.id, c]));

  return {
    person,
    personName: displayNameOf(person),
    amount: formatAmount(amount),
    outstanding: formatAmount(outstanding),
    allocated: formatAmount(allocated),
    // Ortiqcha qism — to'lov RAD ETILADI, bu faqat ogohlantirish uchun
    excess: formatAmount(remainder),
    exceedsDebt: remainder.greaterThan(0),
    allocations: allocations.map((a) => {
      const charge = byId.get(a.invoiceId);
      return {
        chargeId: a.invoiceId,
        amount: formatAmount(a.amount),
        status: a.status,
        itemName:
          charge?.damage?.item?.name ?? charge?.damage?.itemSnapshot?.name ?? null,
      };
    }),
  };
};

/**
 * Undiruvni qayd etadi.
 *
 * @param {object} data - { personId, accountId, amount, paidAt, note }
 * @param {string} userId
 */
const createPayment = async (data, userId) => {
  const amount = parseAmount(data.amount, "Summa");
  if (amount.lessThanOrEqualTo(0)) {
    throw new BadRequestError("To'lov summasi noldan katta bo'lishi kerak");
  }

  const [person, account] = await Promise.all([
    assertPerson(data.personId),
    assertActiveAccount(data.accountId),
  ]);

  const paidAt = parsePaidAt(data.paidAt);

  const result = await prisma.$transaction(async (tx) => {
    // 1 ── QARZLAR — lock tartibining birinchi bo'g'ini.
    //      `createdAt asc, id asc` — FIFO ham, lock tartibi ham shu bilan
    //      determinlashadi.
    const charges = await tx.damageCharge.findMany({
      where: { personId: person.id, status: { in: ["unpaid", "partial"] } },
      orderBy: CHARGE_ORDER,
    });

    const outstanding = sumAmounts(
      charges.map((c) => new Decimal(c.amount).minus(c.paidAmount)),
    );

    // 2 ── ⚠️ QARZDAN ORTIQ TO'LOV RAD ETILADI (yuqoridagi 1-qoida)
    if (amount.greaterThan(outstanding)) {
      throw new BadRequestError(
        outstanding.isZero()
          ? `${person.firstName} da to'lanmagan moddiy zarar qarzi yo'q`
          : `To'lov qarzdan ko'p: qarz ${formatAmount(outstanding)}, ` +
            `to'lov ${formatAmount(amount)}. Avans qo'llab-quvvatlanmaydi.`,
      );
    }

    const className = person.role === "student"
      ? (
          await tx.userClass.findFirst({
            where: { userId: person.id },
            include: { class: { select: { name: true } } },
          })
        )?.class?.name ?? null
      : null;

    // 3 ── Chek qatori (taqsimotlar uchun id kerak)
    const payment = await tx.damagePayment.create({
      data: {
        personId: person.id,
        accountId: account.id,
        amount,
        paidAt,
        note: data.note?.trim() || "",
        personSnapshot: personSnapshotOf(person, className),
        createdBy: userId,
      },
    });

    // 4 ── FIFO — eng eski qarzdan boshlab
    const { allocations } = allocateFifo(charges, amount, paidAt);

    if (allocations.length > 0) {
      await tx.damageAllocation.createMany({
        data: allocations.map((a) => ({
          paymentId: payment.id,
          // ⚠️ `allocateFifo` umumiy helper: natijani `invoiceId` deb
          // qaytaradi. Bu yerda u qarz yozuvining id'si.
          chargeId: a.invoiceId,
          personId: person.id,
          amount: a.amount,
          appliedAt: paidAt,
        })),
      });
    }

    // 5 ── Har bir qarz: COMPARE-AND-SWAP.
    //      Yo'qolgan yangilanish strukturaviy IMKONSIZ bo'ladi.
    for (const allocation of allocations) {
      const updated = await tx.damageCharge.updateMany({
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
        throw new ConflictError("Qarz shu orada o'zgardi — qaytadan urinib ko'ring");
      }
    }

    // 6 ── KASSA — lock tartibining OXIRGI bo'g'ini. Pul KIRADI → musbat.
    await postEntry(tx, {
      accountId: account.id,
      type: "damage_payment",
      amount,
      occurredAt: paidAt,
      damagePaymentId: payment.id,
      note: `Moddiy zarar — ${displayNameOf(person)}`,
      createdBy: userId,
    });

    return { payment, allocations };
  }, TX_OPTIONS);

  logger.info(
    `[damage] Undiruv: ${formatAmount(amount)} · ${displayNameOf(person)} · ` +
      `${account.name} · chek=${result.payment.receiptNo} · actor=${userId}`,
  );

  return {
    ...serializePayment(result.payment, { person, account }),
    allocations: result.allocations.map((a) => ({
      chargeId: a.invoiceId,
      amount: formatAmount(a.amount),
      status: a.status,
    })),
  };
};

/**
 * To'lovni bekor qilish.
 *
 * Uch narsa BIRGA qaytariladi: taqsimotlar bekor qilinadi, qarzlar
 * qarzga qaytadi, kassaga teskari qator yoziladi. Ularning biri qolib
 * ketsa registr va kassa bir-biriga to'g'ri kelmasdi.
 */
const voidPayment = async (id, reason, userId) => {
  const payment = await prisma.damagePayment.findUnique({ where: { id } });
  if (!payment) throw new NotFoundError("To'lov topilmadi");
  if (payment.isVoided) throw new BadRequestError("To'lov allaqachon bekor qilingan");

  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError("Bekor qilish sababi majburiy");

  logger.warn(
    `[damage] Undiruv bekor qilindi: payment=${id} person=${payment.personId} ` +
      `summa=${formatAmount(payment.amount)} actor=${userId} sabab="${trimmed}"`,
  );

  await prisma.$transaction(async (tx) => {
    // 1 ── Chekni bekor qilish — CAS (ikki marta bekor qilish poygasi)
    const voided = await tx.damagePayment.updateMany({
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

    // 2 ── Taqsimotlar — QARZ TARTIBIDA (lock tartibi saqlanadi)
    const allocations = await tx.damageAllocation.findMany({
      where: { paymentId: id, isVoided: false },
      include: { charge: true },
      orderBy: [{ charge: { createdAt: "asc" } }, { chargeId: "asc" }],
    });

    for (const allocation of allocations) {
      const charge = allocation.charge;
      const previousPaid = new Decimal(charge.paidAmount);
      const newPaid = previousPaid.minus(allocation.amount);

      if (newPaid.isNegative()) {
        throw new ConflictError("Qarzning to'langan summasi manfiy bo'lib qoladi");
      }

      const updated = await tx.damageCharge.updateMany({
        where: { id: charge.id, paidAmount: previousPaid },
        data: {
          paidAmount: newPaid,
          status: deriveStatus(new Decimal(charge.amount), newPaid),
          paidAt: newPaid.isZero() ? null : charge.paidAt,
        },
      });

      if (updated.count !== 1) {
        throw new ConflictError("Qarz shu orada o'zgardi — qaytadan urinib ko'ring");
      }
    }

    await tx.damageAllocation.updateMany({
      where: { paymentId: id, isVoided: false },
      data: { isVoided: true, voidedAt: new Date() },
    });

    // 3 ── KASSA — teskari qator (pul chiqadi → manfiy)
    await postEntry(tx, {
      accountId: payment.accountId,
      type: "damage_payment_void",
      amount: new Decimal(payment.amount).negated(),
      occurredAt: new Date(),
      damagePaymentId: payment.id,
      note: `Bekor qilindi: ${trimmed}`,
      createdBy: userId,
    });
  }, TX_OPTIONS);

  const fresh = await prisma.damagePayment.findUnique({ where: { id } });
  return serializePayment(fresh);
};

/** Undiruvlar registri (sahifalangan). */
const getPayments = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const where = {};
  if (query.personId) where.personId = query.personId;
  if (query.accountId) where.accountId = query.accountId;
  if (query.includeVoided !== "true") where.isVoided = false;

  if (query.from || query.to) {
    where.paidAt = {};
    if (query.from) where.paidAt.gte = new Date(`${query.from}T00:00:00+05:00`);
    if (query.to) where.paidAt.lte = new Date(`${query.to}T23:59:59.999+05:00`);
  }

  const [rows, total, agg] = await Promise.all([
    prisma.damagePayment.findMany({
      where,
      orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
      include: {
        account: { select: { name: true } },
        allocations: {
          where: { isVoided: false },
          include: {
            charge: {
              select: {
                damage: {
                  select: { itemSnapshot: true, item: { select: { name: true } } },
                },
              },
            },
          },
        },
      },
    }),
    prisma.damagePayment.count({ where }),
    prisma.damagePayment.aggregate({
      where: { ...where, isVoided: false },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const people = rows.length
    ? await prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.personId))] } },
        select: PERSON_SELECT,
      })
    : [];
  const peopleById = new Map(people.map((p) => [p.id, p]));

  return {
    ...formatPaginationResponse(
      rows.map(({ account, allocations, ...row }) =>
        serializePayment(row, {
          person: peopleById.get(row.personId),
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
  getPayments,
};
