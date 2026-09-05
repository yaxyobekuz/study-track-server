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
  parseMonthKey,
  parseOptionalMonthKey,
  formatMonthKey,
} = require("../helpers/month.helpers");
const { Decimal, formatAmount } = require("../helpers/money.helpers");
const { resolveSalariesForMonth, STAFF_SELECT } = require("./staffSalary.service");

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
  totalAmount: "0.00",
  skipped: { alreadyExists: 0, cancelled: 0, noSalary: 0, archived: 0 },
  durationMs: 0,
});

/**
 * Bir oy uchun oylik majburiyatlarini shakllantiradi.
 *
 * IDEMPOTENT: `@@unique([staffId, month])` va oldindan tekshiruv tufayli
 * ikki marta chaqirish ikkinchi qator yaratmaydi.
 *
 * ⚠️ Bekor qilingan majburiyat ham "mavjud" hisoblanadi — u QAROR, bo'shliq
 * emas. Aks holda cron ertasiga uni qaytadan yozib qo'yardi.
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

  const summary = emptySummary(month, null);

  // 1 ── Oylik qoidasi bor xodimlar (bitta so'rov)
  const salaries = await resolveSalariesForMonth(month);
  if (salaries.size === 0) {
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const ids = staffIds?.length
    ? [...salaries.keys()].filter((id) => staffIds.includes(id))
    : [...salaries.keys()];

  // 2 ── Xodimlar. `isArchived` FILTRLANADI: ketgan odamga oylik yozilmaydi.
  // (O'quvchi tomonida `isActive` ataylab filtrlanmaydi — u yerda qarz
  // bekor bo'lmaydi. Bu yerda esa aksincha: biz to'laymiz.)
  const staff = await prisma.user.findMany({
    where: { id: { in: ids }, isArchived: false, role: { not: ROLES.STUDENT } },
    select: STAFF_SELECT,
  });

  summary.skipped.archived = ids.length - staff.length;
  summary.eligible = staff.length;

  if (staff.length === 0) {
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  // 3 ── Allaqachon shakllantirilganlari
  //
  // ⚠️ BEKOR QILINGANI ham "mavjud" hisoblanadi (yuqoridagi izohga qarang),
  // lekin ALOHIDA sanaladi: "hammasi bor" bilan "uchtasi bekor qilingan"
  // butunlay boshqa xabar. Bekor qilinganini qaytarish uchun qatordagi
  // "Qayta shakllantirish" ishlatiladi.
  const existing = await prisma.payrollEntry.findMany({
    where: { month, staffId: { in: staff.map((s) => s.id) } },
    select: { staffId: true, status: true },
  });
  const existingIds = new Set(existing.map((e) => e.staffId));
  const cancelledIds = new Set(
    existing.filter((e) => e.status === "cancelled").map((e) => e.staffId),
  );

  // 4 ── Qatorlarni yig'ish
  const rows = [];
  let total = new Decimal(0);

  for (const person of staff) {
    if (existingIds.has(person.id)) {
      if (cancelledIds.has(person.id)) summary.skipped.cancelled += 1;
      else summary.skipped.alreadyExists += 1;
      continue;
    }

    const salary = salaries.get(person.id);
    if (!salary) {
      summary.skipped.noSalary += 1;
      continue;
    }

    const amount = new Decimal(salary.amount);
    total = total.plus(amount);

    rows.push({
      staffId: person.id,
      month,
      amount,
      salaryType: salary.type,
      staffSnapshot: {
        firstName: person.firstName,
        lastName: person.lastName ?? "",
        username: person.username,
        role: person.role,
      },
      createdBy: actorId,
    });
  }

  summary.created = rows.length;
  summary.totalAmount = formatAmount(total);
  summary.dryRun = dryRun;

  if (!dryRun && rows.length > 0) {
    await prisma.payrollEntry.createMany({ data: rows, skipDuplicates: true });
    logger.info(
      `[payroll] ${formatMonthKey(month)}: ${rows.length} ta oylik majburiyati, ` +
        `jami ${formatAmount(total)}`,
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
 * BITTA MAJBURIYATNI QAYTA SHAKLLANTIRISH.
 *
 * `invoice.service.regenerateInvoice` ning ko'zgusi. Doktrina bo'yicha
 * summani o'zgartiradigan endpoint YO'Q; xato bo'lsa yo'l bitta:
 * majburiyat bekor qilinadi → oylik qoidasi to'g'rilanadi → majburiyat
 * QAYTA SHAKLLANTIRILADI (`finance.md` §10).
 *
 * ⚠️ Oylik passi bekor qilinganini QAYTA YOZMAYDI (u qaror, bo'shliq
 * emas), shuning uchun qaytarishning yagona yo'li aynan shu — QO'LDA,
 * sabab bilan, bitta qator uchun.
 *
 * ⚠️ O'CHIRIB QAYTA YARATILMAYDI, JOYIDA yangilanadi. `PayrollEntry` da
 * `replaces` ko'rsatkichi yo'q: o'chirilsa bekor qilish izi butunlay
 * yo'qolardi. `restoreInvoice` bilan bir xil mulohaza — butun tarix
 * bitta qatorda qoladi.
 *
 * ⚠️ TO'LOV TUSHGAN majburiyat qayta shakllantirilmaydi: summani
 * o'zgartirish to'lov taqsimotini yolg'onga aylantirardi.
 *
 * @param {string} id
 * @param {string} reason
 * @param {string} userId
 */
