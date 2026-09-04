/**
 * AYBDORGA YOZILGAN QARZ — `payroll.service.js` ning ko'zgusi, faqat pul
 * TESKARI yo'nalishda: u yerda biz to'laymiz, bu yerda bizga to'lanadi.
 *
 * Foydalanuvchi talabining aynan shu qismi:
 *   "Moddiy zarar summasi aybdor shaxsga toʻliq undirilguniga qadar uning
 *    hisobida jarima/qarzdorlik sifatida aks etib turishi lozim."
 *
 * Shuning uchun bu registr — o'quvchi/xodim profilidagi "qarzdorlik"
 * blokining YAGONA manbai (`getPersonSummary`).
 *
 * ── NIMA UCHUN HISOB-FAKTURAGA QO'SHILMAYDI ──
 *
 * `MonthlyInvoice` — TARIF majburiyati va uning summasi
 * `proratedAmount − discountAmount` ga TENG bo'lishi har kecha
 * tekshiriladigan invariant (`finance.md` §9.4). Zararni o'sha qatorga
 * qo'shsak, invariant birinchi singan partada buzilardi. Ustiga-ustak,
 * aybdor XODIM ham bo'lishi mumkin — xodimda esa hisob-faktura umuman yo'q.
 *
 * ── BIR ZARAR, BIR NECHTA AYBDOR ─────────────
 *
 * "Derazani uchovi birga sindirdi" — odatiy hol. Shuning uchun bitta
 * zararga bir nechta qarz yoziladi va ularning yig'indisi zarar
 * summasidan OSHMASLIGI tekshiriladi (`syncChargedAmount` esa zarardagi
 * `chargedAmount` ni qayta hisoblaydi).
 *
 * ⚠️ SUMMA MUHRLANADI. Uni o'zgartiradigan endpoint YO'Q: xato bo'lsa
 * qarz bekor qilinadi va yangisi yoziladi.
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
const { parseOptionalDayDate } = require("../helpers/month.helpers");
const {
  parseOptionalQuantity,
  personSnapshotOf,
  displayNameOf,
  CHARGE_STATUS_LABELS,
  DAMAGE_KIND_LABELS,
} = require("../helpers/inventory.helpers");
const { TX_OPTIONS } = require("./inventoryStock.service");
const {
  assertChargeableDamage,
  syncChargedAmount,
} = require("./inventoryDamage.service");

const PERSON_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  role: true,
  isArchived: true,
  isActive: true,
};

const serializeCharge = (row, { person, damage } = {}) => {
  const { damage: included, ...rest } = row;
  const source = damage ?? included;

  const amount = new Decimal(row.amount);
  const paidAmount = new Decimal(row.paidAmount);
  // Bekor qilingan qarzda "qoldiq" tushunchasi yo'q — u qarz emas
  const remaining = row.status === "cancelled" ? new Decimal(0) : amount.minus(paidAmount);

  return {
    ...rest,
    amount: formatAmount(row.amount),
    paidAmount: formatAmount(row.paidAmount),
    remainingAmount: formatAmount(remaining),
    statusLabel: CHARGE_STATUS_LABELS[row.status] ?? row.status,
    isOverdue:
      row.dueDate != null &&
      row.status !== "paid" &&
      row.status !== "cancelled" &&
      row.dueDate.getTime() < Date.now(),
    person: person ?? null,
    personName: displayNameOf(person, row.personSnapshot),
    ...(source
      ? {
          damage: {
            id: source.id,
            kind: source.kind,
            kindLabel: DAMAGE_KIND_LABELS[source.kind] ?? source.kind,
            quantity: source.quantity,
            occurredAt: source.occurredAt,
            itemName: source.item?.name ?? source.itemSnapshot?.name ?? null,
            locationName: source.location?.name ?? source.locationSnapshot?.name ?? null,
          },
        }
      : {}),
  };
};

/**
 * Aybdor mavjudligini tekshiradi.
 *
 * ⚠️ ARXIVLANGAN/NOFAOL ODAM HAM QARZDOR BO'LA OLADI — va bu oylik
 * tomonining TESKARISI. Oylikda arxivlangan xodimga majburiyat
 * YOZILMAYDI ("ketgan odamga to'lamaymiz"), bu yerda esa aksincha:
 * maktabdan ketgan o'quvchi singan derazani to'lashi kerak. O'quvchi
 * tomonidagi "o'chirilgan login qarzni bekor qilmaydi" qoidasi bilan
 * bir xil mulohaza (`education.md` §4).
 */
