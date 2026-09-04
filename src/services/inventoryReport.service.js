/**
 * INVENTAR HISOBOTLARI — bo'limning eng KENG kesimi.
 *
 * Bitta ekranda uchta savolga javob:
 *   1) Bazamiz qanday holatda?      (xatlov + yaroqsizlar)
 *   2) Qancha zarar ko'rdik?         (hodisalar + summa)
 *   3) Qanchasini undirdik, qancha qarz qoldi?
 *
 * ⚠️ UNDIRILGAN PUL `getCashflow` BILAN BIR XIL MANBADAN olinadi —
 * `DamagePayment` (bekor qilinmaganlari). Moliya hisobotidagi kirim
 * `AccountEntry` orqali shu to'lovlarni allaqachon sanaydi, ya'ni ikki
 * tab bir xil raqamni ko'rsatadi. Alohida hisob yozilsa, "kassada
 * 1 200 000, inventarda 1 150 000" degan holat chiqardi (`finance.md`
 * §10 → Hisobot).
 *
 * ⚠️ ZARAR SUMMASIDA `cancelled` HISOBGA OLINMAYDI, `waived` esa OLINADI.
 * Bekor qilingani — XATO YOZUV (zarar bo'lmagan). Maktab hisobidan
 * qoplangani esa haqiqiy zarar, faqat undirilmagan. Ikkalasini birga
 * chiqarib tashlash "bu yil qancha zarar ko'rdik" raqamini past
 * ko'rsatardi (`inventoryDamage.service.js` sarlavhasidagi izoh).
 */

const prisma = require("../config/prisma");
const { Decimal, formatAmount, sumAmounts } = require("../helpers/money.helpers");
const { currentDayDate } = require("../helpers/month.helpers");
const {
  LOCATION_TYPE_LABELS,
  displayNameOf,
} = require("../helpers/inventory.helpers");
const { PERSON_SELECT } = require("./damageCharge.service");

/** Filtrdan `occurredAt` oralig'ini quradi (Toshkent kun chegaralari). */
const periodWhere = (query = {}) => {
  if (!query.from && !query.to) return {};

  const range = {};
  if (query.from) range.gte = new Date(`${query.from}T00:00:00+05:00`);
  if (query.to) range.lte = new Date(`${query.to}T23:59:59.999+05:00`);

  return { occurredAt: range };
};

/**
 * UMUMIY MANZARA — bo'limning bosh ekrani.
 * @param {object} query - { from, to }
 */
