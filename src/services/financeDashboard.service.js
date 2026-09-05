/**
 * RAHBAR DASHBOARDI — bitta ekranda butun maktabning pul manzarasi.
 *
 * Ikki iste'molchi bor va IKKALASI HAM SHU SERVICEDAN oziqlanadi:
 *   - "Bosh dashboard"  (egasi/direktor) — yo'nalishlar va maktab KPI si
 *   - "CFO dashboard"   (moliyachi)      — P&L, byudjet, bank hisoblari
 *
 * NIMA UCHUN BITTA MANBA: ikkala ekranda ham "Jami tushum" turadi. Agar
 * ular ikki xil so'rovdan olinsa, bir kuni ikki xil raqam ko'rsatib qoladi
 * va o'sha kundan boshlab ikkalasiga ham ishonilmaydi.
 *
 * ⚠️ BU FAYL HECH NARSA YOZMAYDI. Faqat muhrlangan qatorlarni yig'adi.
 *
 * ⚠️ ASOS — KASSA (pul haqiqatda harakatlandimi), majburiyat emas:
 *     tushum  = to'lov + tashqi kirim + zarar undiruvi   (`sumIncome`)
 *     xarajat = TO'LANGAN oylik + xarajatlar             (`sumExpense`)
 * Ikkalasi ham `financeReport.service.js` dan IMPORT qilinadi — o'z
 * nusxasini yozish "Hisobotlar" tabidagi raqamdan ajralib ketishning
 * birinchi qadami bo'lardi.
 *
 * ⚠️ QARZ esa aksincha — OY bo'yicha (majburiyat), chunki "qarz" degani
 * hisob-faktura yopilmagani. Ikki o'lchov bitta ekranda turadi va bu
 * ATAYLAB: kartalarning yorliqlari ularni ajratib turadi.
 */

const prisma = require("../config/prisma");
const { BadRequestError } = require("../utils/errors");
const {
  currentMonthKey,
  parseOptionalMonthKey,
  formatMonthKey,
  formatMonthShort,
  nextMonth,
  prevMonth,
  monthStartDate,
  monthEndDate,
} = require("../helpers/month.helpers");
const { Decimal, formatAmount } = require("../helpers/money.helpers");
const { sumIncome, sumExpense, AGING_BUCKETS } = require("./financeReport.service");
const { ENTRY_TYPE_LABELS } = require("./paymentAccount.service");
const { getDebtors } = require("./invoice.service");
const { loadTargetMap, loadCustomTargets } = require("./financeTarget.service");
const { loadBudgetSummary } = require("./expenseBudget.service");
const { loadPlanSummary } = require("./incomePlan.service");

/** Trend diagrammasidagi oylar soni (dizayndagi "12 oylik"). */
const DEFAULT_TREND_MONTHS = 12;
const MAX_TREND_MONTHS = 36;

/** So'nggi operatsiyalar jadvalidagi qatorlar soni. */
const RECENT_LIMIT = 8;

/** "Eng katta qarzdorlar" ro'yxatidagi qatorlar soni. */
const TOP_DEBTORS_LIMIT = 6;

/** Hisob-faktura hisobga olinadigan holatlar (bekor qilingani sanalmaydi). */
const LIVE_INVOICE = { status: { not: "cancelled" } };

/** Tarifsiz hisob-fakturaning yo'nalish nomi. */
const NO_TARIFF_LABEL = "Tarifsiz";

/** Yo'nalish sifatida chiqadigan, tarif bo'lmagan kirim manbalari. */
const NON_TARIFF_SOURCES = {
  deposit: "Oldindan to'lov (depozit)",
  external: "Tashqi kirimlar",
  damage: "Moddiy zarar undiruvi",
};

// ─────────────────────────────────────────────
// Yordamchilar
// ─────────────────────────────────────────────

/**
 * Oyning TOSHKENT bo'yicha boshi va oxiri (instant maydonlar uchun).
 *
 * ⚠️ `month.helpers.js` dagi `monthStartDate/monthEndDate` UTC YARIM TUNI
 * qaytaradi — ular `@db.Date` ustunlari uchun. To'lov va xarajat esa
 * INSTANT (`paid_at`, `occurred_at`), shuning uchun chegara aniq +05:00
 * ofseti bilan quriladi: aks holda UTC serverda oy chegarasi 5 soatga
 * siljib, oyning birinchi kunidagi to'lovlar o'tgan oyga tushib ketardi.
 *
 * @param {number} monthKey
 * @returns {{from: Date, to: Date}}
 */
const monthInstantRange = (monthKey) => {
  const iso = (key) =>
    `${Math.trunc(key / 100)}-${String(key % 100).padStart(2, "0")}-01T00:00:00+05:00`;

  return {
    from: new Date(iso(monthKey)),
    // Keyingi oy boshidan 1 ms oldin. `oy + 1` bilan hisoblab bo'lmaydi:
    // dekabrda 13-oy chiqardi — `nextMonth` yil chegarasini o'zi hal qiladi.
    to: new Date(new Date(iso(nextMonth(monthKey))).getTime() - 1),
  };
};

/** Foiz — 1 xonali. Bo'luvchi nol bo'lsa `null` (0% BILAN BIR XIL EMAS). */
const rateOf = (part, whole) => {
  const w = new Decimal(whole);
  if (w.isZero()) return null;
  return Number(new Decimal(part).div(w).times(100).toFixed(1));
};

/** Foiz — bo'luvchi nol bo'lsa 0 (ulush diagrammalari uchun). */
const shareOf = (part, whole) => {
  const w = new Decimal(whole);
  if (w.isZero()) return 0;
  return Number(new Decimal(part).div(w).times(100).toFixed(1));
};

/**
 * O'sish foizi: (joriy − oldingi) / |oldingi|.
 *
 * ⚠️ Maxrajda MODUL turadi. Oldingi qiymat manfiy bo'lsa (zarar chiqqan oy)
 * oddiy bo'lish ishorani ag'darib, yaxshilanishni "pasayish" deb ko'rsatardi.
 * Oldingi qiymat nol bo'lsa foiz YO'Q (`null`), 100% emas.
 */
const changeOf = (current, previous) => {
  const prev = new Decimal(previous);
  if (prev.isZero()) return null;
  return Number(new Decimal(current).minus(prev).div(prev.abs()).times(100).toFixed(1));
};

/** Reja bajarilishi: amalda / reja. Reja yo'q bo'lsa `null`. */
const planRateOf = (actual, plan) => {
  if (plan == null) return null;
  const p = new Decimal(plan);
  if (p.isZero()) return null;
  return Number(new Decimal(actual).div(p).times(100).toFixed(1));
};

/**
 * Bir oyning butun moliyaviy kesimi — KPI va P&L shu uchlikdan quriladi.
 * @param {number} monthKey
 */