const assertPerson = async (personId) => {
  if (!personId) throw new BadRequestError("Aybdor tanlanmagan");

  const person = await prisma.user.findUnique({
    where: { id: personId },
    select: PERSON_SELECT,
  });
  if (!person) throw new NotFoundError("Foydalanuvchi topilmadi");

  return person;
};

/** O'quvchi bo'lsa sinfi ham suratga tushadi (hisobot kesimi uchun). */
const classNameOf = async (person) => {
  const link = await prisma.userClass.findFirst({
    where: { userId: person.id },
    include: { class: { select: { name: true } } },
  });
  return link?.class?.name ?? null;
};

/**
 * Summani N kishiga TENG bo'ladi, qoldiqni BIRINCHISIGA qo'shadi.
 *
 * Yaxlitlash qoidasi bitta joyda bo'lishi shart: 100 000 ni 3 ga bo'lganda
 * 33 333.33 × 3 = 99 999.99 chiqadi va 1 tiyin yo'qolardi. Yo'qolgan tiyin
 * `chargedAmount !== amount` degan invariant buzilishiga olib kelardi.
 *
 * @param {Prisma.Decimal} total
 * @param {number} count
 * @returns {Prisma.Decimal[]}
 */
const splitAmount = (total, count) => {
  const base = total.div(count).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  const parts = Array.from({ length: count }, () => base);
  const remainder = total.minus(base.times(count));

  parts[0] = parts[0].plus(remainder);
  return parts;
};

/**
 * Zararni aybdor(lar)ga yozadi.
 *
 * `amount` berilmagan bo'lsa — zararning YOZILMAGAN qoldig'i kiritilgan
 * odamlar orasida TENG bo'linadi (`splitAmount`).
 *
 * @param {string} damageId
 * @param {object} data - { people: [{ personId, amount, quantity, note }], dueDate, note }
 * @param {string} userId
 */
