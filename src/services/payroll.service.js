/**
 * OYLIK MAJBURIYATLARI — `MonthlyInvoice` ning chiqim tomonidagi ko'zgusi.
 *
 * Qoida (`StaffSalary`) → har oy MAJBURIYAT (`PayrollEntry`) → to'lov uni
 * yopadi. Shu tufayli "kimga qancha qarzdormiz" degan savolga javob bor.
 *
 * ⚠️ QAYTARILMASLIK: `amount` ni o'zgartiradigan funksiya YO'Q. Qoida keyin
 * to'g'rilansa, tuzatish KEYINGI oydan amal qiladi. Yagona olib tashlash
 * yo'li — `cancelled` holati, sababi bilan; to'lov tushgan majburiyat esa
 * umuman bekor qilinmaydi.
 *
 * ⚠️ BEKOR QILINGAN MAJBURIYAT SHAKLLANTIRISHNI TO'SMAYDI (`finance.md` §10).
 * U bo'sh o'rin: shakllantirish uni O'SHA QATORNING O'ZIDA qayta hisoblab
 * tiklaydi (`restored`). Aks holda xato muhrlangan oylikni tuzatishning
 * hujjatdagi yagona yo'li — "bekor qilish → qayta shakllantirish" — ishlamasdi:
 * bir marta bekor qilingan oy o'sha xodimga hech qachon qaytmasdi.
 *
 * ⚠️ Kun proratsiyasi YO'Q — "fiksa" qat'iy summa, oy aniqligida.
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const logger = require("../utils/logger");
const {
  currentMonthKey,
  currentDayOfMonth,
  parseMonthKey,
  parseOptionalMonthKey,
  formatMonthKey,
} = require("../helpers/month.helpers");
const { Decimal, formatAmount } = require("../helpers/money.helpers");
const {
  resolveSalariesForMonth,
  TYPE_LABELS,
  STAFF_SELECT,
} = require("./staffSalary.service");
const payrollEngine = require("./payrollEngine.service");
const { getTeacherHours } = require("./lessonHours.service");
const { getFinanceSettings } = require("./settings.service");
const { resolveTutorIdsForMonth } = require("./tutorGroup.service");

// Payroll uchun user maydonlari — biriktirmalar bilan
const PAYROLL_USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  role: true,
  isArchived: true,
  positionId: true,
  salaryCategoryId: true,
};

// TIZIM AKTYORI — cron/avtomatik shakllantirish uchun. `createdBy` NOT NULL
// (eski holat saqlangan), cron esa odam emas — shu sentinel yoziladi.
const SYSTEM_ACTOR_ID = "000000000000000000000000";

const STATUS_LABELS = {
  unpaid: "To'lanmagan",
  partial: "Qisman to'langan",
  paid: "To'langan",
  cancelled: "Bekor qilingan",
};

const serializeEntry = (row, { staff } = {}) => {
  const debt = new Decimal(row.amount).minus(row.paidAmount);

  return {
    ...row,
    amount: formatAmount(row.amount),
    fixedAmount: formatAmount(row.fixedAmount ?? 0),
    allowanceAmount: formatAmount(row.allowanceAmount ?? 0),
    allowanceBreakdown: Array.isArray(row.allowanceBreakdown) ? row.allowanceBreakdown : [],
    // To'xtatilgan qism va ushlab qolish — `amount` dan ALLAQACHON ayirilgan,
    // faqat tushuntirish
    suspendedAmount: formatAmount(row.suspendedAmount ?? 0),
    suspensionBreakdown: Array.isArray(row.suspensionBreakdown) ? row.suspensionBreakdown : [],
    deductionAmount: formatAmount(row.deductionAmount ?? 0),
    deductionBreakdown: Array.isArray(row.deductionBreakdown) ? row.deductionBreakdown : [],
    kpiAmount: formatAmount(row.kpiAmount ?? 0),
    perHourRate: formatAmount(row.perHourRate ?? 0),
    lessonHours: Number(row.lessonHours ?? 0),
    categoryName: row.categoryName ?? "",
    positionName: row.positionName ?? "",
    departmentName: row.departmentName ?? "",
    salaryTypeLabel: TYPE_LABELS[row.salaryType] ?? row.salaryType,
    paidAmount: formatAmount(row.paidAmount),
    // Ortiqcha to'lov RAD ETILADI, shuning uchun manfiy bo'lmasligi kerak —
    // lekin himoya qavati qoladi
    debt: formatAmount(debt.isNegative() ? new Decimal(0) : debt),
    monthLabel: formatMonthKey(row.month),
    statusLabel: STATUS_LABELS[row.status] ?? row.status,
    // Xodim arxivlangan/o'chirilgan bo'lishi mumkin — snapshot qutqaradi
    staff: staff ?? null,
    staffName: staff
      ? `${staff.firstName} ${staff.lastName ?? ""}`.trim()
      : `${row.staffSnapshot?.firstName ?? ""} ${row.staffSnapshot?.lastName ?? ""}`.trim() ||
        "Noma'lum",
    roleLabel: staff?.role ?? row.staffSnapshot?.role ?? null,
  };
};

// ─────────────────────────────────────────────
// Shakllantirish
// ─────────────────────────────────────────────

const emptySummary = (month, reason) => ({
  month,
  monthLabel: formatMonthKey(month),
  reason,
  dryRun: false,
  eligible: 0,
  created: 0,
  // Bekordan tiklangani — yangi qator emas, lekin registrda qayta paydo bo'ladi
  restored: 0,
  // Mavjud qatorda tyutor/ushlab qolish qismi yangilangani va to'lov
  // tufayli yangilab bo'lmagani
  resynced: 0,
  resyncLocked: 0,
  totalAmount: "0.00",
  fixedTotal: "0.00",
  kpiTotal: "0.00",
  deductionTotal: "0.00",
  // zeroAmount — faqat KPI oladigan, lekin shu oy darsi bo'lmagan xodim
  // monthOpen  — soatbay qismi bor, oy hali yopilmagan (pastdagi izoh)
  skipped: { alreadyExists: 0, noSalary: 0, archived: 0, zeroAmount: 0, monthOpen: 0 },
  durationMs: 0,
});

/**
 * Bir oy uchun oylik majburiyatlarini shakllantiradi.
 *
 * IDEMPOTENT: `@@unique([staffId, month])` va oldindan tekshiruv tufayli
 * ikki marta chaqirish ikkinchi qator yaratmaydi.
 *
 * ⚠️ Bekor qilingan majburiyat (`paidAmount = 0`) TIKLANADI — fayl
 * sarlavhasiga qarang. Amaldagisi (unpaid/partial/paid) tegilmaydi.
 *
 * @param {number|string} monthInput
 * @param {object} options - { dryRun, staffIds, actorId }
 */
