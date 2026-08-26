/**
 * MOLIYA HISOBOTLARI (KIRIM) — faqat o'qiydi.
 *
 * ⚠️ Bu fayl HECH NARSA YOZMAYDI va summani QAYTA HISOBLAMAYDI. Hisob-faktura
 * summasi muhrlangan fakt (`invoiceBuilder.service.js`), bu yerda esa faqat
 * o'sha muhrlangan qatorlar yig'iladi. Agar hisobot raqami ekrandagi registr
 * raqamidan farq qilsa — bu hisobotdagi xato, ma'lumotdagi emas.
 *
 * ISHLATILADIGAN FILTRLAR (hamma joyda bir xil, aks holda ikki ekranda ikki
 * xil raqam chiqadi):
 *   - hisob-faktura:  status != "cancelled"
 *   - to'lov:         isVoided = false
 *
 * XOM SQL faqat ikki joyda: kunlik tushum (`paid_at` ni kunga yaxlitlash) va
 * sinf kesimi (`student_snapshot->>'className'`). Ikkalasini ham Prisma
 * `groupBy` ifodalay olmaydi. Filial client'i schema'ga bog'langan ulanish
 * satridan quriladi (`config/branchRegistry.js`), shuning uchun qisqa jadval
 * nomlari to'g'ri schema'ga tushadi.
 */

const prisma = require("../config/prisma");
const { BadRequestError } = require("../utils/errors");
const {
  currentMonthKey,
  parseMonthKey,
  parseOptionalMonthKey,
  formatMonthKey,
  formatMonthShort,
  nextMonth,
  prevMonth,
  diffMonths,
} = require("../helpers/month.helpers");
const { Decimal, formatAmount } = require("../helpers/money.helpers");
const { getDebtors } = require("./invoice.service");
const { getAccountsReport } = require("./paymentAccount.service");

/** Hisob-faktura hisobga olinadigan holatlar. */
const LIVE_INVOICE = { status: { not: "cancelled" } };

/** Sinfi belgilanmagan o'quvchilar shu nom ostida yig'iladi. */
const NO_CLASS_LABEL = "Sinfsiz";

/** Qarz yoshi guruhlari — chegara JORIY oydan necha oy orqada ekani. */
const AGING_BUCKETS = [
  { key: "current", label: "Joriy oy", min: 0, max: 0 },
  { key: "m1", label: "1 oy", min: 1, max: 1 },
  { key: "m2_3", label: "2-3 oy", min: 2, max: 3 },
  { key: "m4_6", label: "4-6 oy", min: 4, max: 6 },
  { key: "m7plus", label: "6 oydan ortiq", min: 7, max: Infinity },
];

// ─────────────────────────────────────────────
// Yordamchilar
// ─────────────────────────────────────────────

/**
 * Oylar oralig'i. Berilmasa — oxirgi 12 oy (joriy oy bilan birga).
 *
 * Oraliq TO'LIQ qaytariladi (bo'sh oylar ham), aks holda diagrammada oylar
 * o'tkazib yuborilib, chiziq uzilib ko'rinardi.
 *
 * @param {{fromMonth?: number|string, toMonth?: number|string}} query
 * @returns {{fromMonth: number, toMonth: number, months: number[]}}
 */
const parseMonthRange = (query = {}) => {
  const current = currentMonthKey();

  const toMonth = parseOptionalMonthKey(query.toMonth, "Tugash oyi") ?? current;
  const fromMonth =
    parseOptionalMonthKey(query.fromMonth, "Boshlanish oyi") ??
    (() => {
      let m = toMonth;
      for (let i = 0; i < 11; i += 1) m = prevMonth(m);
      return m;
    })();

  if (fromMonth > toMonth) {
    throw new BadRequestError("Boshlanish oyi tugash oyidan keyin bo'lishi mumkin emas");
  }

  // 5 yildan uzun oraliq — diagramma ham, so'rov ham ma'nosiz bo'ladi
  if (diffMonths(fromMonth, toMonth) > 60) {
    throw new BadRequestError("Oraliq 5 yildan uzun bo'lishi mumkin emas");
  }

  const months = [];
  for (let m = fromMonth; m <= toMonth; m = nextMonth(m)) months.push(m);

  return { fromMonth, toMonth, months };
};