const monthFigures = async (monthKey) => {
  const { from, to } = monthInstantRange(monthKey);

  const [income, expense] = await Promise.all([sumIncome(from, to), sumExpense(from, to)]);

  const profit = income.minus(expense.total);

  return {
    month: monthKey,
    from,
    to,
    income,
    expense: expense.total,
    salary: expense.salary,
    otherExpense: expense.other,
    profit,
    margin: new Decimal(rateOf(profit, income) ?? 0),
  };
};

/**
 * Berilgan lahzagacha bo'lgan UMUMIY kassa qoldig'i.
 *
 * `openingBalance + Σ entries` — bu financeReconcile job har kecha
 * tekshiradigan invariantning aynan o'zi, faqat barcha hisoblar bo'yicha.
 * Shu sababli `to = hozir` bo'lganda natija `Σ PaymentAccount.balance` ga
 * teng chiqadi va ikki ekranda ikki xil qoldiq bo'lmaydi.
 *
 * ⚠️ Arxivlangan hisob ham qo'shiladi: undagi pul yo'qolib qolmasligi kerak.
 *
 * @param {Date} at
 * @returns {Promise<Decimal>}
 */
const balanceAt = async (at) => {
  const [openings, entries] = await Promise.all([
    prisma.paymentAccount.aggregate({ _sum: { openingBalance: true } }),
    prisma.accountEntry.aggregate({
      where: { occurredAt: { lte: at } },
      _sum: { amount: true },
    }),
  ]);

  return new Decimal(openings._sum.openingBalance ?? 0).plus(entries._sum.amount ?? 0);
};

// ─────────────────────────────────────────────
// Bloklar
// ─────────────────────────────────────────────

/**
 * 12 oylik dinamika: tushum, xarajat, sof foyda va oy oxiridagi qoldiq.
 *
 * BITTA xom so'rov: besh manba `UNION ALL` bilan bitta o'qqa keltiriladi.
 * Prisma `groupBy` "sanani Toshkent oyiga yaxlitlash" ni ifodalay olmaydi,
 * har manbaga alohida so'rov yuborish esa 5 × 12 = 60 marta bazaga borish
 * degani bo'lardi.
 *
 * @param {number[]} months - o'sish tartibida
 */