const generateForMonth = async (monthInput, options = {}) => {
  const startedAt = Date.now();
  const month = parseMonthKey(monthInput, "Oy");
  const { dryRun = false, staffIds, actorId = null } = options;

  if (month > currentMonthKey()) {
    throw new BadRequestError("Kelajakdagi oy uchun oylik shakllantirilmaydi");
  }

  // Qattiq pol: xodimlar shu oydan "ish boshlagan" — undan oldingi oylarga
  // oylik majburiyati (xarajat) yozilmaydi. `firstInvoiceMonth` ning ko'zgusi.
  const settings = await getFinanceSettings();
  if (settings.firstPayrollMonth != null && month < settings.firstPayrollMonth) {
    const skipped = emptySummary(month, "Oylik boshlanish oyidan oldingi oy");
    skipped.durationMs = Date.now() - startedAt;
    return skipped;
  }

  const summary = emptySummary(month, null);

  // 0 ── "Hammaga" ushlab qolishlar keyin oyligi belgilanganlarga ham
  // yoyiladi — MUHRDAN OLDIN. Biriktirish nuqtalari buni o'zi qiladi, bu
  // yer (kunlik cron) — ulardan birortasi o'tkazib yuborgan holat uchun.
  if (!dryRun) {
    await require("./payrollDeduction.service").extendAllScopeDeductionsSafe(staffIds ?? null);
  }

  // 1 ── Oylik oladigan xodimlar: lavozim (staff) YOKI toifa (teacher) YOKI
  // eski StaffSalary qoidasi YOKI tyutor guruhi bor. `isArchived` FILTRLANADI
  // (ketganga yozilmaydi).
  const [salaryRules, tutorIds] = await Promise.all([
    resolveSalariesForMonth(month), // eski qatlam
    resolveTutorIdsForMonth(month),
  ]);
  const ruleIds = [...salaryRules.keys()];

  const where = {
    isArchived: false,
    role: { not: ROLES.STUDENT },
    OR: [
      { positionId: { not: null } },
      { salaryCategoryId: { not: null } },
      ...(ruleIds.length ? [{ id: { in: ruleIds } }] : []),
      ...(tutorIds.length ? [{ id: { in: tutorIds } }] : []),
    ],
  };
  if (staffIds?.length) where.id = { in: staffIds };

  const staff = await prisma.user.findMany({ where, select: PAYROLL_USER_SELECT });
  summary.eligible = staff.length;
  if (staff.length === 0) {
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  // 2 ── Allaqachon shakllantirilganlari
  //
  // ⚠️ IKKI XIL "mavjud" bor va ular BOSHQACHA ishlanadi:
  //   amaldagi (unpaid/partial/paid) → TEGILMAYDI, summa muhrlangan;
  //   bekor qilingani                → TIKLANADI (`restorable`).
  // `paidAmount` himoya qavati: `cancelEntry` to'lov tushganini bekor
  // qilmaydi, lekin pul tushgan qatorning summasini qayta yozish taqsimotni
  // yolg'onga aylantirardi.
  const existing = await prisma.payrollEntry.findMany({
    where: { month, staffId: { in: staff.map((s) => s.id) } },
    select: { id: true, staffId: true, status: true, paidAmount: true },
  });
  const restorable = new Map();
  const existingIds = new Set();
  for (const row of existing) {
    if (row.status === "cancelled" && !new Decimal(row.paidAmount).greaterThan(0)) {
      restorable.set(row.staffId, row);
    } else {
      existingIds.add(row.staffId);
    }
  }

  // 3 ── Kontekst (lavozim/toifa/soat/ustama) — bir marta
  const ctx = await payrollEngine.loadContext(month, staff, { salaryRules });

  // 4 ── Qatorlarni yig'ish (engine bilan hisoblab, MUHRLAB)
  //
  // Ikki savat: YANGI qatorlar (`createMany`) va TIKLANADIGANLARI (mavjud
  // qatorni JOYIDA yangilash). Summa va snapshot ikkalasiga AYNI shaklda.
  const rows = [];
  const restores = [];
  let total = new Decimal(0);
  let fixedTotal = new Decimal(0);
  let kpiTotal = new Decimal(0);
  let deductionTotal = new Decimal(0);

  for (const person of staff) {
    if (existingIds.has(person.id)) {
      summary.skipped.alreadyExists += 1;
      continue;
    }

    const c = payrollEngine.computeForStaff(person, month, ctx);
    if (!c) {
      summary.skipped.noSalary += 1;
      continue;
    }
    // ⚠️ SOATBAY QISM OY YOPILGANDAN KEYIN MUHRLANADI (`finance.md` §10).
    // Soat endi FAKTDAN (baho + davomat) hisoblanadi, fakt esa faqat o'tgan
    // kunlar uchun bor: oy o'rtasida muhrlansa, hali o'tilmagan darslar ham
    // pulga aylanib qolardi. Oy yopilgach cron (`catchUpMonths`) yoki
    // qo'lda shakllantirish uni yozadi. Faqat fiksa xodimga tegilmaydi.
    if (month >= currentMonthKey() && c.perHourRate.greaterThan(0)) {
      summary.skipped.monthOpen += 1;
      continue;
    }
    // ⚠️ YALPI tekshiriladi, sof emas: oylik bor-u ushlab qolish yoki
    // to'xtatish uni to'liq yopgan xodimga ham qator yoziladi (0 so'm) — aks
    // holda "shu oy oyligi to'xtatildi / ushlab qolindi" degan fakt registrdan
    // yo'qolardi, to'xtatish bekor qilinsa esa qator shu yerda tiklanadi.
    if (c.grossAmount.lessThanOrEqualTo(0)) {
      summary.skipped.zeroAmount += 1;
      continue;
    }

    total = total.plus(c.amount);
    fixedTotal = fixedTotal.plus(c.fixedAmount).plus(c.allowanceAmount);
    kpiTotal = kpiTotal.plus(c.kpiAmount);
    deductionTotal = deductionTotal.plus(c.deductionAmount);

    const facts = {
      amount: c.amount,
      fixedAmount: c.fixedAmount,
      allowanceAmount: c.allowanceAmount,
      allowanceBreakdown: c.allowanceBreakdown,
      suspendedAmount: c.suspendedAmount,
      suspensionBreakdown: c.suspensionBreakdown,
      deductionAmount: c.deductionAmount,
      deductionBreakdown: c.deductionBreakdown,
      // To'liq to'xtatilgan / ushlab qolingan oylik — to'lanadigan narsa yo'q
      status: c.amount.lessThanOrEqualTo(0) ? "paid" : "unpaid",
      kpiAmount: c.kpiAmount,
      lessonHours: c.lessonHours,
      perHourRate: c.perHourRate,
      categoryName: c.categoryName,
      positionName: c.positionName,
      departmentName: c.departmentName,
      salaryType: c.salaryType,
      staffSnapshot: {
        firstName: person.firstName,
        lastName: person.lastName ?? "",
        username: person.username,
        role: person.role,
      },
    };

    const cancelled = restorable.get(person.id);
    if (cancelled) {
      // ⚠️ TIKLASH — bekor qilish izi TOZALANADI: qator endi amaldagi
      // majburiyat. `createdBy` tegilmaydi — qatorni birinchi kim
      // shakllantirgani haqidagi fakt.
      restores.push({
        id: cancelled.id,
        data: { ...facts, paidAt: null, cancelReason: "", cancelledAt: null, cancelledBy: null },
      });
    } else {
      rows.push({
        staffId: person.id,
        month,
        ...facts,
        // Cron (actor yo'q) — tizim sentineli: NOT NULL ustun buzilmaydi
        createdBy: actorId ?? SYSTEM_ACTOR_ID,
      });
    }
  }

  summary.created = rows.length;
  summary.restored = restores.length;
  summary.totalAmount = formatAmount(total);
  summary.fixedTotal = formatAmount(fixedTotal);
  summary.kpiTotal = formatAmount(kpiTotal);
  summary.deductionTotal = formatAmount(deductionTotal);
  summary.dryRun = dryRun;

  if (!dryRun && rows.length > 0) {
    // Sanoq natijadan: parallel ishga tushgan ikkinchi jarayon yozolmagan
    // qatorni "yaratdim" deb aytmasin
    const result = await prisma.payrollEntry.createMany({ data: rows, skipDuplicates: true });
    summary.created = result.count;
    summary.skipped.alreadyExists += rows.length - result.count;
  }

  if (!dryRun && restores.length > 0) {
    // ⚠️ COMPARE-AND-SWAP (`finance.md` §8): cron va qo'lda bosilgan tugma
    // bir vaqtda ishlasa, ikkinchisi hech narsa yozmaydi (`count` 0).
    const results = await prisma.$transaction(
      restores.map((row) =>
        prisma.payrollEntry.updateMany({
          where: { id: row.id, status: "cancelled", paidAmount: 0 },
          data: row.data,
        }),
      ),
    );
    const restored = results.reduce((sum, r) => sum + r.count, 0);
    summary.restored = restored;
    summary.skipped.alreadyExists += restores.length - restored;
  }

  // 5 ── MAVJUD majburiyatlar: tyutor qatorlari va ushlab qolish amaldagi
  // holatga moslanadi (`resyncSealedEntries`). Guruh biriktirish nuqtasi buni
  // o'zi qiladi — bu yer undan oldin muhrlangan yoki o'shanda yiqilgan qatorlar
  // uchun: tugma bosilsa tyutor puli moliyaga albatta tushadi.
  if (!dryRun && existingIds.size > 0) {
    const resync = await require("./payrollDeduction.service").resyncSealedEntries(
      [...existingIds],
      [month],
    );
    summary.resynced = resync.updated;
    summary.resyncLocked = resync.locked.length;
  }

  if (!dryRun && summary.created + summary.restored > 0) {
    logger.info(
      `[payroll] ${formatMonthKey(month)}: ${summary.created} ta oylik majburiyati` +
        (summary.restored > 0 ? `, ${summary.restored} tasi bekordan qaytarildi` : "") +
        `, jami ${formatAmount(total)}`,
    );
  }

  summary.durationMs = Date.now() - startedAt;
  return summary;
};

// ─────────────────────────────────────────────
// Registr
// ─────────────────────────────────────────────

/** Oylik majburiyatlari ro'yxati (sahifalangan). */
const getEntries = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const where = {};

  if (query.month) where.month = parseMonthKey(query.month, "Oy");
  else {
    const from = parseOptionalMonthKey(query.fromMonth, "Boshlanish oyi");
    const to = parseOptionalMonthKey(query.toMonth, "Tugash oyi");
    if (from != null || to != null) {
      where.month = {
        ...(from != null ? { gte: from } : {}),
        ...(to != null ? { lte: to } : {}),
      };
    }
  }

  if (query.staffId) where.staffId = query.staffId;

  // Xodim bo'yicha qidiruv: har bir so'z ism, familiya yoki login'dan biriga
  // mos kelishi kerak — "Robiya Nuriddinova" ham topiladi. Arxivlangan xodim
  // ham qidiriladi: uning majburiyati registrda qoladi.
  const tokens = String(query.search ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (tokens.length > 0) {
    const matched = await prisma.user.findMany({
      where: {
        AND: tokens.map((token) => ({
          OR: [
            { firstName: { contains: token, mode: "insensitive" } },
            { lastName: { contains: token, mode: "insensitive" } },
            { username: { contains: token, mode: "insensitive" } },
          ],
        })),
      },
      select: { id: true },
    });
    where.AND = [{ staffId: { in: matched.map((u) => u.id) } }];
  }

  if (query.status) {
    if (!STATUS_LABELS[query.status]) throw new BadRequestError("Holat noto'g'ri");
    where.status = query.status;
  } else if (query.debtOnly === "true") {
    where.status = { in: ["unpaid", "partial"] };
  } else if (query.includeCancelled !== "true") {
    where.status = { not: "cancelled" };
  }

  const [rows, total, agg] = await Promise.all([
    prisma.payrollEntry.findMany({
      where,
      orderBy: [{ month: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    prisma.payrollEntry.count({ where }),
    prisma.payrollEntry.aggregate({
      where: { ...where, status: { not: "cancelled" } },
      _sum: { amount: true, paidAmount: true },
    }),
  ]);

  const staff = rows.length
    ? await prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.staffId))] } },
        select: STAFF_SELECT,
      })
    : [];
  const staffMap = new Map(staff.map((s) => [s.id, s]));

  const accrued = new Decimal(agg._sum.amount ?? 0);
  const paid = new Decimal(agg._sum.paidAmount ?? 0);
  const debt = accrued.minus(paid);

  return {
    ...formatPaginationResponse(
      rows.map((row) => serializeEntry(row, { staff: staffMap.get(row.staffId) })),
      total,
      page,
      limit,
    ),
    totals: {
      accrued: formatAmount(accrued),
      paid: formatAmount(paid),
      debt: formatAmount(debt.isNegative() ? new Decimal(0) : debt),
    },
  };
};

