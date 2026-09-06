/**
 * INVENTAR DASHBOARDI — bitta ekranda butun moddiy-texnik bazaning manzarasi.
 *
 * `financeDashboard.service.js` va `academicDashboard.service.js` ning
 * uchinchi ko'zgusi: u yerda pul harakati, u yerda baho va davomat, bu
 * yerda esa MULK — nima bor, qanday holatda, qancha yo'qotdik va
 * qanchasini qaytardik.
 *
 * ⚠️ BU FAYL HECH NARSA YOZMAYDI. Faqat mavjud jadvallarni yig'adi:
 *   xatlov     → `InventoryStock` (+ `InventoryMovement` — o'tmishga qaytish)
 *   zarar      → `InventoryDamage`
 *   undiruv    → `DamagePayment` / `DamageCharge`
 *   monitoring → `InventoryCheck`
 *   katalog    → `InventoryItem` / `InventoryCategory` / `InventoryLocation`
 *
 * ⚠️ O'TGAN OYNING HOLATI DAFTARDAN QAYTA TIKLANADI, alohida ustunda
 * saqlanmaydi. `InventoryStock.quantity` — BUGUNGI holat; oy oxiridagi
 * holat esa `quantity − Σ delta(occurredAt > oy oxiri)`. Aynan shu sabab
 * `InventoryMovement` append-only va `quantityAfter` post-image saqlaydi
 * (`schema.prisma` dagi izoh). Snapshot jadvali qo'shilsa, ikkita
 * haqiqat manbai bo'lib qolardi — invariant har kecha tekshiriladigan
 * `financeReconcile` doktrinasiga zid.
 *
 * ⚠️ ZARAR SUMMASIDA `cancelled` HISOBGA OLINMAYDI, `waived` esa OLINADI —
 * `inventoryReport.service.js` bilan AYNAN bir xil qoida: bekor qilingani
 * xato yozuv, maktab hisobidan qoplangani esa haqiqiy zarar.
 *
 * ⚠️ UNDIRILGAN PUL `getCashflow` BILAN BIR XIL MANBADAN — `DamagePayment`
 * (bekor qilinmaganlari). Ikki tab bir xil raqamni ko'rsatishi shart
 * (`finance.md` §10 → Hisobot).
 *
 * ⚠️ SANA IKKI XIL KOORDINATADA va ular ARALASHTIRILMAYDI:
 *   instant (`occurredAt`, `paidAt`) → Toshkent ofseti bilan chegara
 *   `@db.Date` (`InventoryCheck.date`) → UTC yarim tuni
 * Ikkalasini bitta oraliq bilan so'rasak, oyning birinchi kunidagi
 * hodisalar o'tgan oyga tushib ketardi (`finance.md` §0).
 */

const prisma = require("../config/prisma");
const {
  currentMonthKey,
  parseOptionalMonthKey,
  formatMonthKey,
  formatMonthShort,
  prevMonth,
  nextMonth,
  monthStartDate,
  monthEndDate,
  currentDayDate,
  daysInMonth,
} = require("../helpers/month.helpers");
const { Decimal, formatAmount } = require("../helpers/money.helpers");
const {
  LOCATION_TYPE_LABELS,
  MOVEMENT_TYPE_LABELS,
  DAMAGE_REASON_LABELS,
  displayNameOf,
} = require("../helpers/inventory.helpers");
const { PERSON_SELECT } = require("./damageCharge.service");
const { BadRequestError } = require("../utils/errors");

/** Dinamika diagrammasidagi oylar soni. */
const DEFAULT_TREND_MONTHS = 12;
const MAX_TREND_MONTHS = 36;

/**
 * Monitoring issiqlik xaritasidagi kunlar soni.
 *
 * ⚠️ 91 = ROPPA-ROSA 13 HAFTA va bu ikki sababdan: (1) chorak — intizom
 * naqshini ko'rish uchun yetarli davr, bir oy esa mavsumiy tebranishni
 * ko'rsatmaydi; (2) xarita hafta USTUNLARI bilan chiziladi, ya'ni kun
 * soni yettiga bo'linishi kerak — aks holda oxirgi ustun yarim bo'lib,
 * "o'sha kunlarda hisobot bo'lmagan" degan yolg'on ma'no chiqardi.
 */
const HEATMAP_DAYS = 91;

/** Reyting bloklaridagi qatorlar soni. */
const LOCATION_LIMIT = 8;
const ITEM_LIMIT = 8;
const DEBTOR_LIMIT = 6;
const RECENT_LIMIT = 10;

/** Bekor qilinmagan zarar — butun fayl bo'ylab bitta shart. */
const LIVE_DAMAGE = { status: { not: "cancelled" } };

// ─────────────────────────────────────────────
// Yordamchilar
// ─────────────────────────────────────────────

/**
 * Oyning TOSHKENT bo'yicha boshi va oxiri — INSTANT maydonlar uchun
 * (`occurredAt`, `paidAt`). `monthStartDate/monthEndDate` UTC yarim tuni
 * qaytaradi va u `@db.Date` uchun (`financeDashboard.service.js` dagi
 * aynan shu izoh).
 */
const monthInstantRange = (monthKey) => {
  const iso = (key) =>
    `${Math.trunc(key / 100)}-${String(key % 100).padStart(2, "0")}-01T00:00:00+05:00`;

  return {
    from: new Date(iso(monthKey)),
    // Keyingi oy boshidan 1 ms oldin — dekabrda "13-oy" chiqmasligi uchun
    // `nextMonth` yil chegarasini o'zi hal qiladi
    to: new Date(new Date(iso(nextMonth(monthKey))).getTime() - 1),
  };
};

/** `@db.Date` ustuni uchun oy oralig'i (UTC yarim tuni). */
const monthDayRange = (monthKey) => ({
  gte: monthStartDate(monthKey),
  lte: monthEndDate(monthKey),
});