const buildTrend = async (months) => {
  const first = months[0];
  const last = months[months.length - 1];
  const from = monthInstantRange(first).from;
  const to = monthInstantRange(last).to;

  const TASHKENT = `AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tashkent'`;

  const [rows, deltas, opening, before] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT month, kind, SUM(amount)::text AS amount
         FROM (
           SELECT to_char(paid_at ${TASHKENT}, 'YYYYMM')::int AS month, 'income' AS kind, amount
             FROM payments            WHERE is_voided = false AND paid_at     >= $1 AND paid_at     <= $2
           UNION ALL
           SELECT to_char(occurred_at ${TASHKENT}, 'YYYYMM')::int, 'income', amount
             FROM external_incomes    WHERE is_voided = false AND occurred_at >= $1 AND occurred_at <= $2
           UNION ALL
           SELECT to_char(paid_at ${TASHKENT}, 'YYYYMM')::int, 'income', amount
             FROM damage_payments     WHERE is_voided = false AND paid_at     >= $1 AND paid_at     <= $2
           UNION ALL
           SELECT to_char(paid_at ${TASHKENT}, 'YYYYMM')::int, 'expense', amount
             FROM salary_payments     WHERE is_voided = false AND paid_at     >= $1 AND paid_at     <= $2
           UNION ALL
           SELECT to_char(occurred_at ${TASHKENT}, 'YYYYMM')::int, 'expense', amount
             FROM expenses            WHERE is_voided = false AND occurred_at >= $1 AND occurred_at <= $2
         ) AS combined
        GROUP BY 1, 2`,
      from,
      to,
    ),
    // Kassa qoldig'i chizig'i — daftarning O'ZIDAN. Tushum/xarajat ayirmasi
    // bilan hisoblab bo'lmaydi: o'tkazma, qaytarish va qo'lda to'g'rilash
    // ham qoldiqni o'zgartiradi, lekin tushum ham, xarajat ham emas.
    prisma.$queryRawUnsafe(
      `SELECT to_char(occurred_at ${TASHKENT}, 'YYYYMM')::int AS month, SUM(amount)::text AS delta
         FROM account_entries
        WHERE occurred_at >= $1 AND occurred_at <= $2
        GROUP BY 1`,
      from,
      to,
    ),
    prisma.paymentAccount.aggregate({ _sum: { openingBalance: true } }),
    prisma.accountEntry.aggregate({
      where: { occurredAt: { lt: from } },
      _sum: { amount: true },
    }),
  ]);

  const byMonth = new Map();
  for (const row of rows) {
    const entry = byMonth.get(row.month) ?? { income: new Decimal(0), expense: new Decimal(0) };
    entry[row.kind] = entry[row.kind].plus(row.amount ?? 0);
    byMonth.set(row.month, entry);
  }

  const deltaByMonth = new Map(deltas.map((row) => [row.month, new Decimal(row.delta ?? 0)]));

  // Oraliq boshigacha yig'ilgan qoldiq — chiziq noldan emas, haqiqiy
  // nuqtadan boshlanishi kerak
  let running = new Decimal(opening._sum.openingBalance ?? 0).plus(before._sum.amount ?? 0);

  return months.map((month) => {
    const row = byMonth.get(month) ?? { income: new Decimal(0), expense: new Decimal(0) };
    running = running.plus(deltaByMonth.get(month) ?? 0);

    return {
      month,
      monthLabel: formatMonthKey(month),
      monthShort: formatMonthShort(month),
      income: formatAmount(row.income),
      expense: formatAmount(row.expense),
      profit: formatAmount(row.income.minus(row.expense)),
      margin: rateOf(row.income.minus(row.expense), row.income) ?? 0,
      balance: formatAmount(running),
    };
  });
};

/**
 * XARAJATLAR TUZILMASI — oylik alohida ulush, qolgani kategoriya kesimida.
 *
 * ⚠️ Oylik `ExpenseCategory` da EMAS (u alohida mexanizm), lekin rahbar
 * uchun "pul qayerga ketdi" degan savolda u eng katta ulush. Shuning uchun
 * diagrammaga sun'iy "Xodimlar maoshi" bo'lagi sifatida qo'shiladi.
 *
 * Guruhlash `categoryId` VA `categoryName` juftligi bo'yicha: yorliq
 * hujjatga MUHRLANGAN nomdan olinadi (kategoriya keyin qayta nomlansa
 * o'tgan hisobot o'zgarmasligi kerak), EBITDA bayrog'i esa katalogdan —
 * u joriy qaror, snapshot emas.
 *
 * @param {{from: Date, to: Date}} range
 * @param {Decimal} salary
 */
const buildExpenseStructure = async ({ from, to }, salary) => {
  const [rows, categories] = await Promise.all([
    prisma.expense.groupBy({
      by: ["categoryId", "categoryName"],
      where: { isVoided: false, occurredAt: { gte: from, lte: to } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.expenseCategory.findMany({ select: { id: true, excludeFromEbitda: true } }),
  ]);

  const excludedIds = new Set(
    categories.filter((c) => c.excludeFromEbitda).map((c) => c.id),
  );

  let ebitdaAddBack = new Decimal(0);
  const categoryItems = [];

  for (const row of rows) {
    const amount = new Decimal(row._sum.amount ?? 0);
    if (amount.isZero()) continue;

    const excluded = excludedIds.has(row.categoryId);
    if (excluded) ebitdaAddBack = ebitdaAddBack.plus(amount);

    categoryItems.push({
      key: row.categoryId,
      label: row.categoryName || "Kategoriyasiz",
      amount,
      count: row._count._all,
      excludeFromEbitda: excluded,
    });
  }

  const items = [];
  if (salary.greaterThan(0)) {
    items.push({
      key: "salary",
      label: "Xodimlar maoshi",
      amount: salary,
      count: null,
      excludeFromEbitda: false,
    });
  }
  items.push(...categoryItems);
  items.sort((a, b) => b.amount.comparedTo(a.amount));

  const total = items.reduce((acc, row) => acc.plus(row.amount), new Decimal(0));

  const serialized = items.map((row) => ({
    key: row.key,
    label: row.label,
    amount: formatAmount(row.amount),
    count: row.count,
    share: shareOf(row.amount, total),
    excludeFromEbitda: row.excludeFromEbitda,
  }));

  return {
    total: formatAmount(total),
    items: serialized,
    // Dizayndagi "TOP 5 XARAJAT KATEGORIYALARI" — o'sha ro'yxatning boshi,
    // ALOHIDA so'rov emas: ikki so'rov bo'lsa ular bir kuni ajralib ketardi.
    top: serialized.slice(0, 5),
    ebitdaAddBack,
  };
};

/**
 * DAROMAD TUZILMASI (yo'nalishlar bo'yicha) va YO'NALISHLAR NATIJASI.
 *
 * "Yo'nalish" = TARIF: dizayndagi "Maktab", "Bog'cha (800 ming)",
 * "O'quv markazi" — bularning har biri narx katalogidagi alohida tarif.
 *
 * ⚠️ Nima uchun to'lov TAQSIMOTLARI orqali, hisob-faktura orqali emas:
 * dashboardning butun asosi — KASSA. Hisob-faktura bo'yicha olsak
 * "Daromad tuzilmasi" ning yig'indisi yuqoridagi "Jami tushum" kartasiga
 * teng chiqmasdi (biri majburiyat, biri pul).
 *
 * Taqsimotlar `payment.paid_at` bo'yicha filtrlanadi (pul QACHON kirdi),
 * `applied_at` bo'yicha emas: depozitdan yopilgan oy taqsimoti keyinroq
 * yaratiladi, lekin pul o'sha eski chek bilan kirgan.
 *
 * Uch qo'shimcha qator YIG'INDINI AYNAN "Jami tushum" ga tenglaydi:
 *   depozit  = shu oy to'lovlari − o'sha to'lovlarning taqsimotlari
 *   tashqi kirim, zarar undiruvi — to'g'ridan-to'g'ri
 *
 * @param {{from: Date, to: Date}} range
 * @param {Decimal} totalExpense - yo'nalishlarga taqsimlanadigan xarajat
 */
const buildRevenueStructure = async ({ from, to }, totalExpense) => {
  const [allocRows, paymentAgg, externalAgg, damageAgg] = await Promise.all([
    // ⚠️ ORDER BY ustun raqami bo'yicha EMAS: `amount` text'ga o'girilgan va
    // alifbo tartibida saralanib, 272 mln 91 mln dan pastda turib qolardi.
    // ⚠️ YO'NALISH bo'yicha guruhlanadi, tarif esa ZAXIRA. Yo'nalish
    // tushunchasi keyin qo'shilgani uchun eski hisob-fakturalarda
    // `direction_name` bo'sh: ular tarif nomi bilan guruhlanaveradi va
    // o'tgan oylarning hisoboti buzilmaydi.
    prisma.$queryRawUnsafe(
      `SELECT COALESCE(NULLIF(i.direction_name, ''), NULLIF(i.tariff_name, ''), $3) AS name,
              SUM(a.amount)::text                     AS amount,
              COUNT(DISTINCT a.student_id)::int       AS student_count
         FROM payment_allocations a
         JOIN payments        p ON p.id = a.payment_id
         JOIN monthly_invoices i ON i.id = a.invoice_id
        WHERE a.is_voided = false
          AND p.is_voided = false
          AND p.paid_at >= $1 AND p.paid_at <= $2
        GROUP BY 1
        ORDER BY SUM(a.amount) DESC`,
      from,
      to,
      NO_TARIFF_LABEL,
    ),
    prisma.payment.aggregate({
      where: { isVoided: false, paidAt: { gte: from, lte: to } },
      _sum: { amount: true },
    }),
    prisma.externalIncome.aggregate({
      where: { isVoided: false, occurredAt: { gte: from, lte: to } },
      _sum: { amount: true },
    }),
    prisma.damagePayment.aggregate({
      where: { isVoided: false, paidAt: { gte: from, lte: to } },
      _sum: { amount: true },
    }),
  ]);

  const studentTotal = new Decimal(paymentAgg._sum.amount ?? 0);
  const external = new Decimal(externalAgg._sum.amount ?? 0);
  const damage = new Decimal(damageAgg._sum.amount ?? 0);

  const rows = allocRows.map((row) => ({
    key: row.name,
    label: row.name,
    amount: new Decimal(row.amount ?? 0),
    studentCount: row.student_count,
  }));

  const allocated = rows.reduce((acc, row) => acc.plus(row.amount), new Decimal(0));

  // ⚠️ Ayirma bilan hisoblanadi, `payment.depositAmount` yig'indisi bilan
  // EMAS: shunda qator yig'indisi to'lovlar summasiga AYNAN teng chiqadi,
  // bekor qilingan taqsimot yoki keyinchalik depozitdan yopilgan oy kabi
  // chekka holatlarda ham.
  const deposit = studentTotal.minus(allocated);
  if (!deposit.isZero()) {
    rows.push({
      key: "deposit",
      label: NON_TARIFF_SOURCES.deposit,
      amount: deposit,
      studentCount: null,
    });
  }
  if (external.greaterThan(0)) {
    rows.push({
      key: "external",
      label: NON_TARIFF_SOURCES.external,
      amount: external,
      studentCount: null,
    });
  }
  if (damage.greaterThan(0)) {
    rows.push({
      key: "damage",
      label: NON_TARIFF_SOURCES.damage,
      amount: damage,
      studentCount: null,
    });
  }

  rows.sort((a, b) => b.amount.comparedTo(a.amount));

  const total = studentTotal.plus(external).plus(damage);

  // ── Yo'nalish bo'yicha natija ───────────────────────────────────────
  // ⚠️ XARAJAT YO'NALISHLAR BO'YICHA YURITILMAYDI. Kommunal to'lov ham,
  // direktor oyligi ham bitta yo'nalishga tegishli emas. Shuning uchun u
  // TUSHUM ULUSHIGA MUTANOSIB taqsimlanadi va bu ekranda ochiq yozilgan.
  // Sun'iy "to'g'ri" taqsimot o'ylab topish (masalan o'quvchi soniga
  // bo'lish) raqamni ishonarli, lekin yolg'on qilardi.
  //
  // Oxirgi qatorga QOLDIQ beriladi — yaxlitlashdan keyin ulushlar
  // yig'indisi jami xarajatga tiyin-ba-tiyin teng bo'lishi uchun.
  let distributed = new Decimal(0);
  const directions = rows.map((row, index) => {
    const isLast = index === rows.length - 1;
    const share = total.isZero()
      ? new Decimal(0)
      : new Decimal(totalExpense).times(row.amount).div(total);
    const expense = isLast
      ? new Decimal(totalExpense).minus(distributed)
      : new Decimal(share.toFixed(2));
    distributed = distributed.plus(expense);

    const profit = row.amount.minus(expense);

    return {
      key: row.key,
      label: row.label,
      income: formatAmount(row.amount),
      studentCount: row.studentCount,
      share: shareOf(row.amount, total),
      expense: formatAmount(expense),
      profit: formatAmount(profit),
      margin: rateOf(profit, row.amount),
    };
  });

  return {
    total: formatAmount(total),
    items: rows.map((row) => ({
      key: row.key,
      label: row.label,
      amount: formatAmount(row.amount),
      studentCount: row.studentCount,
      share: shareOf(row.amount, total),
    })),
    directions,
    directionTotals: {
      income: formatAmount(total),
      expense: formatAmount(new Decimal(totalExpense)),
      profit: formatAmount(total.minus(totalExpense)),
      margin: rateOf(total.minus(totalExpense), total),
    },
  };
};

/**
 * BANK HISOBLARI HOLATI — har bir to'lov turining qoldig'i va o'zgarishi.
 *
 * Tarixiy qoldiq "hozirgi qoldiq − o'sha sanadan KEYINGI harakatlar"
 * bilan olinadi: daftar append-only, ya'ni bu ayirma har doim to'g'ri.
 *
 * @param {Date} at - joriy oy oxiri
 * @param {Date} compareAt - taqqoslanadigan oy oxiri
 */
const buildAccounts = async (at, compareAt) => {
  const [accounts, afterCurrent, afterCompare] = await Promise.all([
    prisma.paymentAccount.findMany({
      where: { isArchived: false },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, balance: true, isActive: true },
    }),
    prisma.accountEntry.groupBy({
      by: ["accountId"],
      where: { occurredAt: { gt: at } },
      _sum: { amount: true },
    }),
    prisma.accountEntry.groupBy({
      by: ["accountId"],
      where: { occurredAt: { gt: compareAt } },
      _sum: { amount: true },
    }),
  ]);

  const afterCurrentById = new Map(
    afterCurrent.map((row) => [row.accountId, new Decimal(row._sum.amount ?? 0)]),
  );
  const afterCompareById = new Map(
    afterCompare.map((row) => [row.accountId, new Decimal(row._sum.amount ?? 0)]),
  );

  let total = new Decimal(0);
  const items = accounts.map((account) => {
    const balance = new Decimal(account.balance).minus(
      afterCurrentById.get(account.id) ?? 0,
    );
    const previous = new Decimal(account.balance).minus(
      afterCompareById.get(account.id) ?? 0,
    );
    total = total.plus(balance);

    return {
      id: account.id,
      name: account.name,
      isActive: account.isActive,
      balance: formatAmount(balance),
      previousBalance: formatAmount(previous),
      change: changeOf(balance, previous),
    };
  });

  return {
    total: formatAmount(total),
    items: items.map((row) => ({ ...row, share: shareOf(row.balance, total) })),
  };
};

/**
 * DEBITOR QARZDORLIK — oy oxiri holatiga.
 *
 * ⚠️ Bu yagona blok MAJBURIYAT o'lchovida ishlaydi: qarz "hisob-faktura
 * yopilmagani", ya'ni oy koordinatasi. Qolgan bloklar kassa bo'yicha.
 *
 * "30 kundan ortiq" — JORIY oydan OLDINGI oylarning yopilmagan qoldig'i.
 * Kun bilan hisoblash mumkin emas: hisob-fakturada kun koordinatasi yo'q
 * (u oyga tegishli fakt), orqaga sanalgan qator esa bugun yozilgan bo'lsa
 * ham eski qarz hisoblanadi.
 *
 * @param {number} asOfMonth
 */
const buildDebt = async (asOfMonth) => {
  const [debtRow, totalRow, agingRows, debtorsPage] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(amount - paid_amount), 0)::text                                      AS debt,
              COUNT(DISTINCT student_id)::int                                                   AS debtors,
              COALESCE(SUM(CASE WHEN month < $1 THEN amount - paid_amount ELSE 0 END), 0)::text AS overdue,
              MIN(month)::int                                                                   AS oldest_month
         FROM monthly_invoices
        WHERE status IN ('unpaid', 'partial') AND month <= $1`,
      asOfMonth,
    ),
    prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT student_id)::int AS total
         FROM monthly_invoices
        WHERE status <> 'cancelled' AND month <= $1`,
      asOfMonth,
    ),
    // ⚠️ Qarz "yoshi" hisob-faktura QAYSI OYGA tegishli ekanidan kelib
    // chiqadi, chiqarilgan sanasidan emas: orqaga qarab shakllantirilgan
    // qator bugun yozilgan bo'lsa ham eski qarz hisoblanadi.
    //
    // Guruhlash SQL'da: o'quvchilar sonini bucket bo'yicha `DISTINCT`
    // sanash kerak, buni oylik yig'malarni qo'shib chiqarib bo'lmaydi
    // (bir o'quvchi bir necha oyda qarzdor bo'lishi mumkin).
    prisma.$queryRawUnsafe(
      `SELECT CASE
                WHEN age <= 0            THEN 'current'
                WHEN age = 1             THEN 'm1'
                WHEN age BETWEEN 2 AND 3 THEN 'm2_3'
                WHEN age BETWEEN 4 AND 6 THEN 'm4_6'
                ELSE 'm7plus'
              END                            AS bucket,
              SUM(debt)::text                AS debt,
              COUNT(DISTINCT student_id)::int AS students
         FROM (
           SELECT student_id,
                  (amount - paid_amount) AS debt,
                  (($1 / 100) * 12 + ($1 % 100)) - ((month / 100) * 12 + (month % 100)) AS age
             FROM monthly_invoices
            WHERE status IN ('unpaid', 'partial') AND month <= $1
         ) AS aged
        GROUP BY 1`,
      asOfMonth,
    ),
    // Mavjud registr qayta ishlatiladi — yangi so'rov yozilmaydi
    getDebtors({ query: { limit: String(TOP_DEBTORS_LIMIT) } }),
  ]);

  const row = debtRow[0] ?? {};
  const debt = new Decimal(row.debt ?? 0);
  const debtorCount = row.debtors ?? 0;
  const studentCount = totalRow[0]?.total ?? 0;
  const oldestMonth = row.oldest_month ?? null;

  const agingByKey = new Map(agingRows.map((r) => [r.bucket, r]));

  return {
    asOfMonth,
    asOfMonthLabel: formatMonthKey(asOfMonth),
    debt: formatAmount(debt),
    overdue: formatAmount(new Decimal(row.overdue ?? 0)),
    debtorCount,
    studentCount,
    // "Qarzsiz" ulushi — diagrammaning ikkinchi bo'lagi
    clearCount: Math.max(studentCount - debtorCount, 0),
    debtorShare: studentCount > 0 ? shareOf(debtorCount, studentCount) : 0,
    average: formatAmount(debtorCount > 0 ? debt.div(debtorCount) : new Decimal(0)),
    oldestMonth,
    oldestMonthLabel: oldestMonth ? formatMonthKey(oldestMonth) : null,
    // Yosh guruhlari — yorliq va tartib `financeReport.service.js` dagi
    // yagona katalogdan, ikki ekranda ikki xil chegara bo'lmasligi uchun
    aging: AGING_BUCKETS.map((bucket) => {
      const found = agingByKey.get(bucket.key);
      const amount = new Decimal(found?.debt ?? 0);
      return {
        key: bucket.key,
        label: bucket.label,
        amount: formatAmount(amount),
        share: shareOf(amount, debt),
        studentCount: found?.students ?? 0,
      };
    }),
    topDebtors: (debtorsPage.data ?? []).map((d) => ({
      id: d.id,
      fullName: d.fullName,
      isArchived: d.isArchived,
      debt: d.debt,
      unpaidCount: d.unpaidCount,
      oldestMonthLabel: d.oldestMonthLabel,
    })),
  };
};

/**
 * HISOBLANGAN VA YIG'ILGAN — dashboarddagi yagona MAJBURIYAT kesimi.
 *
 * Qolgan bloklar kassa bo'yicha ("pul kirdimi"), bu esa "qancha to'lashi
 * kerak edi" degan savolga javob beradi. Ikkalasi kerak: faqat kassaga
 * qarab turgan rahbar "bu oy yaxshi o'tdi" deb o'ylashi mumkin, holbuki
 * pul o'tgan oylarning qarzidan yig'ilgan bo'lishi mumkin.
 *
 * Chegirma va proratsiya ham shu yerda: ular pul harakati emas, ular
 * HISOBLANMAGAN pul.
 *
 * @param {number[]} months - o'sish tartibida
 * @param {number} month - tanlangan oy (jami raqamlar shu oy uchun)
 */
const buildAccrual = async (months, month) => {
  const first = months[0];
  const last = months[months.length - 1];

  const rows = await prisma.monthlyInvoice.groupBy({
    by: ["month"],
    where: { month: { gte: first, lte: last }, ...LIVE_INVOICE },
    _sum: {
      amount: true,
      paidAmount: true,
      baseAmount: true,
      proratedAmount: true,
      discountAmount: true,
    },
    _count: { _all: true },
  });

  const byMonth = new Map(rows.map((r) => [r.month, r]));

  const series = months.map((key) => {
    const r = byMonth.get(key);
    const invoiced = new Decimal(r?._sum.amount ?? 0);
    const collected = new Decimal(r?._sum.paidAmount ?? 0);

    return {
      month: key,
      monthLabel: formatMonthKey(key),
      monthShort: formatMonthShort(key),
      invoiced: formatAmount(invoiced),
      collected: formatAmount(collected),
      collectionRate: rateOf(collected, invoiced) ?? 0,
      invoiceCount: r?._count._all ?? 0,
    };
  });

  const current = byMonth.get(month);
  const invoiced = new Decimal(current?._sum.amount ?? 0);
  const collected = new Decimal(current?._sum.paidAmount ?? 0);
  const base = new Decimal(current?._sum.baseAmount ?? 0);
  const prorated = new Decimal(current?._sum.proratedAmount ?? 0);
  const proration = base.minus(prorated);

  return {
    series,
    totals: {
      invoiced: formatAmount(invoiced),
      collected: formatAmount(collected),
      // Manfiy qarz bo'lmaydi — ortiqcha to'lov depozitga ketadi
      debt: formatAmount(
        invoiced.minus(collected).isNegative() ? new Decimal(0) : invoiced.minus(collected),
      ),
      collectionRate: rateOf(collected, invoiced),
      discount: formatAmount(new Decimal(current?._sum.discountAmount ?? 0)),
      proration: formatAmount(proration.isNegative() ? new Decimal(0) : proration),
      invoiceCount: current?._count._all ?? 0,
    },
  };
};

/**
 * NARX INTIZOMI — yo'nalish bo'yicha o'rtacha chek va tarif narxi.
 *
 * Savol: "Maktab yo'nalishida tarif 1 000 000 so'm, lekin bitta o'quvchidan
 * o'rtacha qancha yozyapmiz?" Farq — chegirma va kirish proratsiyasining
 * jami ta'siri. U kattalashsa, narx siyosati amalda buzilyapti degani.
 *
 * ⚠️ "Tavsiya etilgan chek" — ALOHIDA SOZLAMA EMAS, u hisob-fakturaga
 * MUHRLANGAN `baseAmount` (chegirmagacha va proratsiyagacha bo'lgan to'liq
 * tarif narxi). Buni yangi jadvalga qo'lda kiritish ikkinchi haqiqat manbai
 * bo'lardi: tarif narxi o'zgarganda kimdir uni yangilashni unutar edi.
 *
 * ⚠️ Bu blok MAJBURIYAT o'lchovida (hisob-faktura), kassa emas: "narx"
 * degani qancha YOZILGANI, qancha kelgani emas.
 *
 * @param {number} month
 */
const buildPricing = async (month) => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(NULLIF(direction_name, ''), NULLIF(tariff_name, ''), $2) AS name,
            COUNT(DISTINCT student_id)::int      AS students,
            SUM(amount)::text                    AS invoiced,
            SUM(base_amount)::text               AS base_total,
            SUM(paid_amount)::text               AS collected,
            SUM(discount_amount)::text           AS discount
       FROM monthly_invoices
      WHERE month = $1 AND status <> 'cancelled'
      GROUP BY 1
      ORDER BY SUM(amount) DESC`,
    month,
    NO_TARIFF_LABEL,
  );

  let required = new Decimal(0);
  let recommended = new Decimal(0);
  let collected = new Decimal(0);
  let students = 0;

  const items = rows.map((row) => {
    const invoiced = new Decimal(row.invoiced ?? 0);
    const baseTotal = new Decimal(row.base_total ?? 0);
    const paid = new Decimal(row.collected ?? 0);
    const count = row.students ?? 0;

    required = required.plus(invoiced);
    recommended = recommended.plus(baseTotal);
    collected = collected.plus(paid);
    students += count;

    const averageCheck = count > 0 ? invoiced.div(count) : new Decimal(0);
    const recommendedCheck = count > 0 ? baseTotal.div(count) : new Decimal(0);

    return {
      key: row.name,
      label: row.name,
      studentCount: count,
      invoiced: formatAmount(invoiced),
      collected: formatAmount(paid),
      discount: formatAmount(new Decimal(row.discount ?? 0)),
      averageCheck: formatAmount(averageCheck),
      recommendedCheck: formatAmount(recommendedCheck),
      // Manfiy = chegirma/proratsiya narxni yeyayapti
      gap: formatAmount(averageCheck.minus(recommendedCheck)),
      gapRate: rateOf(averageCheck.minus(recommendedCheck), recommendedCheck),
      collectionRate: rateOf(paid, invoiced),
    };
  });

  return {
    items,
    totals: {
      studentCount: students,
      // "Umumiy yig'ilish kerak summa" — shu oyning majburiyati
      required: formatAmount(required),
      // "Tavsiya etilgan summa" — chegirmasiz, to'liq tarif bo'yicha
      recommended: formatAmount(recommended),
      diff: formatAmount(required.minus(recommended)),
      collected: formatAmount(collected),
      collectionRate: rateOf(collected, required),
      averageCheck: formatAmount(
        students > 0 ? required.div(students) : new Decimal(0),
      ),
      recommendedCheck: formatAmount(
        students > 0 ? recommended.div(students) : new Decimal(0),
      ),
    },
  };
};