/** Bitta xodimning oylik tarixi va qarzi. */
const getStaffEntries = async (staffId) => {
  const [staff, rows, agg] = await Promise.all([
    prisma.user.findUnique({ where: { id: staffId }, select: STAFF_SELECT }),
    prisma.payrollEntry.findMany({
      where: { staffId, status: { not: "cancelled" } },
      orderBy: { month: "desc" },
      include: {
        allocations: {
          where: { isVoided: false },
          orderBy: { appliedAt: "desc" },
          include: { payment: { select: { paidAt: true, accountId: true } } },
        },
      },
    }),
    prisma.payrollEntry.aggregate({
      where: { staffId, status: { not: "cancelled" } },
      _sum: { amount: true, paidAmount: true },
    }),
  ]);

  if (!staff) throw new NotFoundError("Xodim topilmadi");

  const accrued = new Decimal(agg._sum.amount ?? 0);
  const paid = new Decimal(agg._sum.paidAmount ?? 0);
  const debt = accrued.minus(paid);

  return {
    staff,
    totals: {
      accrued: formatAmount(accrued),
      paid: formatAmount(paid),
      debt: formatAmount(debt.isNegative() ? new Decimal(0) : debt),
      unpaidCount: rows.filter((r) => r.status !== "paid").length,
    },
    items: rows.map(({ allocations, ...row }) => ({
      ...serializeEntry(row, { staff }),
      payments: allocations.map((a) => ({
        id: a.id,
        amount: formatAmount(a.amount),
        appliedAt: a.appliedAt,
        paidAt: a.payment?.paidAt ?? null,
      })),
    })),
  };
};