/** Bugungi kun Toshkent kalendari bo'yicha, "YYYY-MM-DD". */
const todayIsoTashkent = () => {
  const now = new Date();
  return new Date(now.getTime() + 5 * 3600000).toISOString().slice(0, 10);
};

/** "YYYY-MM-DD" ga kun qo'shadi/ayiradi (taymzonasiz, sof kalendar). */
const shiftIsoDays = (iso, days) =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86400000)
    .toISOString()
    .slice(0, 10);

/** Foiz — 1 xonali, bo'luvchi nol bo'lsa 0. */
const percentOf = (part, whole) => {
  const w = new Decimal(whole);
  if (w.isZero()) return 0;
  return Number(new Decimal(part).div(w).times(100).toFixed(1));
};

/** Manfiy qarz bo'lmaydi — ortiqcha to'lov depozitga ketadi. */
const clampDebt = (value) => (value.isNegative() ? new Decimal(0) : value);

/**
 * Oylik yig'ma — `[month]` bo'yicha guruhlangan qatorlarni Map'ga soladi.
 * @returns {Promise<Map<number, {invoiced: Decimal, collected: Decimal, count: number}>>}
 */
const groupInvoicesByMonth = async (fromMonth, toMonth) => {
  const rows = await prisma.monthlyInvoice.groupBy({
    by: ["month"],
    where: { month: { gte: fromMonth, lte: toMonth }, ...LIVE_INVOICE },
    _sum: { amount: true, paidAmount: true },
    _count: { _all: true },
  });

  return new Map(
    rows.map((row) => [
      row.month,
      {
        invoiced: new Decimal(row._sum.amount ?? 0),
        collected: new Decimal(row._sum.paidAmount ?? 0),
        count: row._count._all,
      },
    ]),
  );
};

/** Bir oraliq uchun jami raqamlar — `previous` bilan taqqoslash ham shu orqali. */
const sumRange = async (fromMonth, toMonth) => {
  const agg = await prisma.monthlyInvoice.aggregate({
    where: { month: { gte: fromMonth, lte: toMonth }, ...LIVE_INVOICE },
    _sum: {
      amount: true,
      paidAmount: true,
      discountAmount: true,
      baseAmount: true,
      proratedAmount: true,
    },
    _count: { _all: true },
  });

  const invoiced = new Decimal(agg._sum.amount ?? 0);
  const collected = new Decimal(agg._sum.paidAmount ?? 0);
  const base = new Decimal(agg._sum.baseAmount ?? 0);
  const prorated = new Decimal(agg._sum.proratedAmount ?? 0);

  return {
    invoiced,
    collected,
    debt: clampDebt(invoiced.minus(collected)),
    discountTotal: new Decimal(agg._sum.discountAmount ?? 0),
    // Kirish proratsiyasi tufayli hisoblanmagan summa
    prorationTotal: clampDebt(base.minus(prorated)),
    invoiceCount: agg._count._all,
  };
};

// ─────────────────────────────────────────────
// 1. Umumiy manzara
// ─────────────────────────────────────────────

/**
 * KPI raqamlari + oylik trend.
 *
 * `previous` — AYNAN shuncha uzunlikdagi oldingi oraliq. Shu tufayli
 * "12 oy" tanlansa 12 oy bilan, "6 oy" tanlansa 6 oy bilan taqqoslanadi.
 *
 * @param {object} query - { fromMonth, toMonth }
 */