/**
 * SO'NGGI MOLIYAVIY OPERATSIYALAR — kassa daftarining oxirgi qatorlari.
 *
 * ⚠️ Tartib `seq` bo'yicha, `occurredAt` bo'yicha EMAS: `balanceAfter`
 * aynan `seq` ga bog'liq va orqaga sanalgan to'lov ro'yxat o'rtasiga
 * tushib, "qoldiq" ustunini ma'nosiz qilib qo'yardi.
 *
 * ⚠️ `balanceAfter` — O'SHA HISOBNING qoldig'i, umumiy kassaniki emas.
 * Frontend ustunni shunga yarasha nomlaydi.
 */
const buildRecent = async () => {
  const rows = await prisma.accountEntry.findMany({
    orderBy: { seq: "desc" },
    take: RECENT_LIMIT,
    include: {
      account: { select: { name: true } },
      payment: { select: { studentSnapshot: true } },
      expense: { select: { categoryName: true, payee: true } },
      externalIncome: { select: { categoryName: true, payer: true } },
      salaryPayment: { select: { staffSnapshot: true } },
    },
  });

  const fullName = (snapshot) => {
    if (!snapshot || typeof snapshot !== "object") return "";
    return [snapshot.firstName, snapshot.lastName].filter(Boolean).join(" ").trim();
  };

  return rows.map((row) => {
    const amount = new Decimal(row.amount);
    const isIncome = amount.greaterThan(0);

    // Tavsif: hodisa turi + uni tanib olish uchun eng qisqa ma'lumot.
    // Rahbar jadvalga bir qarab "bu nima edi" deb tushunishi kerak.
    const detail =
      fullName(row.payment?.studentSnapshot) ||
      fullName(row.salaryPayment?.staffSnapshot) ||
      row.expense?.categoryName ||
      row.externalIncome?.categoryName ||
      "";

    return {
      id: row.id,
      seq: String(row.seq),
      occurredAt: row.occurredAt,
      type: row.type,
      typeLabel: ENTRY_TYPE_LABELS[row.type] ?? row.type,
      description: detail ? `${ENTRY_TYPE_LABELS[row.type] ?? row.type} — ${detail}` : (ENTRY_TYPE_LABELS[row.type] ?? row.type),
      accountName: row.account?.name ?? null,
      isIncome,
      amount: formatAmount(amount.abs()),
      signedAmount: formatAmount(amount),
      balanceAfter: formatAmount(row.balanceAfter),
    };
  });
};