// ─────────────────────────────────────────────
// Bekor qilish
// ─────────────────────────────────────────────

/**
 * Majburiyatni bekor qilish — summani o'zgartirishning YAGONA yo'li emas,
 * balki uni OLIB TASHLASH yo'li. Xato summa bo'lsa: bekor qilinadi, qoida
 * to'g'rilanadi, qayta shakllantiriladi.
 *
 * ⚠️ To'lov tushgan majburiyat bekor qilinmaydi — avval to'lov bekor
 * qilinishi kerak. Aks holda to'langan pul "havoda" qolardi.
 */
const cancelEntry = async (id, reason, userId) => {
  const entry = await prisma.payrollEntry.findUnique({ where: { id } });
  if (!entry) throw new NotFoundError("Oylik majburiyati topilmadi");

  if (entry.status === "cancelled") {
    throw new BadRequestError("Majburiyat allaqachon bekor qilingan");
  }

  if (new Decimal(entry.paidAmount).greaterThan(0)) {
    throw new BadRequestError(
      "Bu majburiyatga to'lov tushgan — avval to'lovni bekor qiling",
    );
  }

  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError("Bekor qilish sababi majburiy");

  logger.warn(
    `[payroll] Majburiyat bekor qilindi: entry=${id} ` +
      `staff=${entry.staffId} oy=${entry.month} summa=${formatAmount(entry.amount)} ` +
      `actor=${userId} sabab="${trimmed}"`,
  );

  const updated = await prisma.payrollEntry.update({
    where: { id },
    data: {
      status: "cancelled",
      cancelReason: trimmed,
      cancelledAt: new Date(),
      cancelledBy: userId,
    },
  });

  return serializeEntry(updated);
};