const getOverview = async (query = {}) => {
  const { fromMonth, toMonth, months } = parseMonthRange(query);

  // Oldingi oraliq — bir xil uzunlikda, tugashi `fromMonth` dan bir oy oldin
  const prevTo = prevMonth(fromMonth);
  let prevFrom = prevTo;
  for (let i = 1; i < months.length; i += 1) prevFrom = prevMonth(prevFrom);

  const [byMonth, totals, previous, deposits, studentAgg] = await Promise.all([
    groupInvoicesByMonth(fromMonth, toMonth),
    sumRange(fromMonth, toMonth),
    sumRange(prevFrom, prevTo),
    prisma.studentAccount.aggregate({ _sum: { balance: true } }),
    prisma.monthlyInvoice.findMany({
      where: { month: { gte: fromMonth, lte: toMonth }, ...LIVE_INVOICE },
      select: { studentId: true },
      distinct: ["studentId"],
    }),
  ]);

  const series = months.map((month) => {
    const row = byMonth.get(month) ?? {
      invoiced: new Decimal(0),
      collected: new Decimal(0),
      count: 0,
    };
    const debt = clampDebt(row.invoiced.minus(row.collected));

    return {
      month,
      monthLabel: formatMonthKey(month),
      monthShort: formatMonthShort(month),
      invoiced: formatAmount(row.invoiced),
      collected: formatAmount(row.collected),
      debt: formatAmount(debt),
      collectionRate: percentOf(row.collected, row.invoiced),
      invoiceCount: row.count,
    };
  });

  return {
    fromMonth,
    toMonth,
    fromMonthLabel: formatMonthKey(fromMonth),
    toMonthLabel: formatMonthKey(toMonth),
    totals: {
      invoiced: formatAmount(totals.invoiced),
      collected: formatAmount(totals.collected),
      debt: formatAmount(totals.debt),
      collectionRate: percentOf(totals.collected, totals.invoiced),
      discountTotal: formatAmount(totals.discountTotal),
      prorationTotal: formatAmount(totals.prorationTotal),
      depositBalance: formatAmount(new Decimal(deposits._sum.balance ?? 0)),
      invoiceCount: totals.invoiceCount,
      studentCount: studentAgg.length,
    },
    // O'sish foizini frontend hisoblamaydi — bu ham pul mantig'i
    previous: {
      fromMonth: prevFrom,
      toMonth: prevTo,
      invoiced: formatAmount(previous.invoiced),
      collected: formatAmount(previous.collected),
      debt: formatAmount(previous.debt),
      collectionRate: percentOf(previous.collected, previous.invoiced),
      invoicedChange: percentOf(
        totals.invoiced.minus(previous.invoiced),
        previous.invoiced,
      ),
      collectedChange: percentOf(
        totals.collected.minus(previous.collected),
        previous.collected,
      ),
    },
    series,
  };
};

// ─────────────────────────────────────────────
// 2. Tushum (kassaga tushgan pul)
// ─────────────────────────────────────────────

const GROUP_BY_SQL = {
  day: "day",
  week: "week",
  month: "month",
};

/**
 * Haqiqiy pul oqimi — hisob-fakturadan EMAS, `Payment` dan.
 *
 * Farqi muhim: hisob-faktura "qancha to'lashi kerak", bu esa "qancha pul
 * kirdi". Depozitga tushgan ortiqcha pul ham shu yerda ko'rinadi.
 *
 * @param {object} query - { from, to, groupBy }
 */