// ─────────────────────────────────────────────
// 1. Rahbar dashboardi
// ─────────────────────────────────────────────

/**
 * @param {{month?: string|number, compareMonth?: string|number, trendMonths?: string|number}} query
 */
const getDashboard = async (query = {}) => {
  const month = parseOptionalMonthKey(query.month, "Oy") ?? currentMonthKey();
  const compareMonth =
    parseOptionalMonthKey(query.compareMonth, "Taqqoslash oyi") ?? prevMonth(month);

  if (compareMonth >= month) {
    throw new BadRequestError("Taqqoslash oyi tanlangan oydan oldin bo'lishi kerak");
  }

  const trendMonths = Math.min(
    Math.max(Number(query.trendMonths) || DEFAULT_TREND_MONTHS, 3),
    MAX_TREND_MONTHS,
  );

  const months = [];
  let cursor = month;
  for (let i = 0; i < trendMonths; i += 1) {
    months.unshift(cursor);
    cursor = prevMonth(cursor);
  }

  const [current, previous] = await Promise.all([
    monthFigures(month),
    monthFigures(compareMonth),
  ]);

  const [
    cashBalance,
    prevCashBalance,
    trend,
    expenseStructure,
    prevExpenseStructure,
    revenue,
    accounts,
    debt,
    accrual,
    pricing,
    expenseBudget,
    incomePlan,
    targets,
    customTargets,
    recent,
  ] = await Promise.all([
    balanceAt(current.to),
    balanceAt(previous.to),
    buildTrend(months),
    buildExpenseStructure(current, current.salary),
    // O'tgan oyning tuzilmasi FAQAT EBITDA taqqoslashi uchun kerak —
    // ekranga chiqmaydi, shuning uchun shu yerda ochilib qolmaydi
    buildExpenseStructure(previous, previous.salary),
    buildRevenueStructure(current, current.expense),
    buildAccounts(current.to, previous.to),
    buildDebt(month),
    buildAccrual(months, month),
    buildPricing(month),
    loadBudgetSummary(month),
    loadPlanSummary(month),
    loadTargetMap(month),
    loadCustomTargets(month),
    buildRecent(),
  ]);

  // ── EBITDA ───────────────────────────────────────────────────────────
  // Sof foyda + EBITDA'dan chiqarib tashlanadigan deb belgilangan
  // kategoriyalardagi xarajatlar (soliq, amortizatsiya). Hech nima
  // belgilanmagan bo'lsa EBITDA sof foydaga TENG — va bu to'g'ri javob,
  // "ma'lumot yo'q" emas.
  const ebitda = current.profit.plus(expenseStructure.ebitdaAddBack);
  const prevEbitda = previous.profit.plus(prevExpenseStructure.ebitdaAddBack);

  const kpiPrevious = {
    income: previous.income,
    expense: previous.expense,
    profit: previous.profit,
    margin: previous.margin,
    cashBalance: prevCashBalance,
  };

  /**
   * KPI kartasi — amalda, reja va o'tgan oy bilan taqqoslash bir joyda.
   *
   * ⚠️ FOIZLI ko'rsatkichning o'zgarishi PUNKTDA o'lchanadi: "margin 24.1%
   * dan 25.0% ga" — bu +0.9 punkt, +3.7% emas. Foizning foizini ko'rsatish
   * rahbarni chalg'itadi va dizayndagi qiymat ham aynan punkt farqi.
   */
  const kpi = (key, actual, { unit = "money" } = {}) => {
    const plan = targets.get(key)?.plan ?? null;
    const prev = kpiPrevious[key];
    const isPercent = unit === "percent";

    return {
      key,
      unit,
      value: isPercent ? Number(new Decimal(actual).toFixed(1)) : formatAmount(actual),
      plan: plan == null ? null : isPercent ? Number(plan.toFixed(1)) : formatAmount(plan),
      planRate: planRateOf(actual, plan),
      previous: isPercent ? Number(new Decimal(prev).toFixed(1)) : formatAmount(prev),
      change: isPercent
        ? Number(new Decimal(actual).minus(prev).toFixed(1))
        : changeOf(actual, prev),
      changeUnit: isPercent ? "point" : "percent",
    };
  };

  return {
    month,
    monthLabel: formatMonthKey(month),
    compareMonth,
    compareMonthLabel: formatMonthKey(compareMonth),

    // ── Yuqori qator: beshta karta ──────────────────────────────────
    kpi: {
      income: kpi("income", current.income),
      expense: kpi("expense", current.expense),
      profit: kpi("profit", current.profit),
      margin: kpi("margin", current.margin, { unit: "percent" }),
      cashBalance: kpi("cashBalance", cashBalance),
    },

    // ── P&L (foyda va zarar) hisoboti ───────────────────────────────
    pnl: [
      {
        key: "income",
        label: "Jami tushum",
        current: formatAmount(current.income),
        previous: formatAmount(previous.income),
        change: changeOf(current.income, previous.income),
        unit: "money",
        emphasis: true,
      },
      {
        key: "expense",
        label: "Jami xarajat",
        current: formatAmount(current.expense),
        previous: formatAmount(previous.expense),
        change: changeOf(current.expense, previous.expense),
        unit: "money",
        // Xarajatning o'sishi YOMON — frontend strelka rangini shunga qaraydi
        inverse: true,
      },
      {
        key: "salary",
        label: "shundan: xodimlar oyligi",
        current: formatAmount(current.salary),
        previous: formatAmount(previous.salary),
        change: changeOf(current.salary, previous.salary),
        unit: "money",
        inverse: true,
        muted: true,
      },
      {
        key: "otherExpense",
        label: "shundan: boshqa xarajatlar",
        current: formatAmount(current.otherExpense),
        previous: formatAmount(previous.otherExpense),
        change: changeOf(current.otherExpense, previous.otherExpense),
        unit: "money",
        inverse: true,
        muted: true,
      },
      {
        key: "profit",
        label: "Sof foyda",
        current: formatAmount(current.profit),
        previous: formatAmount(previous.profit),
        change: changeOf(current.profit, previous.profit),
        unit: "money",
        emphasis: true,
      },
      {
        key: "margin",
        label: "Sof foyda margin",
        current: Number(current.margin.toFixed(1)),
        previous: Number(previous.margin.toFixed(1)),
        // Marginning o'zi foiz — uning o'zgarishi PUNKTDA o'lchanadi.
        // Foizning foizi ("margin 24% dan 25% ga, ya'ni +4.2%") rahbarni
        // chalg'itardi.
        change: Number(current.margin.minus(previous.margin).toFixed(1)),
        changeUnit: "point",
        unit: "percent",
      },
      {
        key: "ebitda",
        label: "EBITDA",
        current: formatAmount(ebitda),
        previous: formatAmount(prevEbitda),
        change: changeOf(ebitda, prevEbitda),
        unit: "money",
        hint: "Sof foyda + EBITDA'dan chiqarilgan kategoriyalar (soliq, amortizatsiya)",
      },
    ],

    trend,
    expenseStructure: {
      total: expenseStructure.total,
      items: expenseStructure.items,
      top: expenseStructure.top,
    },
    revenueStructure: {
      total: revenue.total,
      items: revenue.items,
    },
    directions: {
      items: revenue.directions,
      totals: revenue.directionTotals,
      // Ekranda ochiq yozilishi kerak — aks holda ustun "haqiqiy xarajat"
      // deb o'qiladi
      note: "Xarajat yo'nalishlar bo'yicha alohida yuritilmaydi — tushum ulushiga mutanosib taqsimlangan",
    },
    accounts,
    debt,
    accrual,
    pricing,
    expenseBudget,
    incomePlan,
    recent,

    // ── Byudjet ijrosi ──────────────────────────────────────────────
    budget: [
      { key: "income", label: "Jami tushum", actual: current.income, unit: "money" },
      { key: "expense", label: "Jami xarajat", actual: current.expense, unit: "money", inverse: true },
      { key: "profit", label: "Sof foyda", actual: current.profit, unit: "money" },
      { key: "margin", label: "Sof foyda margin", actual: current.margin, unit: "percent" },
      { key: "cashBalance", label: "Pul qoldig'i", actual: cashBalance, unit: "money" },
    ].map((row) => {
      const plan = targets.get(row.key)?.plan ?? null;
      const diff = plan == null ? null : new Decimal(row.actual).minus(plan);

      return {
        key: row.key,
        label: row.label,
        unit: row.unit,
        inverse: Boolean(row.inverse),
        plan:
          plan == null
            ? null
            : row.unit === "percent"
              ? Number(plan.toFixed(1))
              : formatAmount(plan),
        actual:
          row.unit === "percent"
            ? Number(new Decimal(row.actual).toFixed(1))
            : formatAmount(row.actual),
        diff:
          diff == null
            ? null
            : row.unit === "percent"
              ? Number(diff.toFixed(1))
              : formatAmount(diff),
        rate: planRateOf(row.actual, plan),
      };
    }),

    // ── Rahbar qo'lda qo'shgan qatorlar ─────────────────────────────
    // Ularning AMALDAGI qiymati ham qo'lda kiritiladi: tizimda manbasi
    // yo'q. Kiritilmagan bo'lsa "—" turadi, nol EMAS — nol "reja
    // bajarilmadi" degan yolg'on xulosa berardi.
    customBudget: customTargets.map((row) => {
      const isPercent = row.kind === "percent";
      const diff = row.actual == null ? null : row.actual.minus(row.plan);

      return {
        key: row.key,
        label: row.label,
        unit: row.kind,
        inverse: false,
        isCustom: true,
        plan: isPercent ? Number(row.plan.toFixed(1)) : formatAmount(row.plan),
        actual:
          row.actual == null
            ? null
            : isPercent
              ? Number(row.actual.toFixed(1))
              : formatAmount(row.actual),
        diff:
          diff == null ? null : isPercent ? Number(diff.toFixed(1)) : formatAmount(diff),
        rate: row.actual == null ? null : planRateOf(row.actual, row.plan),
      };
    }),
  };
};