const getSummary = async (query = {}) => {
  const damageWhere = { status: { not: "cancelled" }, ...periodWhere(query) };

  const paidWhere = { isVoided: false };
  if (query.from || query.to) {
    paidWhere.paidAt = {};
    if (query.from) paidWhere.paidAt.gte = new Date(`${query.from}T00:00:00+05:00`);
    if (query.to) paidWhere.paidAt.lte = new Date(`${query.to}T23:59:59.999+05:00`);
  }

  const today = currentDayDate();

  const [stock, damages, waived, payments, charges, locations, checksToday] =
    await Promise.all([
      prisma.inventoryStock.aggregate({
        _sum: { quantity: true, brokenQuantity: true },
        _count: { _all: true },
      }),
      prisma.inventoryDamage.aggregate({
        where: damageWhere,
        _sum: { amount: true, chargedAmount: true, quantity: true },
        _count: { _all: true },
      }),
      // Maktab o'z zimmasiga olgani — alohida ko'rsatiladi, chunki bu
      // "undirilmaydigan zarar" va boshqaruv qarori
      prisma.inventoryDamage.aggregate({
        where: { ...damageWhere, status: "waived" },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.damagePayment.aggregate({
        where: paidWhere,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      // QARZ QOLDIG'I — davrga bog'liq EMAS: "hozir kim qancha qarzdor"
      // degan savolning javobi o'tgan oy filtridan o'zgarmasligi kerak
      prisma.damageCharge.aggregate({
        where: { status: { in: ["unpaid", "partial"] } },
        _sum: { amount: true, paidAmount: true },
        _count: { _all: true },
      }),
      prisma.inventoryLocation.count({ where: { isArchived: false } }),
      prisma.inventoryCheck.count({ where: { date: today, status: "submitted" } }),
    ]);

  const totalQuantity = stock._sum.quantity ?? 0;
  const brokenQuantity = stock._sum.brokenQuantity ?? 0;

  const damageAmount = new Decimal(damages._sum.amount ?? 0);
  const chargedAmount = new Decimal(damages._sum.chargedAmount ?? 0);
  const recovered = new Decimal(payments._sum.amount ?? 0);

  const outstandingTotal = new Decimal(charges._sum.amount ?? 0);
  const outstandingPaid = new Decimal(charges._sum.paidAmount ?? 0);

  return {
    stock: {
      rows: stock._count._all,
      totalQuantity,
      brokenQuantity,
      serviceableQuantity: totalQuantity - brokenQuantity,
    },
    damage: {
      count: damages._count._all,
      quantity: damages._sum.quantity ?? 0,
      amount: formatAmount(damageAmount),
      // Aybdorlarga yozilgan ulush
      chargedAmount: formatAmount(chargedAmount),
      // Hali hech kimga yozilmagani — "kim to'laydi?" ro'yxati
      unchargedAmount: formatAmount(damageAmount.minus(chargedAmount)),
      waivedCount: waived._count._all,
      waivedAmount: formatAmount(new Decimal(waived._sum.amount ?? 0)),
    },
    recovery: {
      // Kassaga tushgan pul — `getCashflow` bilan bir xil manba
      paymentCount: payments._count._all,
      recoveredAmount: formatAmount(recovered),
      outstandingCount: charges._count._all,
      outstandingAmount: formatAmount(outstandingTotal.minus(outstandingPaid)),
    },
    // Monitoring intizomi — "bugun kim hisobot bermadi" bloki uchun
    monitoring: {
      date: today,
      totalLocations: locations,
      submittedToday: checksToday,
      pendingToday: Math.max(0, locations - checksToday),
    },
  };
};

/**
 * XONA KESIMI — "qaysi xonada ko'proq sinadi".
 * @param {object} query - { from, to, limit }
 */
const getByLocation = async (query = {}) => {
  const limit = Math.min(Number(query.limit) || 20, 100);

  const [damageRows, stockRows, locations] = await Promise.all([
    prisma.inventoryDamage.groupBy({
      by: ["locationId"],
      where: { status: { not: "cancelled" }, ...periodWhere(query) },
      _sum: { amount: true, quantity: true },
      _count: { _all: true },
    }),
    prisma.inventoryStock.groupBy({
      by: ["locationId"],
      _sum: { quantity: true, brokenQuantity: true },
    }),
    prisma.inventoryLocation.findMany({
      where: { isArchived: false },
      select: { id: true, name: true, type: true },
    }),
  ]);

  const damageById = new Map(damageRows.map((r) => [r.locationId, r]));
  const stockById = new Map(stockRows.map((r) => [r.locationId, r]));

  const items = locations.map((location) => {
    const damage = damageById.get(location.id);
    const stock = stockById.get(location.id);

    const totalQuantity = stock?._sum.quantity ?? 0;
    const brokenQuantity = stock?._sum.brokenQuantity ?? 0;

    return {
      locationId: location.id,
      locationName: location.name,
      type: location.type,
      typeLabel: LOCATION_TYPE_LABELS[location.type] ?? location.type,
      totalQuantity,
      brokenQuantity,
      serviceableQuantity: totalQuantity - brokenQuantity,
      damageCount: damage?._count._all ?? 0,
      damageQuantity: damage?._sum.quantity ?? 0,
      damageAmount: formatAmount(new Decimal(damage?._sum.amount ?? 0)),
      // Saralash uchun xom qiymat (string bilan taqqoslash noto'g'ri bo'lardi)
      _sortAmount: new Decimal(damage?._sum.amount ?? 0),
    };
  });

  items.sort((a, b) => b._sortAmount.comparedTo(a._sortAmount));

  return {
    items: items.slice(0, limit).map(({ _sortAmount, ...rest }) => rest),
  };
};

/**
 * JIHOZ KESIMI — "nima ko'p sinadi va bu bizga qancha turadi".
 * @param {object} query - { from, to, limit }
 */
const getByItem = async (query = {}) => {
  const limit = Math.min(Number(query.limit) || 20, 100);

  const rows = await prisma.inventoryDamage.groupBy({
    by: ["itemId", "kind"],
    where: { status: { not: "cancelled" }, ...periodWhere(query) },
    _sum: { amount: true, quantity: true },
    _count: { _all: true },
  });

  if (rows.length === 0) return { items: [] };

  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.itemId))] } },
    select: { id: true, name: true, unit: true, category: { select: { name: true } } },
  });
  const itemById = new Map(items.map((i) => [i.id, i]));

  // Tur bo'yicha ajratilgan qatorlarni jihoz bo'yicha yig'amiz
  const merged = new Map();

  for (const row of rows) {
    const key = row.itemId;
    const current = merged.get(key) ?? {
      itemId: key,
      itemName: itemById.get(key)?.name ?? "Noma'lum",
      unit: itemById.get(key)?.unit ?? "dona",
      categoryName: itemById.get(key)?.category?.name ?? null,
      count: 0,
      quantity: 0,
      brokenQuantity: 0,
      missingQuantity: 0,
      amount: new Decimal(0),
    };

    current.count += row._count._all;
    current.quantity += row._sum.quantity ?? 0;
    current.amount = current.amount.plus(new Decimal(row._sum.amount ?? 0));

    if (row.kind === "missing") current.missingQuantity += row._sum.quantity ?? 0;
    else current.brokenQuantity += row._sum.quantity ?? 0;

    merged.set(key, current);
  }

  const list = [...merged.values()].sort((a, b) => b.amount.comparedTo(a.amount));

  return {
    items: list.slice(0, limit).map((row) => ({
      ...row,
      amount: formatAmount(row.amount),
    })),
  };
};