const createCharges = async (damageId, data, userId) => {
  const rawPeople = Array.isArray(data.people) ? data.people : [];
  if (rawPeople.length === 0) {
    throw new BadRequestError("Kamida bitta aybdor tanlanishi kerak");
  }

  const damage = await assertChargeableDamage(null, damageId);

  // Bitta odam ikki marta — "aka-uka 20%" muammosining shu yerdagi ko'rinishi
  const seen = new Set();
  const people = [];

  for (const raw of rawPeople) {
    const person = await assertPerson(raw.personId);
    if (seen.has(person.id)) {
      throw new BadRequestError(
        `${person.firstName} ro'yxatda ikki marta kelgan`,
      );
    }
    seen.add(person.id);

    people.push({
      person,
      // Berilmagan bo'lsa keyinroq teng bo'linadi
      amount: raw.amount != null && raw.amount !== "" ? parseAmount(raw.amount, "Summa") : null,
      quantity: parseOptionalQuantity(raw.quantity, "Miqdor"),
      note: raw.note?.trim() || data.note?.trim() || "",
    });
  }

  const dueDate = parseOptionalDayDate(data.dueDate, "To'lash muddati");

  const result = await prisma.$transaction(async (tx) => {
    // Zararni QAYTA o'qiymiz — tranzaksiyadan tashqarida boshqa qarz
    // yozilgan bo'lishi mumkin
    const fresh = await tx.inventoryDamage.findUnique({ where: { id: damageId } });
    if (!fresh) throw new NotFoundError("Zarar yozuvi topilmadi");
    if (fresh.status === "cancelled" || fresh.status === "waived") {
      throw new ConflictError("Zarar holati shu orada o'zgardi");
    }

    const existing = await tx.damageCharge.findMany({
      where: { damageId, status: { not: "cancelled" } },
      select: { amount: true },
    });

    const total = new Decimal(fresh.amount);
    const alreadyCharged = sumAmounts(existing.map((c) => c.amount));
    const available = total.minus(alreadyCharged);

    if (available.lessThanOrEqualTo(0)) {
      throw new BadRequestError(
        `Zarar to'liq taqsimlangan: ${formatAmount(total)} dan ` +
          `${formatAmount(alreadyCharged)} yozilgan`,
      );
    }

    // Summasi berilmaganlar qoldiqni TENG bo'lishadi
    const unset = people.filter((p) => p.amount == null);
    if (unset.length > 0) {
      const fixed = sumAmounts(people.filter((p) => p.amount != null).map((p) => p.amount));
      const toSplit = available.minus(fixed);

      if (toSplit.lessThanOrEqualTo(0)) {
        throw new BadRequestError(
          "Kiritilgan summalar zarardan oshib ketdi — summalarni tekshiring",
        );
      }

      const parts = splitAmount(toSplit, unset.length);
      unset.forEach((p, i) => {
        p.amount = parts[i];
      });
    }

    const requested = sumAmounts(people.map((p) => p.amount));

    // ⚠️ ASOSIY INVARIANT: ulushlar yig'indisi zarardan OSHMAYDI.
    // Aks holda maktab ko'rgan zararidan ko'proq pul undirardi.
    if (requested.greaterThan(available)) {
      throw new BadRequestError(
        `Yozilayotgan summa qoldiqdan ko'p: qoldiq ${formatAmount(available)}, ` +
          `yozilmoqchi ${formatAmount(requested)}`,
      );
    }

    const created = [];

    // Determinlashgan tartib — parallel yozuvlarda lock tartibi barqaror
    const ordered = [...people].sort((a, b) => a.person.id.localeCompare(b.person.id));

    for (const entry of ordered) {
      if (entry.amount.lessThanOrEqualTo(0)) {
        throw new BadRequestError(
          `${entry.person.firstName} uchun summa noldan katta bo'lishi kerak`,
        );
      }

      const className = await classNameOf(entry.person);

      const charge = await tx.damageCharge.create({
        data: {
          damageId,
          personId: entry.person.id,
          personRole: entry.person.role,
          personSnapshot: personSnapshotOf(entry.person, className),
          quantity: entry.quantity,
          amount: entry.amount,
          note: entry.note,
          dueDate,
          createdBy: userId,
        },
      });

      created.push({ charge, person: entry.person });
    }

    // Zarardagi `chargedAmount` va holat — HOSILA, shu yerda qayta hisoblanadi
    await syncChargedAmount(tx, damageId);

    return created;
  }, TX_OPTIONS);

  logger.info(
    `[damage] Qarz yozildi: damage=${damageId} · ${result.length} ta aybdor · ` +
      `jami ${formatAmount(sumAmounts(result.map((r) => r.charge.amount)))} · actor=${userId}`,
  );

  return result.map(({ charge, person }) => serializeCharge(charge, { person }));
};

/**
 * Qarzlar registri (sahifalangan).
 * @param {object} req - query: { personId, damageId, status, overdue, from, to, page, limit }
 */