/** Foiz — 1 xonali. Maxraj nol bo'lsa `null` ("0%" BILAN BIR XIL EMAS). */
const rateOf = (part, whole) => {
  const w = new Decimal(whole);
  if (w.isZero()) return null;
  return Number(new Decimal(part).div(w).times(100).toFixed(1));
};

/** Ulush — maxraj nol bo'lsa 0 (diagramma segmentlari uchun). */
const shareOf = (part, whole) => {
  const w = new Decimal(whole);
  if (w.isZero()) return 0;
  return Number(new Decimal(part).div(w).times(100).toFixed(1));
};

/**
 * O'sish foizi: (joriy − oldingi) / |oldingi|.
 * Oldingi nol bo'lsa foiz YO'Q (`null`), 100% emas.
 */
const changeOf = (current, previous) => {
  const prev = new Decimal(previous);
  if (prev.isZero()) return null;
  return Number(new Decimal(current).minus(prev).div(prev.abs()).times(100).toFixed(1));
};

/** Foizli ko'rsatkichda o'zgarish PUNKTDA o'lchanadi, foizda emas. */
const pointChangeOf = (current, previous) => {
  if (current == null || previous == null) return null;
  return Number((current - previous).toFixed(1));
};

/**
 * KPI qatori — bitta ko'rsatkichning to'liq shakli.
 * `unit`: "money" | "count" | "percent" — frontend formatlashni shundan biladi.
 */
const metric = (value, previous, unit) => ({
  value: unit === "money" ? formatAmount(new Decimal(value ?? 0)) : (value ?? null),
  previous: unit === "money" ? formatAmount(new Decimal(previous ?? 0)) : (previous ?? null),
  change: unit === "percent" ? pointChangeOf(value, previous) : changeOf(value ?? 0, previous ?? 0),
  changeUnit: unit === "percent" ? "point" : "percent",
  unit,
});

// ─────────────────────────────────────────────
// Bloklar
// ─────────────────────────────────────────────

/**
 * OY OXIRIDAGI XATLOV HOLATI — daftardan qayta tiklanadi.
 *
 * `InventoryStock` bugungi holatni saqlaydi, shuning uchun o'tgan oy
 * uchun undan KEYIN bo'lgan harakatlar AYRILADI:
 *
 *   quantityAt(oy oxiri) = quantity − Σ quantityDelta(occurredAt > oy oxiri)
 *
 * ⚠️ Joriy (yoki kelajakdagi) oy so'ralganda ayiriladigan hech narsa
 * yo'q — so'rov baribir yuboriladi va bo'sh natija qaytaradi. Shartni
 * "agar joriy oy bo'lsa so'rovni o'tkazib yubor" deb yozish ikkita
 * yo'lni hosil qilardi va ulardan biri sinovdan chetda qolardi.
 *
 * ⚠️ Xatlov qatorlari TASHQARIDAN keladi: ular tanlangan oy uchun ham,
 * taqqoslash oyi uchun ham, toifa/xona/jihoz bloklari uchun ham AYNAN
 * bir xil (bugungi holat) — funksiya ichida o'qilsa, bitta jadval bir
 * so'rovda besh marta skanlanardi.
 *
 * @param {number} monthKey
 * @param {Map<string, {unitPrice: Decimal, categoryId: string}>} itemMeta
 * @param {Array<{itemId: string, quantity: number, brokenQuantity: number}>} stocks
 */
const stateAt = async (monthKey, itemMeta, stocks) => {
  const boundary = monthInstantRange(monthKey).to;

  const future = await prisma.inventoryMovement.groupBy({
    by: ["itemId"],
    where: { occurredAt: { gt: boundary } },
    _sum: { quantityDelta: true, brokenDelta: true },
  });

  const futureByItem = new Map(
    future.map((row) => [
      row.itemId,
      { quantity: row._sum.quantityDelta ?? 0, broken: row._sum.brokenDelta ?? 0 },
    ]),
  );

  // Jihoz kesimida yig'amiz: pul qiymati narx bilan ko'paytirishni talab
  // qiladi va narx JIHOZDA turadi (xatlov qatorida emas)
  const byItem = new Map();
  for (const stock of stocks) {
    const current = byItem.get(stock.itemId) ?? { quantity: 0, broken: 0 };
    current.quantity += stock.quantity;
    current.broken += stock.brokenQuantity;
    byItem.set(stock.itemId, current);
  }

  let totalQuantity = 0;
  let brokenQuantity = 0;
  let baseValue = new Decimal(0);
  let brokenValue = new Decimal(0);

  for (const [itemId, sums] of byItem) {
    const delta = futureByItem.get(itemId);
    // ⚠️ Manfiy bo'lib ketishi mumkin emas, lekin daftarda teskari qator
    // bo'lsa nolga qisiladi: manfiy jihoz soni ekranda ma'nosiz
    const quantity = Math.max(0, sums.quantity - (delta?.quantity ?? 0));
    const broken = Math.max(0, Math.min(quantity, sums.broken - (delta?.broken ?? 0)));

    const price = itemMeta.get(itemId)?.unitPrice ?? new Decimal(0);

    totalQuantity += quantity;
    brokenQuantity += broken;
    baseValue = baseValue.plus(price.times(quantity));
    brokenValue = brokenValue.plus(price.times(broken));
  }

  return {
    totalQuantity,
    brokenQuantity,
    serviceableQuantity: totalQuantity - brokenQuantity,
    baseValue,
    brokenValue,
    // Yaroqlilik PUL bo'yicha o'lchanadi, dona bo'yicha emas: 500 ta
    // qoshiqning bittasi va bitta proyektor "1 dona" da teng, pulda esa
    // yo'q — qaror aynan pulga qarab qabul qilinadi
    healthRate: rateOf(baseValue.minus(brokenValue), baseValue),
    unitHealthRate: rateOf(totalQuantity - brokenQuantity, totalQuantity),
  };
};