/**
 * QARZDORLAR — kim qancha qarzdor.
 *
 * `debtors` (o'qish to'lovi qarzdorlari) bilan CHALKASHMASIN: u yerda
 * hisob-faktura qarzi, bu yerda moddiy zarar qarzi. Ikkalasi ham "qarz",
 * lekin manbasi va undirish jarayoni butunlay boshqa — shuning uchun
 * ro'yxat ham alohida.
 *
 * @param {object} query - { overdueOnly, limit }
 */
const getDebtors = async (query = {}) => {
  const limit = Math.min(Number(query.limit) || 50, 200);

  const where = { status: { in: ["unpaid", "partial"] } };
  if (query.overdueOnly === "true") where.dueDate = { lt: new Date() };

  const rows = await prisma.damageCharge.groupBy({
    by: ["personId"],
    where,
    _sum: { amount: true, paidAmount: true },
    _count: { _all: true },
  });

  if (rows.length === 0) return { items: [], totals: { count: 0, amount: "0.00" } };

  const people = await prisma.user.findMany({
    where: { id: { in: rows.map((r) => r.personId) } },
    select: PERSON_SELECT,
  });
  const peopleById = new Map(people.map((p) => [p.id, p]));

  // Suratdan foydalanish — o'chirilgan foydalanuvchi ham ro'yxatda qolsin
  const snapshots = await prisma.damageCharge.findMany({
    where: { personId: { in: rows.map((r) => r.personId) } },
    distinct: ["personId"],
    select: { personId: true, personSnapshot: true, personRole: true },
  });
  const snapshotById = new Map(snapshots.map((s) => [s.personId, s]));

  const items = rows
    .map((row) => {
      const person = peopleById.get(row.personId);
      const snapshot = snapshotById.get(row.personId);
      const remaining = new Decimal(row._sum.amount ?? 0).minus(row._sum.paidAmount ?? 0);

      return {
        personId: row.personId,
        personName: displayNameOf(person, snapshot?.personSnapshot),
        role: person?.role ?? snapshot?.personRole ?? null,
        className: snapshot?.personSnapshot?.className ?? null,
        chargeCount: row._count._all,
        amount: formatAmount(new Decimal(row._sum.amount ?? 0)),
        paidAmount: formatAmount(new Decimal(row._sum.paidAmount ?? 0)),
        remainingAmount: formatAmount(remaining),
        _sort: remaining,
      };
    })
    .sort((a, b) => b._sort.comparedTo(a._sort));

  const totalRemaining = sumAmounts(items.map((i) => i._sort));

  return {
    items: items.slice(0, limit).map(({ _sort, ...rest }) => rest),
    totals: {
      count: items.length,
      amount: formatAmount(totalRemaining),
    },
  };
};

/**
 * MONITORING INTIZOMI — "kim hisobot bermadi" davr bo'yicha.
 *
 * Kunlik "bugun kim bermadi" ro'yxati `inventoryCheck.service.js` da
 * (`getPendingLocations`); bu esa DAVR bo'yicha kesim: har bir xona
 * nechta kundan nechtasida hisobot berdi.
 *
 * @param {object} query - { from, to }
 */
const getMonitoringReport = async (query = {}) => {
  const where = { status: "submitted" };
  if (query.from || query.to) {
    where.date = {};
    if (query.from) where.date.gte = new Date(`${query.from}T00:00:00.000Z`);
    if (query.to) where.date.lte = new Date(`${query.to}T00:00:00.000Z`);
  }

  const [rows, locations] = await Promise.all([
    prisma.inventoryCheck.groupBy({
      by: ["locationId"],
      where,
      _sum: { brokenCount: true, missingCount: true, damageAmount: true },
      _count: { _all: true },
    }),
    prisma.inventoryLocation.findMany({
      where: { isArchived: false },
      select: { id: true, name: true, type: true, responsibleId: true },
    }),
  ]);

  const byId = new Map(rows.map((r) => [r.locationId, r]));

  const responsibleIds = [...new Set(locations.map((l) => l.responsibleId).filter(Boolean))];
  const people = responsibleIds.length
    ? await prisma.user.findMany({
        where: { id: { in: responsibleIds } },
        select: PERSON_SELECT,
      })
    : [];
  const peopleById = new Map(people.map((p) => [p.id, p]));

  return {
    items: locations.map((location) => {
      const row = byId.get(location.id);
      const responsible = peopleById.get(location.responsibleId);

      return {
        locationId: location.id,
        locationName: location.name,
        typeLabel: LOCATION_TYPE_LABELS[location.type] ?? location.type,
        responsibleName: responsible ? displayNameOf(responsible) : null,
        checkCount: row?._count._all ?? 0,
        brokenCount: row?._sum.brokenCount ?? 0,
        missingCount: row?._sum.missingCount ?? 0,
        damageAmount: formatAmount(new Decimal(row?._sum.damageAmount ?? 0)),
      };
    }),
  };
};

module.exports = {
  getSummary,
  getByLocation,
  getByItem,
  getDebtors,
  getMonitoringReport,
};
