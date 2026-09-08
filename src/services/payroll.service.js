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
 *
 * ── SOATBAY VA ARALASH REJIM ─────────────────
 *
 * `hourly`/`mixed` da summa DARS SOATIDAN chiqadi va soat oy davomida
 * o'zgarib turadi (jadval tahrirlanadi, o'rinbosarlik qo'shiladi).
 *
 * ⚠️ SHUNING UCHUN ULAR FAQAT OY YOPILGANDAN KEYIN SHAKLLANTIRILADI.
 * Cron har kuni 06:00 da ishlaydi va joriy oyni ham ko'radi; agar soatbay
 * majburiyat oyning 3-kunida muhrlansa, u 3 kunlik soatni butun oy deb
 * yozib qo'yardi — `amount` esa MUHRLANGAN, uni tahrirlaydigan endpoint
 * yo'q. Cron `catchUpMonths` tufayli o'tgan oylarni ham ko'radi, ya'ni
 * yopilgan oy ertasi kuni avtomatik shakllanadi.
 *
 * ⚠️ SOATI NOL bo'lgan SOATBAY xodimga majburiyat YOZILMAYDI. 0 so'mlik
 * qator "to'langan" bo'lib turadi va registrni ifloslantiradi; ta'til oyi
 * yoki hali dars biriktirilmagan o'qituvchi aynan shu holatga tushadi.
 * Aralash rejimda esa bazaviy qism baribir to'lanadi — qator yoziladi.
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
const {
  resolveSalariesForMonth,
  STAFF_SELECT,
  TYPE_LABELS,
  formulaOf,
} = require("./staffSalary.service");
const { getTeachersHours } = require("./lessonHours.service");
const { computeSalary } = require("../helpers/lessonHours");

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
    // ── SUMMA QANDAY CHIQQANI ──────────────
    baseAmount: formatAmount(row.baseAmount),
    hoursAmount: formatAmount(row.hoursAmount),
    hourlyRate: formatAmount(row.hourlyRate),
    monthLabel: formatMonthKey(row.month),
    statusLabel: STATUS_LABELS[row.status] ?? row.status,
    salaryTypeLabel: TYPE_LABELS[row.salaryType] ?? row.salaryType,
    usesHours: row.salaryType === "hourly" || row.salaryType === "mixed",
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
  // Soatdan chiqqan pul — "qancha qismi dars soati uchun" degan savolga
  // vedomostni ochmasdan javob beradi.
  hoursAmount: "0.00",
  hoursTotal: 0,
  skipped: {
    alreadyExists: 0,
    cancelled: 0,
    noSalary: 0,
    archived: 0,
    // ⚠️ Yangi sabab qo'shilsa SHU YERGA ham yoziladi, aks holda cron
    // logi jimgina kam hisobot berardi.
    monthOpen: 0,
    noHours: 0,
  },
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

  // 4 ── DARS SOATI — faqat kerak bo'lganlar uchun, BITTA o'tishda.
  //
  // ⚠️ Fiksa xodimlar uchun so'rov umuman qilinmaydi: buxgalter va
  // farroshning dars jadvali yo'q, ularni hisobga qo'shish har oy
  // ma'nosiz ish bo'lardi.
  const monthIsOpen = month >= currentMonthKey();

  const hourStaffIds = staff
    .filter((person) => {
      const salary = salaries.get(person.id);
      return salary && (salary.type === "hourly" || salary.type === "mixed");
    })
    .map((person) => person.id);

  const hoursMap =
    hourStaffIds.length > 0 && !monthIsOpen
      ? await getTeachersHours(hourStaffIds, month)
      : new Map();

  // 5 ── Qatorlarni yig'ish
  const rows = [];
  let total = new Decimal(0);
  let hoursTotalAmount = new Decimal(0);
  let hoursTotal = 0;

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

    const usesHours = salary.type === "hourly" || salary.type === "mixed";

    // ⚠️ OY YOPILMAGUNCHA SOATBAY MUHRLANMAYDI (fayl sarlavhasiga qarang).
    if (usesHours && monthIsOpen) {
      summary.skipped.monthOpen += 1;
      continue;
    }

    const hoursRow = usesHours ? hoursMap.get(person.id) : null;
    const hours = hoursRow?.hours ?? 0;

    // ⚠️ SOATI YO'Q SOATBAYGA 0 SO'MLIK MAJBURIYAT YOZILMAYDI.
    if (salary.type === "hourly" && hours <= 0) {
      summary.skipped.noHours += 1;
      continue;
    }

    // Formula YAGONA nuqtada — panel ham shuni chaqiradi
    const money = computeSalary(salary, hours);

    total = total.plus(money.amount);
    hoursTotalAmount = hoursTotalAmount.plus(money.hoursAmount);
    hoursTotal += usesHours ? hours : 0;

    rows.push({
      staffId: person.id,
      month,
      amount: money.amount,
      baseAmount: money.baseAmount,
      hoursAmount: money.hoursAmount,
      hoursWorked: usesHours ? hours : 0,
      extraHours: money.extraHours,
      hourlyRate: salary.hourlyRate ?? null,
      hourNorm: salary.monthlyHourNorm ?? null,
      // Dalil: summa qaysi jadvaldan chiqqani. Jadval keyin o'zgarsa ham
      // qator o'qiladi (`staffSnapshot` doktrinasi).
      hoursSnapshot: hoursRow
        ? {
            formula: formulaOf(salary),
            scheduledHours: hoursRow.scheduledHours,
            substitutedOutHours: hoursRow.substitutedOutHours,
            substitutedInHours: hoursRow.substitutedInHours,
            teachingDays: hoursRow.teachingDays,
            weeklyHours: hoursRow.weeklyHours,
            byClass: hoursRow.byClass,
            bySubject: hoursRow.bySubject,
          }
        : null,
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
  summary.hoursAmount = formatAmount(hoursTotalAmount);
  summary.hoursTotal = hoursTotal;
  summary.dryRun = dryRun;

  if (!dryRun && rows.length > 0) {
    await prisma.payrollEntry.createMany({ data: rows, skipDuplicates: true });
    logger.info(
      `[payroll] ${formatMonthKey(month)}: ${rows.length} ta oylik majburiyati, ` +
        `jami ${formatAmount(total)} (soatdan ${formatAmount(hoursTotalAmount)}, ` +
        `${hoursTotal} soat)`,
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

  // ⚠️ SOAT QAYTA HISOBLANADI, muhrlangan qiymat ko'chirilmaydi. Qayta
  // shakllantirishning butun mohiyati shu: o'rinbosarlik kech kiritilgan
  // yoki jadval to'g'rilangan bo'lsa, yangi qator YANGI haqiqatni yozishi
  // kerak. Eskisini ko'chirsak, tugma bosilgani bilan hech narsa
  // o'zgarmasdi va odam sababini tushunmasdi.
  const usesHours = salary.type === "hourly" || salary.type === "mixed";

  if (usesHours && entry.month >= currentMonthKey()) {
    throw new BadRequestError(
      "Soatbay majburiyat oy yakunlanmaguncha qayta shakllantirilmaydi — " +
        "soat hali o'zgarishi mumkin",
    );
  }

  const hoursRow = usesHours
    ? (await getTeachersHours([entry.staffId], entry.month)).get(entry.staffId)
    : null;

  const hours = hoursRow?.hours ?? 0;

  if (salary.type === "hourly" && hours <= 0) {
    throw new BadRequestError(
      `${formatMonthKey(entry.month)} da bu o'qituvchida dars soati yo'q — ` +
        "majburiyatni qayta shakllantirmang, bekor qiling",
    );
  }

  const money = computeSalary(salary, hours);
  const amount = money.amount;

  logger.warn(
    `[payroll] Majburiyat qayta shakllantirildi: entry=${id} ` +
      `staff=${entry.staffId} oy=${entry.month} ` +
      `eski=${formatAmount(entry.amount)} yangi=${formatAmount(amount)} ` +
      `soat=${hours} eskiHolat=${entry.status} actor=${userId} sabab="${trimmed}"`,
  );

  const updated = await prisma.payrollEntry.update({
    where: { id },
    data: {
      amount,
      baseAmount: money.baseAmount,
      hoursAmount: money.hoursAmount,
      hoursWorked: usesHours ? hours : 0,
      extraHours: money.extraHours,
      hourlyRate: salary.hourlyRate ?? null,
      hourNorm: salary.monthlyHourNorm ?? null,
      hoursSnapshot: hoursRow
        ? {
            formula: formulaOf(salary),
            scheduledHours: hoursRow.scheduledHours,
            substitutedOutHours: hoursRow.substitutedOutHours,
            substitutedInHours: hoursRow.substitutedInHours,
            teachingDays: hoursRow.teachingDays,
            weeklyHours: hoursRow.weeklyHours,
            byClass: hoursRow.byClass,
            bySubject: hoursRow.bySubject,
          }
        : null,
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