const getCharges = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const where = {};
  if (query.personId) where.personId = query.personId;
  if (query.damageId) where.damageId = query.damageId;
  if (query.personRole) where.personRole = query.personRole;

  if (query.status) where.status = query.status;
  else if (query.includeCancelled !== "true") where.status = { not: "cancelled" };

  // "Qarzdorlar" kesimi — hali to'lanmagan qarzlar
  if (query.outstanding === "true") where.status = { in: ["unpaid", "partial"] };
  if (query.overdue === "true") {
    where.dueDate = { lt: new Date() };
    where.status = { in: ["unpaid", "partial"] };
  }

  if (query.from || query.to) {
    where.createdAt = {};
    if (query.from) where.createdAt.gte = new Date(`${query.from}T00:00:00+05:00`);
    if (query.to) where.createdAt.lte = new Date(`${query.to}T23:59:59.999+05:00`);
  }

  const [rows, total, agg] = await Promise.all([
    prisma.damageCharge.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      skip,
      take: limit,
      include: {
        damage: {
          select: {
            id: true,
            kind: true,
            quantity: true,
            occurredAt: true,
            itemSnapshot: true,
            locationSnapshot: true,
            item: { select: { name: true } },
            location: { select: { name: true } },
          },
        },
      },
    }),
    prisma.damageCharge.count({ where }),
    // Jami — SAHIFA bo'yicha emas, butun filtr bo'yicha. Bekor
    // qilinganlari HISOBGA OLINMAYDI.
    prisma.damageCharge.aggregate({
      where: { ...where, status: { not: "cancelled" } },
      _sum: { amount: true, paidAmount: true },
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

  const amount = new Decimal(agg._sum.amount ?? 0);
  const paid = new Decimal(agg._sum.paidAmount ?? 0);

  return {
    ...formatPaginationResponse(
      rows.map((row) => serializeCharge(row, { person: peopleById.get(row.personId) })),
      total,
      page,
      limit,
    ),
    totals: {
      count: agg._count._all,
      amount: formatAmount(amount),
      paidAmount: formatAmount(paid),
      remainingAmount: formatAmount(amount.minus(paid)),
    },
  };
};

/**
 * BITTA ODAMNING MODDIY ZARAR QARZI — profildagi "qarzdorlik" bloki.
 *
 * Talabning "uning hisobida ... aks etib turishi lozim" qismi aynan shu
 * javob orqali bajariladi: qoldiq nolga tushmaguncha `hasDebt` rost
 * bo'lib turadi.
 *
 * @param {string} personId
 */
const getPersonSummary = async (personId) => {
  const person = await assertPerson(personId);

  const charges = await prisma.damageCharge.findMany({
    where: { personId, status: { not: "cancelled" } },
    orderBy: [{ createdAt: "desc" }],
    include: {
      damage: {
        select: {
          id: true,
          kind: true,
          quantity: true,
          occurredAt: true,
          itemSnapshot: true,
          locationSnapshot: true,
          item: { select: { name: true } },
          location: { select: { name: true } },
        },
      },
    },
  });

  const totalAmount = sumAmounts(charges.map((c) => c.amount));
  const paidAmount = sumAmounts(charges.map((c) => c.paidAmount));
  const remaining = totalAmount.minus(paidAmount);

  const outstanding = charges.filter((c) => c.status !== "paid");
  const overdue = outstanding.filter(
    (c) => c.dueDate != null && c.dueDate.getTime() < Date.now(),
  );

  return {
    person,
    personName: displayNameOf(person),
    totals: {
      count: charges.length,
      outstandingCount: outstanding.length,
      overdueCount: overdue.length,
      amount: formatAmount(totalAmount),
      paidAmount: formatAmount(paidAmount),
      remainingAmount: formatAmount(remaining),
    },
    // Profil ekrani shu bayroqqa qarab qizil belgini chizadi
    hasDebt: remaining.greaterThan(0),
    charges: charges.map((row) => serializeCharge(row, { person })),
  };
};

/** Bitta qarz + uning to'lov taqsimotlari. */
const getChargeById = async (id) => {
  const charge = await prisma.damageCharge.findUnique({
    where: { id },
    include: {
      damage: {
        select: {
          id: true,
          kind: true,
          quantity: true,
          occurredAt: true,
          amount: true,
          itemSnapshot: true,
          locationSnapshot: true,
          item: { select: { name: true } },
          location: { select: { name: true } },
        },
      },
      allocations: {
        where: { isVoided: false },
        orderBy: { appliedAt: "desc" },
        include: { payment: { select: { receiptNo: true, paidAt: true, accountId: true } } },
      },
    },
  });
  if (!charge) throw new NotFoundError("Qarz topilmadi");

  const { allocations, ...rest } = charge;
  const person = await prisma.user
    .findUnique({ where: { id: charge.personId }, select: PERSON_SELECT })
    .catch(() => null);

  return {
    ...serializeCharge(rest, { person }),
    allocations: allocations.map((a) => ({
      id: a.id,
      amount: formatAmount(a.amount),
      appliedAt: a.appliedAt,
      receiptNo: a.payment?.receiptNo ?? null,
      paidAt: a.payment?.paidAt ?? null,
    })),
  };
};

/**
 * Muddatni yoki izohni to'g'rilash.
 *
 * ⚠️ SUMMA BU YERDA YO'Q va bo'lmasligi ham kerak — u muhrlangan
 * (`payroll.service.js` da oylik summasini o'zgartiradigan endpoint
 * yo'qligi bilan bir xil qaror). Xato summa → bekor qilish + qayta yozish.
 */
const updateCharge = async (id, data, userId) => {
  const charge = await prisma.damageCharge.findUnique({ where: { id } });
  if (!charge) throw new NotFoundError("Qarz topilmadi");
  if (charge.status === "cancelled") {
    throw new BadRequestError("Bekor qilingan qarzni tahrirlab bo'lmaydi");
  }

  const payload = {};
  if (data.note !== undefined) payload.note = data.note?.trim() || "";
  if (data.dueDate !== undefined) {
    payload.dueDate = parseOptionalDayDate(data.dueDate, "To'lash muddati");
  }

  if (Object.keys(payload).length === 0) {
    throw new BadRequestError("O'zgartirish uchun ma'lumot yo'q");
  }

  await prisma.damageCharge.update({ where: { id }, data: payload });
  logger.info(`[damage] Qarz tahrirlandi: charge=${id} actor=${userId}`);

  return getChargeById(id);
};

/**
 * BEKOR QILISH.
 *
 * ⚠️ To'lov tushgan qarzni bekor qilib bo'lmaydi — avval to'lov bekor
 * qilinadi (`payroll.service.js → cancelEntry` bilan aynan bir xil
 * qoida). Aks holda taqsimot qatorlari "yo'q" qarzga ishora qilib
 * qolardi va kassa qoldig'i bilan registr bir-biriga to'g'ri kelmasdi.
 */
const cancelCharge = async (id, reason, userId) => {
  const charge = await prisma.damageCharge.findUnique({ where: { id } });
  if (!charge) throw new NotFoundError("Qarz topilmadi");
  if (charge.status === "cancelled") {
    throw new BadRequestError("Qarz allaqachon bekor qilingan");
  }

  if (new Decimal(charge.paidAmount).greaterThan(0)) {
    throw new BadRequestError(
      "Bu qarzga to'lov tushgan — avval to'lovni bekor qiling",
    );
  }

  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError("Bekor qilish sababi majburiy");

  logger.warn(
    `[damage] Qarz bekor qilindi: charge=${id} person=${charge.personId} ` +
      `summa=${formatAmount(charge.amount)} actor=${userId} sabab="${trimmed}"`,
  );

  await prisma.$transaction(async (tx) => {
    const cancelled = await tx.damageCharge.updateMany({
      where: { id, status: { in: ["unpaid", "partial"] } },
      data: {
        status: "cancelled",
        cancelReason: trimmed,
        cancelledAt: new Date(),
        cancelledBy: userId,
      },
    });
    if (cancelled.count !== 1) {
      throw new ConflictError("Qarz holati shu orada o'zgardi — qaytadan urinib ko'ring");
    }

    // Zarardagi `chargedAmount` kamayadi va holat `pending` ga qaytishi mumkin
    await syncChargedAmount(tx, charge.damageId);
  }, TX_OPTIONS);

  return getChargeById(id);
};

module.exports = {
  PERSON_SELECT,
  serializeCharge,
  splitAmount,
  assertPerson,
  createCharges,
  getCharges,
  getChargeById,
  getPersonSummary,
  updateCharge,
  cancelCharge,
};