const regenerateEntry = async (id, reason, userId) => {
  const entry = await prisma.payrollEntry.findUnique({ where: { id } });
  if (!entry) throw new NotFoundError("Oylik majburiyati topilmadi");

  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError("Qayta shakllantirish sababi majburiy");

  if (new Decimal(entry.paidAmount).greaterThan(0)) {
    throw new BadRequestError(
      "Bu majburiyatga to'lov tushgan — avval to'lovni bekor qiling",
    );
  }

  // Xodim hali ham oylik oladimi va qoidasi qanday
  const [staff, salaries] = await Promise.all([
    prisma.user.findUnique({ where: { id: entry.staffId }, select: STAFF_SELECT }),
    resolveSalariesForMonth(entry.month),
  ]);

  if (!staff) throw new NotFoundError("Xodim topilmadi");
  if (staff.isArchived) {
    throw new BadRequestError(
      "Xodim arxivlangan — majburiyatni qayta shakllantirmang, bekor qiling",
    );
  }

  const salary = salaries.get(entry.staffId);
  if (!salary) {
    throw new BadRequestError(
      `${formatMonthKey(entry.month)} uchun oylik qoidasi yo'q — ` +
        "avval qoidani belgilang",
    );
  }

  const amount = new Decimal(salary.amount);

  logger.warn(
    `[payroll] Majburiyat qayta shakllantirildi: entry=${id} ` +
      `staff=${entry.staffId} oy=${entry.month} ` +
      `eski=${formatAmount(entry.amount)} yangi=${formatAmount(amount)} ` +
      `eskiHolat=${entry.status} actor=${userId} sabab="${trimmed}"`,
  );

  const updated = await prisma.payrollEntry.update({
    where: { id },
    data: {
      amount,
      salaryType: salary.type,
      // To'lov yo'q (yuqorida tekshirildi) — holat har doim "unpaid"
      status: "unpaid",
      paidAmount: 0,
      paidAt: null,
      // Bekor qilish izi tozalanadi: qator endi amaldagi majburiyat
      cancelReason: "",
      cancelledAt: null,
      cancelledBy: null,
      staffSnapshot: {
        firstName: staff.firstName,
        lastName: staff.lastName ?? "",
        username: staff.username,
        role: staff.role,
      },
      note: entry.note,
    },
  });

  return serializeEntry(updated, { staff });
};

module.exports = {
  STATUS_LABELS,
  regenerateEntry,
  serializeEntry,
  generateForMonth,
  getEntries,
  getStaffEntries,
  cancelEntry,
};