/**
 * BELGILANGAN (assigned) oylik — qoidalardan kelib chiqib bir oy uchun BARCHA
 * biriktirilgan xodimga hisoblanadigan JAMI summa (shakllantirilgan-shakllantiril-
 * maganidan qat'i nazar). Formula YAGONA — `payrollEngine` (shakllantirish ham
 * shuni chaqiradi), shuning uchun dashboard'dagi "belgilangan" raqami generatsiya
 * bilan bir xil bo'ladi. Moliya dashboardi P&L uchun ishlatadi.
 *
 * @param {number} month - YYYYMM
 * @returns {Promise<{amount: Decimal}>}
 */
const computeAssignedPayroll = async (month) => {
  const [salaryRules, tutorIds] = await Promise.all([
    resolveSalariesForMonth(month),
    resolveTutorIdsForMonth(month),
  ]);
  const ruleIds = [...salaryRules.keys()];

  const staff = await prisma.user.findMany({
    where: {
      isArchived: false,
      role: { not: ROLES.STUDENT },
      OR: [
        { positionId: { not: null } },
        { salaryCategoryId: { not: null } },
        ...(ruleIds.length ? [{ id: { in: ruleIds } }] : []),
        ...(tutorIds.length ? [{ id: { in: tutorIds } }] : []),
      ],
    },
    select: PAYROLL_USER_SELECT,
  });

  if (staff.length === 0) return { amount: new Decimal(0) };

  const ctx = await payrollEngine.loadContext(month, staff, { salaryRules });
  let amount = new Decimal(0);
  for (const person of staff) {
    const c = payrollEngine.computeForStaff(person, month, ctx);
    if (c && c.amount.greaterThan(0)) amount = amount.plus(c.amount);
  }
  return { amount };
};