const getCashflow = async (query = {}) => {
  const groupBy = GROUP_BY_SQL[query.groupBy] ?? "day";

  // ⚠️ Kun chegarasi TOSHKENT bo'yicha, aniq ofset bilan quriladi.
  // `new Date(iso)` + `setHours()` HOST taymzonasiga tayanadi: UTC'da
  // ishlaydigan serverda oraliq 5 soatga siljib, kunlik ustunlar
  // qo'shni kunga o'tib ketardi.
  const toIso = query.to || todayIsoTashkent();
  const fromIso = query.from || shiftIsoDays(toIso, -29);

  const from = new Date(`${fromIso}T00:00:00+05:00`);
  const to = new Date(`${toIso}T23:59:59.999+05:00`);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new BadRequestError("Sana noto'g'ri");
  }
  if (from > to) {
    throw new BadRequestError("Boshlanish sanasi tugash sanasidan keyin bo'lishi mumkin emas");
  }

  const paymentWhere = { isVoided: false, paidAt: { gte: from, lte: to } };
  const incomeWhere = { isVoided: false, occurredAt: { gte: from, lte: to } };

  // ⚠️ IKKALA MANBA ham sanaladi: o'quvchi to'lovi (`payments`) va tashqi
  // kirim (`external_incomes`). Faqat birinchisi olinsa, "Jami tushum"
  // kassa qoldig'i o'sishidan kam chiqib, ikki ekran ikki xil haqiqat
  // ko'rsatardi. Ikkalasida ham `is_voided = false`.
  //
  // Kunlik qator — `date_trunc` ni Prisma groupBy ifodalay olmaydi,
  // ikki jadval esa UNION ALL bilan bitta o'qqa keltiriladi.
  const [rows, paymentAgg, incomeAgg, payByAccount, incByAccount] =
    await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT bucket, SUM(amount)::text AS amount, SUM(cnt)::int AS count
           FROM (
             SELECT date_trunc('${groupBy}', paid_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tashkent')::date AS bucket,
                    amount, 1 AS cnt
               FROM payments
              WHERE is_voided = false AND paid_at >= $1 AND paid_at <= $2
             UNION ALL
             SELECT date_trunc('${groupBy}', occurred_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tashkent')::date AS bucket,
                    amount, 1 AS cnt
               FROM external_incomes
              WHERE is_voided = false AND occurred_at >= $1 AND occurred_at <= $2
           ) AS combined
          GROUP BY 1
          ORDER BY 1 ASC`,
        from,
        to,
      ),
      prisma.payment.aggregate({
        where: paymentWhere,
        _sum: { amount: true, allocatedAmount: true, depositAmount: true },
        _count: { _all: true },
      }),
      prisma.externalIncome.aggregate({
        where: incomeWhere,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.payment.groupBy({
        by: ["accountId"],
        where: paymentWhere,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.externalIncome.groupBy({
        by: ["accountId"],
        where: incomeWhere,
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);

  const studentTotal = new Decimal(paymentAgg._sum.amount ?? 0);
  const externalTotal = new Decimal(incomeAgg._sum.amount ?? 0);
  const total = studentTotal.plus(externalTotal);
  const count = paymentAgg._count._all + incomeAgg._count._all;

  // To'lov turi kesimi — ikkala manba bitta hisobga tushishi mumkin,
  // shuning uchun ular qo'shiladi
  const perAccount = new Map();
  for (const row of [...payByAccount, ...incByAccount]) {
    const current = perAccount.get(row.accountId) ?? {
      amount: new Decimal(0),
      count: 0,
    };
    current.amount = current.amount.plus(row._sum.amount ?? 0);
    current.count += row._count._all;
    perAccount.set(row.accountId, current);
  }

  const accounts = await prisma.paymentAccount.findMany({
    where: { id: { in: [...perAccount.keys()] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(accounts.map((a) => [a.id, a.name]));

  const byAccount = [...perAccount.entries()]
    .map(([accountId, row]) => ({
      accountId,
      name: nameById.get(accountId) ?? "Noma'lum",
      amount: formatAmount(row.amount),
      count: row.count,
      share: percentOf(row.amount, total),
    }))
    .sort((a, b) => Number(b.amount) - Number(a.amount));

  return {
    // Kiritilgan qiymatning O'ZI qaytariladi — `Date` dan qayta hosil
    // qilinsa UTC'ga o'girilib, bir kun orqaga siljigan ko'rinardi
    from: fromIso,
    to: toIso,
    groupBy,
    totals: {
      // Kassaga tushgan BUTUN pul — o'quvchi to'lovi + tashqi kirim
      amount: formatAmount(total),
      count,
      // O'rtacha chek — kassirning ishini baholaydigan raqam
      averageReceipt: formatAmount(count > 0 ? total.div(count) : new Decimal(0)),
      allocated: formatAmount(new Decimal(paymentAgg._sum.allocatedAmount ?? 0)),
      toDeposit: formatAmount(new Decimal(paymentAgg._sum.depositAmount ?? 0)),
    },
    // Manba kesimi — "pul qayerdan keldi" degan savolga javob
    bySource: [
      {
        key: "student",
        label: "O'quvchi to'lovi",
        amount: formatAmount(studentTotal),
        count: paymentAgg._count._all,
        share: percentOf(studentTotal, total),
      },
      {
        key: "external",
        label: "Tashqi kirim",
        amount: formatAmount(externalTotal),
        count: incomeAgg._count._all,
        share: percentOf(externalTotal, total),
      },
    ],
    series: rows.map((row) => ({
      date: row.bucket.toISOString().slice(0, 10),
      amount: formatAmount(new Decimal(row.amount ?? 0)),
      count: row.count,
    })),
    byAccount,
  };
};

// ─────────────────────────────────────────────
// 3. Qarzdorlik
// ─────────────────────────────────────────────

/**
 * Qarz manzarasi: yoshi, dinamikasi, eng katta qarzdorlar va sinf kesimi.
 *
 * ⚠️ Qarz "yoshi" hisob-faktura QAYSI OYGA tegishli ekanidan kelib chiqadi,
 * chiqarilgan sanasidan emas: orqaga qarab shakllantirilgan hisob-faktura
 * bugun yozilgan bo'lsa ham eski qarz hisoblanadi.
 */
const getDebt = async (query = {}) => {
  const asOfMonth = query.asOfMonth
    ? parseMonthKey(query.asOfMonth, "Oy")
    : currentMonthKey();

  const unpaidWhere = { status: { in: ["unpaid", "partial"] } };

  const [rows, byClassRows, debtorsPage] = await Promise.all([
    // ⚠️ Qatorlar XOTIRADA guruhlanadi, chunki yosh guruhida SUMMA va
    // O'QUVCHILAR SONI bir xil narsani o'lchashi shart. Ilgari summa oy
    // bo'yicha, o'quvchi soni esa "eng eski qarzi" bo'yicha hisoblanardi:
    // natijada "Joriy oy: 536 mln, 1 o'quvchi" degan ma'nosiz qator chiqardi.
    // Qator soni qarzdor o'quvchi × qarzdor oy bilan chegaralangan.
    prisma.monthlyInvoice.findMany({
      where: { ...unpaidWhere, month: { lte: asOfMonth } },
      select: { studentId: true, month: true, amount: true, paidAmount: true },
    }),
    prisma.$queryRawUnsafe(
      // ⚠️ ORDER BY ustun RAQAMI bo'yicha emas, IFODA bo'yicha: `debt`
      // text'ga o'girilgani uchun `ORDER BY 2` alifbo tartibida saralab,
      // 272 mln 91 mln dan pastda turib qolardi.
      `SELECT COALESCE(student_snapshot->>'className', $1) AS class_name,
              SUM(amount - paid_amount)::text        AS debt,
              COUNT(DISTINCT student_id)::int        AS student_count
         FROM monthly_invoices
        WHERE status IN ('unpaid', 'partial') AND month <= $2
        GROUP BY 1
        ORDER BY SUM(amount - paid_amount) DESC`,
      NO_CLASS_LABEL,
      asOfMonth,
    ),
    // Top qarzdorlar — mavjud registr qayta ishlatiladi, yangi so'rov yozilmaydi
    getDebtors({ query: { limit: "10" } }),
  ]);

  const buckets = AGING_BUCKETS.map((b) => ({
    ...b,
    amount: new Decimal(0),
    invoiceCount: 0,
    students: new Set(),
  }));

  const byMonth = new Map();
  const allDebtors = new Set();
  let total = new Decimal(0);

  for (const row of rows) {
    const debt = clampDebt(new Decimal(row.amount).minus(row.paidAmount));
    if (debt.isZero()) continue;

    total = total.plus(debt);
    allDebtors.add(row.studentId);

    const monthRow = byMonth.get(row.month) ?? { debt: new Decimal(0), count: 0 };
    monthRow.debt = monthRow.debt.plus(debt);
    monthRow.count += 1;
    byMonth.set(row.month, monthRow);

    // Bir o'quvchi bir necha guruhda bo'lishi MUMKIN va bu to'g'ri:
    // uning yanvardagi qarzi ham, avgustdagi qarzi ham alohida yoshda.
    const age = diffMonths(row.month, asOfMonth);
    const bucket = buckets.find((b) => age >= b.min && age <= b.max);
    if (bucket) {
      bucket.amount = bucket.amount.plus(debt);
      bucket.invoiceCount += 1;
      bucket.students.add(row.studentId);
    }
  }

  const series = [...byMonth.entries()]
    .sort(([a], [b]) => a - b)
    .map(([month, row]) => ({
      month,
      monthLabel: formatMonthKey(month),
      monthShort: formatMonthShort(month),
      debt: formatAmount(row.debt),
      invoiceCount: row.count,
    }));

  return {
    asOfMonth,
    asOfMonthLabel: formatMonthKey(asOfMonth),
    totals: {
      debt: formatAmount(total),
      debtorCount: allDebtors.size,
      oldestMonth: series[0]?.month ?? null,
      oldestMonthLabel: series[0]?.monthLabel ?? null,
    },
    aging: buckets.map((b) => ({
      key: b.key,
      label: b.label,
      amount: formatAmount(b.amount),
      share: percentOf(b.amount, total),
      invoiceCount: b.invoiceCount,
      studentCount: b.students.size,
    })),
    byClass: byClassRows.map((row) => {
      const debt = new Decimal(row.debt ?? 0);
      return {
        className: row.class_name,
        debt: formatAmount(debt),
        share: percentOf(debt, total),
        studentCount: row.student_count,
      };
    }),
    topDebtors: (debtorsPage.data ?? []).map((d) => ({
      id: d.id,
      fullName: d.fullName,
      debt: d.debt,
      unpaidCount: d.unpaidCount,
      oldestMonthLabel: d.oldestMonthLabel,
    })),
    series,
  };
};

// ─────────────────────────────────────────────
// 4. Tarif va chegirma
// ─────────────────────────────────────────────

/**
 * Pul qaysi tarifdan kelayotgani, qancha chegirma berilgani va proratsiya
 * tufayli qancha hisoblanmagani.
 *
 * ⚠️ `tariffName` hisob-fakturaga MUHRLANGAN nom: tarif keyin qayta nomlansa
 * ham o'tgan hisobot o'zgarmaydi. Shuning uchun guruhlash `tariffId` emas,
 * aynan shu nom bo'yicha.
 */
const getTariffBreakdown = async (query = {}) => {
  const { fromMonth, toMonth, months } = parseMonthRange(query);
  const where = { month: { gte: fromMonth, lte: toMonth }, ...LIVE_INVOICE };

  const [byTariffRows, byMonthRows] = await Promise.all([
    prisma.monthlyInvoice.groupBy({
      by: ["tariffName"],
      where,
      _sum: { amount: true, paidAmount: true },
      _count: { _all: true },
    }),
    prisma.monthlyInvoice.groupBy({
      by: ["month"],
      where,
      _sum: {
        discountAmount: true,
        baseAmount: true,
        proratedAmount: true,
      },
      _count: { _all: true },
    }),
  ]);

  const totalInvoiced = byTariffRows.reduce(
    (acc, row) => acc.plus(row._sum.amount ?? 0),
    new Decimal(0),
  );

  const byMonth = new Map(byMonthRows.map((row) => [row.month, row]));

  let discountTotal = new Decimal(0);
  let prorationTotal = new Decimal(0);

  const series = months.map((month) => {
    const row = byMonth.get(month);
    const discount = new Decimal(row?._sum.discountAmount ?? 0);
    const proration = clampDebt(
      new Decimal(row?._sum.baseAmount ?? 0).minus(row?._sum.proratedAmount ?? 0),
    );

    discountTotal = discountTotal.plus(discount);
    prorationTotal = prorationTotal.plus(proration);

    return {
      month,
      monthLabel: formatMonthKey(month),
      monthShort: formatMonthShort(month),
      discountAmount: formatAmount(discount),
      prorationAmount: formatAmount(proration),
      invoiceCount: row?._count._all ?? 0,
    };
  });

  // Chegirma summani NOLGA tushirgan hollar — jim qolmasligi kerak
  const wipedByDiscount = await prisma.monthlyInvoice.count({
    where: { ...where, amount: 0, discountAmount: { gt: 0 } },
  });

  return {
    fromMonth,
    toMonth,
    totals: {
      invoiced: formatAmount(totalInvoiced),
      discountTotal: formatAmount(discountTotal),
      prorationTotal: formatAmount(prorationTotal),
      wipedByDiscount,
    },
    byTariff: byTariffRows
      .map((row) => {
        const invoiced = new Decimal(row._sum.amount ?? 0);
        return {
          tariffName: row.tariffName || "Tarifsiz",
          invoiced: formatAmount(invoiced),
          collected: formatAmount(new Decimal(row._sum.paidAmount ?? 0)),
          invoiceCount: row._count._all,
          share: percentOf(invoiced, totalInvoiced),
        };
      })
      .sort((a, b) => Number(b.invoiced) - Number(a.invoiced)),
    series,
  };
};

// ─────────────────────────────────────────────
// 5. Tashqi kirim (o'quvchi to'lovi bo'lmagan pul)
// ─────────────────────────────────────────────

/**
 * Ijara, kitob sotuvi, homiylik — kategoriya kesimida.
 *
 * ⚠️ Guruhlash `categoryName` (hujjatga MUHRLANGAN nom) bo'yicha, katalog
 * `categoryId` si bo'yicha emas: kategoriya keyin qayta nomlansa, o'tgan
 * hisobot o'z nomini saqlashi kerak. `tariffName` bilan bir xil doktrina.
 *
 * @param {object} query - { from, to }
 */
const getExternalIncome = async (query = {}) => {
  const toIso = query.to || todayIsoTashkent();
  const fromIso = query.from || shiftIsoDays(toIso, -364);

  const from = new Date(`${fromIso}T00:00:00+05:00`);
  const to = new Date(`${toIso}T23:59:59.999+05:00`);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new BadRequestError("Sana noto'g'ri");
  }
  if (from > to) {
    throw new BadRequestError("Boshlanish sanasi tugash sanasidan keyin bo'lishi mumkin emas");
  }

  const where = { isVoided: false, occurredAt: { gte: from, lte: to } };

  const [byCategoryRows, agg, monthRows, recent] = await Promise.all([
    prisma.externalIncome.groupBy({
      by: ["categoryName"],
      where,
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.externalIncome.aggregate({
      where,
      _sum: { amount: true },
      _count: { _all: true },
    }),
    // Oylik trend — `date_trunc` Prisma groupBy da ifodalanmaydi
    prisma.$queryRawUnsafe(
      `SELECT to_char(occurred_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tashkent', 'YYYYMM')::int AS month,
              SUM(amount)::text AS amount,
              COUNT(*)::int     AS count
         FROM external_incomes
        WHERE is_voided = false AND occurred_at >= $1 AND occurred_at <= $2
        GROUP BY 1
        ORDER BY 1 ASC`,
      from,
      to,
    ),
    prisma.externalIncome.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      take: 10,
      include: { account: { select: { name: true } } },
    }),
  ]);

  const total = new Decimal(agg._sum.amount ?? 0);

  return {
    from: fromIso,
    to: toIso,
    totals: {
      amount: formatAmount(total),
      count: agg._count._all,
      categoryCount: byCategoryRows.length,
    },
    byCategory: byCategoryRows
      .map((row) => {
        const amount = new Decimal(row._sum.amount ?? 0);
        return {
          categoryName: row.categoryName || "Kategoriyasiz",
          amount: formatAmount(amount),
          count: row._count._all,
          share: percentOf(amount, total),
        };
      })
      .sort((a, b) => Number(b.amount) - Number(a.amount)),
    series: monthRows.map((row) => ({
      month: row.month,
      monthLabel: formatMonthKey(row.month),
      monthShort: formatMonthShort(row.month),
      amount: formatAmount(new Decimal(row.amount ?? 0)),
      count: row.count,
    })),
    recent: recent.map((row) => ({
      id: row.id,
      categoryName: row.categoryName,
      amount: formatAmount(row.amount),
      payer: row.payer,
      note: row.note,
      occurredAt: row.occurredAt,
      accountName: row.account?.name ?? null,
    })),
  };
};

module.exports = {
  getOverview,
  getCashflow,
  getExternalIncome,
  getDebt,
  getTariffBreakdown,
  // Sinov uchun ochiladi
  parseMonthRange,
  AGING_BUCKETS,
  NO_CLASS_LABEL,
};