/**
 * BIR OYNING ZARAR VA UNDIRUV KESIMI.
 *
 * ⚠️ Undiruv `paidAt` bo'yicha, zarar `occurredAt` bo'yicha filtrlanadi:
 * sentabrda singan parta oktabrda to'lanishi mumkin va ikkalasi ham o'z
 * oyida turishi kerak. Bitta sana bilan filtrlansa, "shu oy qancha pul
 * tushdi" degan savol noto'g'ri javob berardi.
 */
const damageFigures = async (monthKey) => {
  const { from, to } = monthInstantRange(monthKey);
  const range = { gte: from, lte: to };

  const [all, byStatus, payments, checks] = await Promise.all([
    prisma.inventoryDamage.aggregate({
      where: { ...LIVE_DAMAGE, occurredAt: range },
      _sum: { amount: true, chargedAmount: true, quantity: true },
      _count: { _all: true },
    }),
    prisma.inventoryDamage.groupBy({
      by: ["status"],
      where: { ...LIVE_DAMAGE, occurredAt: range },
      _sum: { amount: true, chargedAmount: true },
      _count: { _all: true },
    }),
    prisma.damagePayment.aggregate({
      where: { isVoided: false, paidAt: range },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.inventoryCheck.count({
      where: { status: "submitted", date: monthDayRange(monthKey) },
    }),
  ]);

  const statusMap = new Map(byStatus.map((row) => [row.status, row]));
  const amountOf = (status) => new Decimal(statusMap.get(status)?._sum.amount ?? 0);

  const total = new Decimal(all._sum.amount ?? 0);
  const charged = new Decimal(all._sum.chargedAmount ?? 0);

  return {
    count: all._count._all,
    quantity: all._sum.quantity ?? 0,
    amount: total,
    // Aybdorlarga YOZILGAN ulush — hodisa holati emas, `chargedAmount`
    // yig'indisi: bitta hodisa qisman yozilgan bo'lishi mumkin
    chargedAmount: charged,
    waivedAmount: amountOf("waived"),
    waivedCount: statusMap.get("waived")?._count._all ?? 0,
    // "Qaror kutmoqda" — hali hech kimga yozilmagan va maktab ham
    // o'z zimmasiga olmagan qism
    pendingAmount: total.minus(charged).minus(amountOf("waived")),
    recoveredAmount: new Decimal(payments._sum.amount ?? 0),
    paymentCount: payments._count._all,
    submittedChecks: checks,
  };
};

/**
 * MONITORING INTIZOMI — kutilgan hisobotlarning nechta foizi yuborilgan.
 *
 * Maxraj = faol xonalar × oyning O'TGAN kunlari. Oy tugamagan bo'lsa
 * kelajakdagi kunlar maxrajga KIRMAYDI: aks holda 3-sentabrda intizom
 * "10%" ko'rinib, butun blok ma'nosiz bo'lardi.
 *
 * ⚠️ Dam olish kunlari AYRILMAYDI. Sabab: monitoring xonaga tegishli,
 * dars jadvaliga emas — oshxona va yotoqxona shanbada ham ishlaydi.
 * Ayirsak, "yakshanbada hisobot bermadi" degan haqiqiy kamchilik
 * ko'rinmay qolardi.
 */
const elapsedDaysOf = (monthKey) => {
  const nowMonth = currentMonthKey();

  if (monthKey > nowMonth) return 0;
  if (monthKey < nowMonth) return daysInMonth(monthKey);
  // ⚠️ `getUTCDate()` — `currentDayDate()` UTC yarim tunidagi Toshkent
  // kunini qaytaradi (`month.helpers.js`), shuning uchun mahalliy
  // `getDate()` serverning taymzonasiga qarab bir kunga siljirdi
  return currentDayDate().getUTCDate();
};

const monitoringRate = (submitted, locations, monthKey) => {
  const days = elapsedDaysOf(monthKey);
  const expected = locations * days;
  return { rate: rateOf(submitted, expected), expected, days };
};

/**
 * 12 OYLIK DINAMIKA — zarar, undiruv va hodisa soni.
 *
 * BITTA xom so'rov: uch manba `UNION ALL` bilan bitta o'qqa keltiriladi.
 * Prisma `groupBy` "sanani Toshkent oyiga yaxlitlash" ni ifodalay
 * olmaydi, har oyga alohida so'rov esa 3 × 12 = 36 marta bazaga borish
 * degani bo'lardi (`financeDashboard.buildTrend` bilan bir xil mulohaza).
 *
 * @param {number[]} months - o'sish tartibida
 */
const buildTrend = async (months) => {
  const from = monthInstantRange(months[0]).from;
  const to = monthInstantRange(months[months.length - 1]).to;

  const TASHKENT = `AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tashkent'`;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT month, kind,
            SUM(amount)::text AS amount,
            SUM(qty)::int     AS qty,
            SUM(cnt)::int     AS cnt
       FROM (
         SELECT to_char(occurred_at ${TASHKENT}, 'YYYYMM')::int AS month,
                CASE WHEN kind = 'missing' THEN 'missing' ELSE 'broken' END AS kind,
                amount, quantity AS qty, 1 AS cnt
           FROM inventory_damages
          WHERE status <> 'cancelled' AND occurred_at >= $1 AND occurred_at <= $2
         UNION ALL
         SELECT to_char(paid_at ${TASHKENT}, 'YYYYMM')::int, 'recovered', amount, 0, 1
           FROM damage_payments
          WHERE is_voided = false AND paid_at >= $1 AND paid_at <= $2
       ) AS combined
      GROUP BY 1, 2`,
    from,
    to,
  );

  const byMonth = new Map();
  for (const row of rows) {
    const entry = byMonth.get(row.month) ?? {
      broken: { amount: new Decimal(0), qty: 0, cnt: 0 },
      missing: { amount: new Decimal(0), qty: 0, cnt: 0 },
      recovered: { amount: new Decimal(0), qty: 0, cnt: 0 },
    };
    entry[row.kind] = {
      amount: new Decimal(row.amount ?? 0),
      qty: row.qty ?? 0,
      cnt: row.cnt ?? 0,
    };
    byMonth.set(row.month, entry);
  }

  return months.map((month) => {
    const row = byMonth.get(month);
    const broken = row?.broken ?? { amount: new Decimal(0), qty: 0, cnt: 0 };
    const missing = row?.missing ?? { amount: new Decimal(0), qty: 0, cnt: 0 };
    const recovered = row?.recovered ?? { amount: new Decimal(0), cnt: 0 };

    return {
      month,
      label: formatMonthShort(month),
      damageAmount: formatAmount(broken.amount.plus(missing.amount)),
      brokenAmount: formatAmount(broken.amount),
      missingAmount: formatAmount(missing.amount),
      recoveredAmount: formatAmount(recovered.amount),
      damageCount: broken.cnt + missing.cnt,
      brokenQuantity: broken.qty,
      missingQuantity: missing.qty,
    };
  });
};

/**
 * ZARARNING OQIMI — Sankey diagrammasining ma'lumoti.
 *
 * Ikki bosqich: zarar → taqdiri (aybdorga / maktab hisobidan / qaror
 * kutmoqda), keyin aybdorga yozilgani → undirilgan / qarz.
 *
 * ⚠️ UNDIRILGAN summa DAVR bo'yicha to'lovlardan EMAS, `DamageCharge`
 * ning `paidAmount` idan olinadi: oqim bitta zarar to'plamining taqdirini
 * ko'rsatadi, kassa oqimini emas. To'lovlar bilan yig'sak, sentabrda
 * singan partaning oktabrdagi to'lovi sentabr oqimidan chiqib ketardi va
 * "yozilgan = undirilgan + qarz" tengligi buzilardi.
 */
const buildFlow = async (monthKey) => {
  const { from, to } = monthInstantRange(monthKey);
  const range = { gte: from, lte: to };

  const [damages, charges] = await Promise.all([
    prisma.inventoryDamage.groupBy({
      by: ["status"],
      where: { ...LIVE_DAMAGE, occurredAt: range },
      _sum: { amount: true, chargedAmount: true },
    }),
    // Shu davrdagi zararlarga yozilgan qarzlar — `damage` orqali
    prisma.damageCharge.aggregate({
      where: {
        status: { not: "cancelled" },
        damage: { ...LIVE_DAMAGE, occurredAt: range },
      },
      _sum: { amount: true, paidAmount: true },
    }),
  ]);

  let total = new Decimal(0);
  let charged = new Decimal(0);
  let waived = new Decimal(0);

  for (const row of damages) {
    total = total.plus(row._sum.amount ?? 0);
    charged = charged.plus(row._sum.chargedAmount ?? 0);
    if (row.status === "waived") waived = waived.plus(row._sum.amount ?? 0);
  }

  const chargeTotal = new Decimal(charges._sum.amount ?? 0);
  const chargePaid = new Decimal(charges._sum.paidAmount ?? 0);

  // `waived` hodisasining o'ziga ham qarz yozilgan bo'lishi mumkin emas,
  // lekin summalar ikki manbadan kelgani uchun natija nolga qisiladi
  const pending = Decimal.max(0, total.minus(charged).minus(waived));

  return {
    total: formatAmount(total),
    charged: formatAmount(charged),
    waived: formatAmount(waived),
    pending: formatAmount(pending),
    recovered: formatAmount(chargePaid),
    outstanding: formatAmount(Decimal.max(0, chargeTotal.minus(chargePaid))),
    shares: {
      charged: shareOf(charged, total),
      waived: shareOf(waived, total),
      pending: shareOf(pending, total),
      recovered: shareOf(chargePaid, chargeTotal),
    },
  };
};

/**
 * SABAB KESIMI — "nega yo'qotdik".
 *
 * Katalog TARTIBIDA va TO'LIQ EMAS: bu yerda nol qatorlar TASHLANADI
 * (`inventoryReport.getByReason` dan farqi). Sabab — diagramma:
 * nol segment donutda ko'rinmaydi-yu, afsonada joy egallardi.
 */
const buildReasons = async (monthKey) => {
  const { from, to } = monthInstantRange(monthKey);

  const rows = await prisma.inventoryDamage.groupBy({
    by: ["reason"],
    where: { ...LIVE_DAMAGE, occurredAt: { gte: from, lte: to } },
    _sum: { amount: true, quantity: true },
    _count: { _all: true },
  });

  const total = rows.reduce((sum, row) => sum.plus(row._sum.amount ?? 0), new Decimal(0));

  return rows
    .map((row) => ({
      reason: row.reason,
      label: DAMAGE_REASON_LABELS[row.reason] ?? row.reason,
      count: row._count._all,
      quantity: row._sum.quantity ?? 0,
      amount: formatAmount(new Decimal(row._sum.amount ?? 0)),
      share: shareOf(row._sum.amount ?? 0, total),
      _sort: new Decimal(row._sum.amount ?? 0),
    }))
    .sort((a, b) => b._sort.comparedTo(a._sort))
    .map(({ _sort, ...rest }) => rest);
};

/**
 * BAZANING TUZILISHI — toifalar bo'yicha (treemap).
 *
 * Bu YAGONA blok HOLATNI (hozirgi xatlovni) ko'rsatadi, hodisani emas —
 * shuning uchun oy tanlagichiga bog'liq EMAS. "Sentabrda bazamiz nimadan
 * iborat edi" degan savol amalda so'ralmaydi; "hozir nimadan iborat"
 * esa har kuni so'raladi.
 */
const buildCategories = (stocks, itemMeta, categories) => {
  const byCategory = new Map();

  for (const stock of stocks) {
    const meta = itemMeta.get(stock.itemId);
    if (!meta) continue;

    const current = byCategory.get(meta.categoryId) ?? {
      quantity: 0,
      broken: 0,
      value: new Decimal(0),
      items: new Set(),
    };

    current.quantity += stock.quantity;
    current.broken += stock.brokenQuantity;
    current.value = current.value.plus(meta.unitPrice.times(stock.quantity));
    current.items.add(stock.itemId);

    byCategory.set(meta.categoryId, current);
  }

  const totalValue = [...byCategory.values()].reduce(
    (sum, row) => sum.plus(row.value),
    new Decimal(0),
  );

  return categories
    .map((category) => {
      const row = byCategory.get(category.id);
      if (!row || row.quantity === 0) return null;

      return {
        categoryId: category.id,
        name: category.name,
        quantity: row.quantity,
        brokenQuantity: row.broken,
        itemCount: row.items.size,
        value: formatAmount(row.value),
        share: shareOf(row.value, totalValue),
        healthRate: rateOf(row.quantity - row.broken, row.quantity),
        _sort: row.value,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b._sort.comparedTo(a._sort))
    .map(({ _sort, ...rest }) => rest);
};

/**
 * XONALAR REYTINGI + TUR KESIMI.
 *
 * Xona uchun uchta mustaqil o'lchov: bazasi (nechta jihoz, qancha pul),
 * holati (yaroqsizlar ulushi) va hodisasi (davrdagi zarar). Ular bitta
 * "risk balli" ga QO'SHILMAYDI: ballning maxraji bo'lmaydi va ikki xil
 * xona bir xil ball bilan butunlay boshqa sababdan chiqib qolardi.
 */
const buildLocations = async (monthKey, stocks, itemMeta) => {
  const { from, to } = monthInstantRange(monthKey);

  const [locations, damages, checks] = await Promise.all([
    prisma.inventoryLocation.findMany({
      where: { isArchived: false },
      select: { id: true, name: true, type: true, responsibleId: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.inventoryDamage.groupBy({
      by: ["locationId"],
      where: { ...LIVE_DAMAGE, occurredAt: { gte: from, lte: to } },
      _sum: { amount: true, quantity: true },
      _count: { _all: true },
    }),
    prisma.inventoryCheck.groupBy({
      by: ["locationId"],
      where: { status: "submitted", date: monthDayRange(monthKey) },
      _count: { _all: true },
    }),
  ]);

  const damageById = new Map(damages.map((row) => [row.locationId, row]));
  const checkById = new Map(checks.map((row) => [row.locationId, row._count._all]));

  const stockByLocation = new Map();
  for (const stock of stocks) {
    const meta = itemMeta.get(stock.itemId);
    const current = stockByLocation.get(stock.locationId) ?? {
      quantity: 0,
      broken: 0,
      value: new Decimal(0),
      items: 0,
    };

    current.quantity += stock.quantity;
    current.broken += stock.brokenQuantity;
    current.items += 1;
    if (meta) current.value = current.value.plus(meta.unitPrice.times(stock.quantity));

    stockByLocation.set(stock.locationId, current);
  }

  const days = elapsedDaysOf(monthKey);

  const rows = locations.map((location) => {
    const stock = stockByLocation.get(location.id);
    const damage = damageById.get(location.id);
    const submitted = checkById.get(location.id) ?? 0;

    const quantity = stock?.quantity ?? 0;
    const broken = stock?.broken ?? 0;

    return {
      locationId: location.id,
      name: location.name,
      type: location.type,
      typeLabel: LOCATION_TYPE_LABELS[location.type] ?? location.type,
      quantity,
      brokenQuantity: broken,
      itemCount: stock?.items ?? 0,
      value: formatAmount(stock?.value ?? new Decimal(0)),
      healthRate: rateOf(quantity - broken, quantity),
      damageCount: damage?._count._all ?? 0,
      damageQuantity: damage?._sum.quantity ?? 0,
      damageAmount: formatAmount(new Decimal(damage?._sum.amount ?? 0)),
      checkCount: submitted,
      checkRate: rateOf(submitted, days),
      _damage: new Decimal(damage?._sum.amount ?? 0),
      _value: stock?.value ?? new Decimal(0),
    };
  });

  // ── Tur kesimi (radar) — REYTINGDAN OLDIN, to'liq ro'yxatdan ──
  const byType = new Map();
  for (const row of rows) {
    const current = byType.get(row.type) ?? {
      locations: 0,
      quantity: 0,
      broken: 0,
      damage: new Decimal(0),
      checks: 0,
    };

    current.locations += 1;
    current.quantity += row.quantity;
    current.broken += row.brokenQuantity;
    current.damage = current.damage.plus(row._damage);
    current.checks += row.checkCount;

    byType.set(row.type, current);
  }

  const types = [...byType.entries()]
    .map(([type, row]) => ({
      type,
      label: LOCATION_TYPE_LABELS[type] ?? type,
      locations: row.locations,
      quantity: row.quantity,
      brokenQuantity: row.broken,
      damageAmount: formatAmount(row.damage),
      healthRate: rateOf(row.quantity - row.broken, row.quantity) ?? 100,
      checkRate: rateOf(row.checks, row.locations * days) ?? 0,
    }))
    .sort((a, b) => b.quantity - a.quantity);

  const stripped = rows.map(({ _damage, _value, ...rest }) => rest);

  return {
    // Zarar bo'yicha reyting — "qaysi xonada ko'proq sinadi"
    byDamage: [...rows]
      .filter((row) => row._damage.greaterThan(0) || row.brokenQuantity > 0)
      .sort((a, b) => {
        const byAmount = b._damage.comparedTo(a._damage);
        return byAmount !== 0 ? byAmount : b.brokenQuantity - a.brokenQuantity;
      })
      .slice(0, LOCATION_LIMIT)
      .map(({ _damage, _value, ...rest }) => rest),
    // Qiymat bo'yicha — "eng qimmat baza qayerda"
    byValue: [...rows]
      .sort((a, b) => b._value.comparedTo(a._value))
      .slice(0, LOCATION_LIMIT)
      .map(({ _damage, _value, ...rest }) => rest),
    types,
    all: stripped,
    total: locations.length,
  };
};

/**
 * JIHOZLAR REYTINGI — "nima ko'p sinadi va bu qancha turadi".
 *
 * `failureRate` — davrdagi zarar miqdorining XATLOVDAGI miqdorga
 * nisbati: 500 ta piyoladan 10 tasi sinsa bu 2%, 3 ta proyektordan
 * bittasi sinsa 33%. Mutlaq son bilan birinchisi "eng muammoli" bo'lib
 * ko'rinardi.
 */
const buildItems = async (monthKey, stocks, itemMeta) => {
  const { from, to } = monthInstantRange(monthKey);

  const rows = await prisma.inventoryDamage.groupBy({
    by: ["itemId", "kind"],
    where: { ...LIVE_DAMAGE, occurredAt: { gte: from, lte: to } },
    _sum: { amount: true, quantity: true },
    _count: { _all: true },
  });

  if (rows.length === 0) return [];

  const stockByItem = new Map();
  for (const stock of stocks) {
    stockByItem.set(stock.itemId, (stockByItem.get(stock.itemId) ?? 0) + stock.quantity);
  }

  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.itemId))] } },
    select: { id: true, name: true, unit: true, category: { select: { name: true } } },
  });
  const itemById = new Map(items.map((item) => [item.id, item]));

  const merged = new Map();

  for (const row of rows) {
    const current = merged.get(row.itemId) ?? {
      itemId: row.itemId,
      name: itemById.get(row.itemId)?.name ?? "Noma'lum",
      unit: itemById.get(row.itemId)?.unit ?? "dona",
      categoryName: itemById.get(row.itemId)?.category?.name ?? null,
      count: 0,
      quantity: 0,
      brokenQuantity: 0,
      missingQuantity: 0,
      amount: new Decimal(0),
    };

    current.count += row._count._all;
    current.quantity += row._sum.quantity ?? 0;
    current.amount = current.amount.plus(row._sum.amount ?? 0);

    if (row.kind === "missing") current.missingQuantity += row._sum.quantity ?? 0;
    else current.brokenQuantity += row._sum.quantity ?? 0;

    merged.set(row.itemId, current);
  }

  return [...merged.values()]
    .sort((a, b) => b.amount.comparedTo(a.amount))
    .slice(0, ITEM_LIMIT)
    .map((row) => ({
      ...row,
      amount: formatAmount(row.amount),
      unitPrice: formatAmount(itemMeta.get(row.itemId)?.unitPrice ?? new Decimal(0)),
      stockQuantity: stockByItem.get(row.itemId) ?? 0,
      failureRate: rateOf(row.quantity, stockByItem.get(row.itemId) ?? 0),
    }));
};

/**
 * MONITORING INTIZOMI — issiqlik xaritasi va bugungi holat.
 *
 * ⚠️ `InventoryCheck.date` — `@db.Date`, ya'ni UTC yarim tuni. Kun
 * raqami FAQAT `getUTC*` bilan o'qiladi (`education.md` §6).
 */
const buildMonitoring = async (totalLocations) => {
  const today = currentDayDate();
  const firstDay = new Date(today.getTime() - (HEATMAP_DAYS - 1) * 86400000);

  const [rows, todayChecks, pendingRows, settings] = await Promise.all([
    prisma.inventoryCheck.groupBy({
      by: ["date"],
      where: { status: "submitted", date: { gte: firstDay, lte: today } },
      _count: { _all: true },
      _sum: { brokenCount: true, missingCount: true, damageAmount: true },
    }),
    prisma.inventoryCheck.findMany({
      where: { date: today },
      select: { locationId: true, status: true },
    }),
    prisma.inventoryLocation.findMany({
      where: { isArchived: false },
      select: { id: true, name: true, type: true, responsibleId: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.inventorySettings.findUnique({ where: { id: "singleton" } }),
  ]);

  const byDate = new Map(rows.map((row) => [row.date.getTime(), row]));

  const days = [];
  for (let i = 0; i < HEATMAP_DAYS; i += 1) {
    const date = new Date(firstDay.getTime() + i * 86400000);
    const row = byDate.get(date.getTime());
    const submitted = row?._count._all ?? 0;

    days.push({
      date: date.toISOString().slice(0, 10),
      // Hafta kuni — issiqlik xaritasining ustuni (0 = yakshanba)
      weekday: date.getUTCDay(),
      submitted,
      total: totalLocations,
      rate: rateOf(submitted, totalLocations) ?? 0,
      brokenCount: row?._sum.brokenCount ?? 0,
      missingCount: row?._sum.missingCount ?? 0,
      damageAmount: formatAmount(new Decimal(row?._sum.damageAmount ?? 0)),
    });
  }

  const submittedToday = new Set(
    todayChecks.filter((check) => check.status === "submitted").map((c) => c.locationId),
  );
  const draftToday = new Set(
    todayChecks.filter((check) => check.status === "draft").map((c) => c.locationId),
  );

  const missing = pendingRows.filter((location) => !submittedToday.has(location.id));

  const responsibleIds = [...new Set(missing.map((l) => l.responsibleId).filter(Boolean))];
  const people = responsibleIds.length
    ? await prisma.user.findMany({
        where: { id: { in: responsibleIds } },
        select: PERSON_SELECT,
      })
    : [];
  const peopleById = new Map(people.map((person) => [person.id, person]));

  return {
    enabled: settings?.dailyCheckEnabled ?? true,
    reminderTime: settings?.reminderTime ?? null,
    date: today.toISOString().slice(0, 10),
    totalLocations,
    submittedToday: submittedToday.size,
    draftToday: draftToday.size,
    pendingToday: missing.length,
    todayRate: rateOf(submittedToday.size, totalLocations) ?? 0,
    days,
    pending: missing.slice(0, 8).map((location) => ({
      locationId: location.id,
      name: location.name,
      typeLabel: LOCATION_TYPE_LABELS[location.type] ?? location.type,
      responsibleName: location.responsibleId
        ? (peopleById.get(location.responsibleId)
            ? displayNameOf(peopleById.get(location.responsibleId))
            : null)
        : null,
      // Varaq ochilgan-u yuborilmagan — "boshlagan, tugatmagan" holati
      isDraft: draftToday.has(location.id),
    })),
  };
};

/**
 * QARZDORLAR — kim qancha qarzdor va qanchasi muddati o'tgan.
 *
 * ⚠️ DAVRGA BOG'LIQ EMAS: "hozir kim qancha qarzdor" degan savolning
 * javobi o'tgan oy filtridan o'zgarmasligi kerak
 * (`inventoryReport.getDebtors` bilan bir xil qoida).
 */
const buildDebtors = async () => {
  const now = new Date();

  const rows = await prisma.damageCharge.groupBy({
    by: ["personId"],
    where: { status: { in: ["unpaid", "partial"] } },
    _sum: { amount: true, paidAmount: true },
    _count: { _all: true },
    _min: { dueDate: true },
  });

  if (rows.length === 0) {
    return { total: "0.00", count: 0, overdueCount: 0, overdueAmount: "0.00", items: [] };
  }

  const personIds = rows.map((row) => row.personId);

  const [people, snapshots, overdue] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: personIds } }, select: PERSON_SELECT }),
    prisma.damageCharge.findMany({
      where: { personId: { in: personIds } },
      distinct: ["personId"],
      select: { personId: true, personSnapshot: true, personRole: true },
    }),
    prisma.damageCharge.aggregate({
      where: { status: { in: ["unpaid", "partial"] }, dueDate: { lt: now } },
      _sum: { amount: true, paidAmount: true },
      _count: { _all: true },
    }),
  ]);

  const peopleById = new Map(people.map((person) => [person.id, person]));
  const snapshotById = new Map(snapshots.map((row) => [row.personId, row]));

  const items = rows
    .map((row) => {
      const person = peopleById.get(row.personId);
      const snapshot = snapshotById.get(row.personId);
      const remaining = new Decimal(row._sum.amount ?? 0).minus(row._sum.paidAmount ?? 0);

      return {
        personId: row.personId,
        name: displayNameOf(person, snapshot?.personSnapshot),
        role: person?.role ?? snapshot?.personRole ?? null,
        className: snapshot?.personSnapshot?.className ?? null,
        chargeCount: row._count._all,
        amount: formatAmount(new Decimal(row._sum.amount ?? 0)),
        paidAmount: formatAmount(new Decimal(row._sum.paidAmount ?? 0)),
        remainingAmount: formatAmount(remaining),
        paidRate: shareOf(row._sum.paidAmount ?? 0, row._sum.amount ?? 0),
        dueDate: row._min.dueDate ?? null,
        isOverdue: row._min.dueDate ? row._min.dueDate < now : false,
        _sort: remaining,
      };
    })
    .sort((a, b) => b._sort.comparedTo(a._sort));

  const total = items.reduce((sum, row) => sum.plus(row._sort), new Decimal(0));
  const overdueRemaining = new Decimal(overdue._sum.amount ?? 0).minus(
    overdue._sum.paidAmount ?? 0,
  );

  return {
    total: formatAmount(total),
    count: items.length,
    overdueCount: overdue._count._all,
    overdueAmount: formatAmount(Decimal.max(0, overdueRemaining)),
    items: items.slice(0, DEBTOR_LIMIT).map(({ _sort, ...rest }) => rest),
  };
};

/**
 * SO'NGGI HARAKATLAR — miqdor daftarining oxirgi qatorlari.
 *
 * ⚠️ `seq` bo'yicha, `occurredAt` bo'yicha EMAS: orqaga sanalgan yozuv
 * ro'yxat o'rtasiga tushib, "yangi hodisa" bloki jimgina eskirardi
 * (`finance.md` §7 — registr `seq`, hisobot `occurredAt`).
 */
const buildRecent = async () => {
  const rows = await prisma.inventoryMovement.findMany({
    orderBy: { seq: "desc" },
    take: RECENT_LIMIT,
    select: {
      id: true,
      type: true,
      quantityDelta: true,
      brokenDelta: true,
      occurredAt: true,
      note: true,
      item: { select: { name: true, unit: true } },
      location: { select: { name: true } },
      damage: { select: { amount: true, kind: true, reason: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    typeLabel: MOVEMENT_TYPE_LABELS[row.type] ?? row.type,
    itemName: row.item?.name ?? "Noma'lum",
    unit: row.item?.unit ?? "dona",
    locationName: row.location?.name ?? "—",
    quantityDelta: row.quantityDelta,
    brokenDelta: row.brokenDelta,
    occurredAt: row.occurredAt,
    note: row.note || null,
    amount: row.damage ? formatAmount(new Decimal(row.damage.amount)) : null,
    reasonLabel: row.damage ? (DAMAGE_REASON_LABELS[row.damage.reason] ?? null) : null,
  }));
};

// ─────────────────────────────────────────────
// Asosiy kirish nuqtasi
// ─────────────────────────────────────────────

/**
 * BUTUN MANZARA — bitta so'rov, bitta javob.
 *
 * ⚠️ BITTA SO'ROV, sababi ta'lim dashboardi bilan bir xil: hamma blok
 * AYNI jadvallardan yig'iladi (xatlov qatorlari uchala blokka kerak),
 * ikkiga bo'lish faqat o'sha qatorlarni ikkinchi marta o'qishga olib
 * kelardi.
 *
 * @param {{month?: string|number, compareMonth?: string|number, trendMonths?: string|number}} query
 */
const getOverview = async (query = {}) => {
  const month = parseOptionalMonthKey(query.month) ?? currentMonthKey();
  const compareMonth = parseOptionalMonthKey(query.compareMonth) ?? prevMonth(month);

  if (compareMonth >= month) {
    throw new BadRequestError("Taqqoslash oyi tanlangan oydan oldin bo'lishi kerak");
  }

  const trendMonths = Math.min(
    Math.max(Number(query.trendMonths) || DEFAULT_TREND_MONTHS, 3),
    MAX_TREND_MONTHS,
  );

  // O'sish tartibida: eng eski oydan tanlangan oygacha. Orqaga qadam
  // tashlab yig'iladi va oxirida ag'dariladi — `prevMonth` yil
  // chegarasini o'zi hal qiladi (dekabr → yanvar)
  const months = [month];
  for (let i = 1; i < trendMonths; i += 1) months.push(prevMonth(months[i - 1]));
  months.reverse();

  // ── Katalog: narx va toifa xaritasi. Xatlov qatorlari BIR MARTA
  //    o'qiladi va to'rtta blokka uzatiladi (holat, toifa, xona, jihoz).
  const [items, categories, stocks, locationCount] = await Promise.all([
    prisma.inventoryItem.findMany({
      select: { id: true, unitPrice: true, categoryId: true },
    }),
    prisma.inventoryCategory.findMany({
      where: { isArchived: false },
      select: { id: true, name: true, sortOrder: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.inventoryStock.findMany({
      select: { itemId: true, locationId: true, quantity: true, brokenQuantity: true },
    }),
    prisma.inventoryLocation.count({ where: { isArchived: false } }),
  ]);

  const itemMeta = new Map(
    items.map((item) => [
      item.id,
      { unitPrice: new Decimal(item.unitPrice), categoryId: item.categoryId },
    ]),
  );

  const [
    state,
    prevState,
    figures,
    prevFigures,
    trend,
    flow,
    reasons,
    locations,
    topItems,
    monitoring,
    debtors,
    recent,
  ] = await Promise.all([
    stateAt(month, itemMeta, stocks),
    stateAt(compareMonth, itemMeta, stocks),
    damageFigures(month),
    damageFigures(compareMonth),
    buildTrend(months),
    buildFlow(month),
    buildReasons(month),
    buildLocations(month, stocks, itemMeta),
    buildItems(month, stocks, itemMeta),
    buildMonitoring(locationCount),
    buildDebtors(),
    buildRecent(),
  ]);

  const check = monitoringRate(figures.submittedChecks, locationCount, month);
  const prevCheck = monitoringRate(prevFigures.submittedChecks, locationCount, compareMonth);

  // Undirish darajasi — YOZILGANIGA nisbatan, zararning JAMISIGA emas:
  // maktab o'z zimmasiga olgan qismni undirish rejasi yo'q va u
  // maxrajda turса, ko'rsatkich boshqaruv qarori tufayli pasayardi
  const recoveryRate = rateOf(figures.recoveredAmount, figures.chargedAmount);
  const prevRecoveryRate = rateOf(prevFigures.recoveredAmount, prevFigures.chargedAmount);

  return {
    period: {
      month,
      monthLabel: formatMonthKey(month),
      compareMonth,
      compareMonthLabel: formatMonthKey(compareMonth),
      trendMonths,
    },

    // ── Uchta halqa: baza holati · monitoring intizomi · undiruv ──
    rings: {
      health: {
        value: state.healthRate ?? 0,
        previous: prevState.healthRate,
        label: "Baza holati",
        detail: {
          serviceableValue: formatAmount(state.baseValue.minus(state.brokenValue)),
          brokenValue: formatAmount(state.brokenValue),
          serviceableQuantity: state.serviceableQuantity,
          brokenQuantity: state.brokenQuantity,
        },
      },
      discipline: {
        value: check.rate ?? 0,
        previous: prevCheck.rate,
        label: "Monitoring intizomi",
        detail: {
          submitted: figures.submittedChecks,
          expected: check.expected,
          days: check.days,
        },
      },
      recovery: {
        value: recoveryRate ?? 0,
        previous: prevRecoveryRate,
        label: "Undiruv darajasi",
        detail: {
          recovered: formatAmount(figures.recoveredAmount),
          charged: formatAmount(figures.chargedAmount),
          paymentCount: figures.paymentCount,
        },
      },
    },

    // ── Oltita ko'rsatkich ──
    kpi: {
      baseValue: metric(state.baseValue, prevState.baseValue, "money"),
      totalQuantity: metric(state.totalQuantity, prevState.totalQuantity, "count"),
      brokenQuantity: metric(state.brokenQuantity, prevState.brokenQuantity, "count"),
      damageAmount: metric(figures.amount, prevFigures.amount, "money"),
      damageCount: metric(figures.count, prevFigures.count, "count"),
      recoveredAmount: metric(figures.recoveredAmount, prevFigures.recoveredAmount, "money"),
    },

    // ── Baza tarkibi ──
    base: {
      totalQuantity: state.totalQuantity,
      brokenQuantity: state.brokenQuantity,
      serviceableQuantity: state.serviceableQuantity,
      baseValue: formatAmount(state.baseValue),
      brokenValue: formatAmount(state.brokenValue),
      serviceableValue: formatAmount(state.baseValue.minus(state.brokenValue)),
      unitHealthRate: state.unitHealthRate,
      stockRows: stocks.length,
      itemCount: items.length,
      categoryCount: categories.length,
      locationCount,
    },

    trend,
    flow,
    reasons,
    categories: buildCategories(stocks, itemMeta, categories),
    locations,
    items: topItems,
    monitoring,
    debtors,
    recent,
  };
};

module.exports = { getOverview };