/**
 * XODIMNING O'Z OYLIK STATISTIKASI (teacher panel dashboardi).
 *
 * Uch qismdan iborat:
 *   1. JORIY OY (jonli): oylik summasi = fiksa/soatbay + KPI + ustama; toifa,
 *      stavka, dars soati (reja / o'tgan / qolgan). Muhrlanmagan bo'lsa ham
 *      ko'rinadi — o'qituvchi kutgan summasini oldindan biladi.
 *   2. JORIY OY MAJBURIYATI (agar shakllangan bo'lsa): to'langan / qarz.
 *   3. UMUMIY: butun tarix bo'yicha hisoblangan / olingan / qarz.
 *
 * @param {string} userId - HAR DOIM req.user.id (o'zganing statini olib bo'lmaydi)
 */
const getMySalaryStats = async (userId) => {
  const month = currentMonthKey();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: PAYROLL_USER_SELECT,
  });
  if (!user) throw new NotFoundError("Xodim topilmadi");

  // ── 1. Joriy oy jonli hisob ──────────────
  const salaryRules = await resolveSalariesForMonth(month);
  const ctx = await payrollEngine.loadContext(month, [user], { salaryRules });
  const computed = payrollEngine.computeForStaff(user, month, ctx);

  // ── Dars soati (reja / o'tgan / qolgan) — bugungacha kesim bilan ──
  const day = currentDayOfMonth();
  const hoursInfo = user.salaryCategoryId || computed?.kpiAmount
    ? await getTeacherHours(userId, month, { asOfDayOfMonth: day })
    : null;

  // ── 2. Joriy oy majburiyati (shakllangan bo'lsa) ──
  const currentEntry = await prisma.payrollEntry.findFirst({
    where: { staffId: userId, month, status: { not: "cancelled" } },
    select: {
      amount: true,
      paidAmount: true,
      status: true,
      fixedAmount: true,
      kpiAmount: true,
      allowanceAmount: true,
      allowanceBreakdown: true,
      suspendedAmount: true,
      suspensionBreakdown: true,
      deductionAmount: true,
      deductionBreakdown: true,
    },
  });

  // ── Ushlab qolish — muhrlangan bo'lsa muhrdan, aks holda jonli ──
  // Xodim "nega kam" degan savolga shu yerda javob oladi: sabab va izoh bilan.
  const deductionRows = currentEntry
    ? Array.isArray(currentEntry.deductionBreakdown)
      ? currentEntry.deductionBreakdown
      : []
    : computed?.deductionBreakdown ?? [];
  const deductionRules = deductionRows.length
    ? await prisma.payrollDeduction.findMany({
        where: { id: { in: deductionRows.map((row) => row.id) } },
        select: { id: true, reason: true, note: true },
      })
    : [];
  const ruleMap = new Map(deductionRules.map((rule) => [rule.id, rule]));
  const currentDeduction = currentEntry
    ? new Decimal(currentEntry.deductionAmount ?? 0)
    : new Decimal(computed?.deductionAmount ?? 0);

  // ── 3. Umumiy tarix ──────────────────────
  const totalsAgg = await prisma.payrollEntry.aggregate({
    where: { staffId: userId, status: { not: "cancelled" } },
    _sum: { amount: true, paidAmount: true },
  });
  const totalAccrued = new Decimal(totalsAgg._sum.amount ?? 0);
  const totalPaid = new Decimal(totalsAgg._sum.paidAmount ?? 0);
  const totalDebt = totalAccrued.minus(totalPaid);

  // Joriy oy uchun ko'rsatiladigan summa: muhrlangan bo'lsa u, aks holda jonli
  const currentAmount = currentEntry
    ? new Decimal(currentEntry.amount)
    : computed
      ? computed.amount
      : new Decimal(0);
  const currentPaid = currentEntry ? new Decimal(currentEntry.paidAmount) : new Decimal(0);
  const currentDebt = currentAmount.minus(currentPaid);

  return {
    month,
    monthLabel: formatMonthKey(month),
    hasSalary: Boolean(computed) || Boolean(currentEntry),
    isSealed: Boolean(currentEntry), // majburiyat shakllanganmi

    current: {
      // Oylik tarkibi
      amount: formatAmount(currentAmount),
      // Tarkib `amount` bilan BIR MANBADAN: muhrlangan bo'lsa muhrdan. Aks
      // holda muhrdan keyin qo'shilgan ustama (masalan tyutor guruhi) jonli
      // tarkibda ko'rinib, muhrlangan summaga qo'shilmagan bo'lib chiqardi.
      fixedAmount: formatAmount(currentEntry ? currentEntry.fixedAmount : computed?.fixedAmount ?? 0),
      kpiAmount: formatAmount(currentEntry ? currentEntry.kpiAmount : computed?.kpiAmount ?? 0),
      allowanceAmount: formatAmount(
        currentEntry ? currentEntry.allowanceAmount : computed?.allowanceAmount ?? 0,
      ),
      // Ustama qatorlari (tyutor guruhlari ham, `type: "tutor"`) — muhrlangan
      // bo'lsa muhrdan, aks holda jonli: xodim qo'shimcha oylik qayerdan
      // kelganini ko'radi
      allowanceBreakdown: currentEntry
        ? Array.isArray(currentEntry.allowanceBreakdown)
          ? currentEntry.allowanceBreakdown
          : []
        : computed?.allowanceBreakdown ?? [],
      // To'xtatilgan qism — muhrlangan bo'lsa muhrdan, aks holda jonli
      suspendedAmount: formatAmount(
        currentEntry ? currentEntry.suspendedAmount : computed?.suspendedAmount ?? 0,
      ),
      suspensions: currentEntry
        ? Array.isArray(currentEntry.suspensionBreakdown)
          ? currentEntry.suspensionBreakdown
          : []
        : computed?.suspensionBreakdown ?? [],
      // Ushlab qolingan (summa `amount` dan allaqachon ayirilgan)
      deductionAmount: formatAmount(currentDeduction),
      deductions: deductionRows.map((row) => ({
        id: row.id,
        reason: ruleMap.get(row.id)?.reason ?? row.reason ?? "",
        note: ruleMap.get(row.id)?.note ?? "",
        type: row.type,
        value: row.value,
        amount: formatAmount(row.amount ?? 0),
      })),
      salaryType: computed?.salaryType ?? null,
      // Toifa va stavka
      categoryName: computed?.categoryName || null,
      positionName: computed?.positionName || null,
      perHourRate: formatAmount(computed?.perHourRate ?? 0),
      // To'lov holati (shu oy)
      paid: formatAmount(currentPaid),
      debt: formatAmount(currentDebt.isNegative() ? new Decimal(0) : currentDebt),
      status: currentEntry?.status ?? "unpaid",
    },

    // Dars soati (o'qituvchi bo'lsa)
    hours: hoursInfo
      ? {
          planned: hoursInfo.hours, // shu oy o'tishi kerak bo'lgan (jadval bo'yicha)
          taught: hoursInfo.taughtHours, // bugungacha o'tilgani
          remaining: hoursInfo.remainingHours, // qolgan
          weekly: hoursInfo.weeklyHours, // haftalik yuklama
        }
      : null,

    // Umumiy (butun tarix)
    totals: {
      accrued: formatAmount(totalAccrued),
      paid: formatAmount(totalPaid),
      debt: formatAmount(totalDebt.isNegative() ? new Decimal(0) : totalDebt),
    },
  };
};

module.exports = {
  STATUS_LABELS,
  serializeEntry,
  generateForMonth,
  getEntries,
  getStaffEntries,
  cancelEntry,
  computeAssignedPayroll,
  getMySalaryStats,
};