// ─────────────────────────────────────────────
// 2. Maktab KPI ko'rsatkichlari (CEO paneli)
// ─────────────────────────────────────────────

/**
 * Beshta ko'rsatkich — moliyaviy emas, lekin rahbar uchun pul bilan bir
 * ekranda turishi kerak: "foyda o'sdi, lekin davomat tushib ketdi" degan
 * bog'liqlik aynan shu yerda ko'rinadi.
 *
 * ⚠️ To'rttasi TIZIMDAN hisoblanadi. Beshinchisi (NPS) — ota-onalar
 * so'rovi, tizimda yuritilmaydi va `FinanceTarget.actualValue` dan
 * o'qiladi. Manba yo'q bo'lsa qiymat `null` bo'lib chiqadi va karta
 * "—" ko'rsatadi: nol emas, chunki "0% qoniqish" bilan "o'lchanmagan"
 * boshqa-boshqa narsa.
 *
 * @param {{month?: string|number}} query
 */
const getKpiScorecard = async (query = {}) => {
  const month = parseOptionalMonthKey(query.month, "Oy") ?? currentMonthKey();

  // ⚠️ Baho, davomat va o'qish davri sanalari UTC YARIM TUNIDA yotadi
  // (kun koordinatasi), shuning uchun ular uchun Toshkent ofseti bilan
  // emas, `monthStartDate/monthEndDate` bilan oraliq quriladi.
  const dayFrom = monthStartDate(month);
  const dayTo = new Date(monthEndDate(month).getTime() + 86400000 - 1);

  const [grades, attendance, invoices, admissions, targets] = await Promise.all([
    prisma.grade.aggregate({
      where: { date: { gte: dayFrom, lte: dayTo } },
      _avg: { grade: true },
      _count: { _all: true },
    }),
    prisma.studentAttendance.groupBy({
      by: ["status"],
      where: { date: { gte: dayFrom, lte: dayTo } },
      _count: { _all: true },
    }),
    prisma.monthlyInvoice.aggregate({
      where: { month, status: { not: "cancelled" } },
      _sum: { amount: true, paidAmount: true },
    }),
    prisma.studentEnrollment.count({
      where: { startDate: { gte: dayFrom, lte: dayTo } },
    }),
    loadTargetMap(month),
  ]);

  // Akademik sifat — 5 ballik shkalaning foizga o'girilgani
  const averageGrade = grades._avg.grade;
  const academicQuality =
    grades._count._all > 0 && averageGrade != null
      ? Number(((averageGrade / 5) * 100).toFixed(1))
      : null;

  // Davomat — keldi va kechikdi; sababli faqat maxrajda
  // (`education.md` §6 dagi qoida bilan bir xil)
  const attendanceTotal = attendance.reduce((acc, row) => acc + row._count._all, 0);
  const attendancePresent = attendance
    .filter((row) => row.status === "present" || row.status === "late")
    .reduce((acc, row) => acc + row._count._all, 0);
  const attendanceRate =
    attendanceTotal > 0
      ? Number(((attendancePresent / attendanceTotal) * 100).toFixed(1))
      : null;

  const invoiced = new Decimal(invoices._sum.amount ?? 0);
  const collected = new Decimal(invoices._sum.paidAmount ?? 0);
  const paymentDiscipline = invoiced.isZero() ? null : rateOf(collected, invoiced);

  const npsTarget = targets.get("nps");
  const nps = npsTarget?.actual != null ? Number(npsTarget.actual.toFixed(1)) : null;

  const item = (key, label, value, unit, sub) => {
    const plan = targets.get(key)?.plan ?? null;

    return {
      key,
      label,
      unit,
      value,
      sub,
      plan: plan == null ? null : Number(plan.toFixed(unit === "count" ? 0 : 1)),
      // Rejaga yetdimi — karta strelkasi shunga qaraydi. Qiymat yoki reja
      // yo'q bo'lsa strelka ham chizilmaydi.
      reached: plan == null || value == null ? null : value >= Number(plan),
    };
  };

  return {
    month,
    monthLabel: formatMonthKey(month),
    items: [
      item(
        "academicQuality",
        "Akademik sifat",
        academicQuality,
        "percent",
        `${grades._count._all} ta baho`,
      ),
      item(
        "paymentDiscipline",
        "To'lov intizomi",
        paymentDiscipline,
        "percent",
        "Shu oy majburiyatidan",
      ),
      item(
        "attendance",
        "Davomat",
        attendanceRate,
        "percent",
        `${attendanceTotal} ta belgi`,
      ),
      item(
        "nps",
        "Ota-onalar qoniqishi (NPS)",
        nps,
        "percent",
        nps == null ? "So'rov kiritilmagan" : "So'rov natijasi",
      ),
      item("newAdmissions", "Yangi qabul", admissions, "count", "Shu oyda qabul qilindi"),
    ],
  };
};

module.exports = {
  getDashboard,
  getKpiScorecard,
  // Sinov uchun ochiladi
  monthInstantRange,
  balanceAt,
};
