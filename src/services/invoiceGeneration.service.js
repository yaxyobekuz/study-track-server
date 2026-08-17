/**
 * Oylik to'lov majburiyatlarini shakllantirish.
 *
 * Alohida faylda, chunki chaqiruvchisi ikkita: cron va admin endpointi —
 * `tariffResolution.service.js` bilan bir xil sabab. Va aynan shu yerda
 * `tariffResolution` sarlavhasida va'da qilingan SNAPSHOT olinadi: narx,
 * tarif nomi va o'quvchi ma'lumoti hisob-fakturaga muhrlanadi.
 *
 * IDEMPOTENTLIK ATOMARLIK O'RNINI BOSADI. Butun paket tranzaksiyaga
 * o'ralmaydi: yarim bajarilgan pass qayta ishga tushirish bilan to'liq
 * tuzaladi, tranzaksiya esa butun o'quvchi tanasi ustidan uzoq yozuv lock'i
 * ushlab turardi. Haqiqiy kafolat — `@@unique([studentId, month])` va
 * `skipDuplicates`. Shu sababli ikkita instans (PM2 cluster) bir vaqtda
 * ishlasa ham dublikat paydo bo'lmaydi.
 *
 * So'rovlar soni o'quvchilar soniga BOG'LIQ EMAS — butun maktab uchun 7 ta.
 */

const prisma = require("../config/prisma");
const { ROLES } = require("../utils/constants");
const { BadRequestError } = require("../utils/errors");
const {
  currentMonthKey,
  parseMonthKey,
  formatMonthKey,
  nextMonth,
} = require("../helpers/month.helpers");
const { parseAmount, formatAmount, sumAmounts } = require("../helpers/money.helpers");
const {
  describeAcademicMonth,
  describeBillableMonth,
} = require("../helpers/academicYear.helpers");
const { applyDiscounts } = require("../helpers/discount.helpers");
const { getFinanceSettings } = require("./settings.service");
const { resolveManyForMonth, REASONS } = require("./tariffResolution.service");
const { resolveStatusesForMonth, NON_BILLABLE } = require("./studentFinanceStatus.service");
const { resolveDiscountsForMonth } = require("./studentDiscount.service");
const { getVacationSet } = require("./vacationMonth.service");
const { applyDepositsForStudents } = require("./studentAccount.service");

// `details` ro'yxatlari cheksiz o'smasin — admin uchun 200 ta ism yetarli
const DETAILS_LIMIT = 200;
// Postgres parametr chegarasiga urilmaslik uchun
const CHUNK_SIZE = 1000;

// Nima uchun oy o'tkazib yuborildi
const SKIP_REASONS = {
  NOT_ACADEMIC: "not_academic",
  BEFORE_FIRST_INVOICE_MONTH: "before_first_invoice_month",
  // Ta'til — akademik oyna ICHIDAGI istisno, shuning uchun alohida sabab:
  // admin ekranida "2027-01 akademik oy emas" emas, "2027-01 — ta'til"
  // yozilishi kerak.
  VACATION: "vacation",
};

const fullNameOf = (student) =>
  `${student.firstName} ${student.lastName ?? ""}`.trim();

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * Bo'sh natija — xato emas. Cron iyul oyidan jimgina o'tib ketishi kerak,
 * admin esa "2026-07 akademik oy emas" deb ko'rishi kerak.
 */
const emptySummary = (month, settings, reason) => ({
  month,
  monthLabel: formatMonthKey(month),
  ...describeAcademicMonth(month, settings),
  reason,
  dryRun: false,
  eligible: 0,
  created: 0,
  totalAmount: "0.00",
  discountTotal: "0.00",
  depositApplied: "0.00",
  skipped: { alreadyExists: 0, frozen: 0, expelled: 0, noTariff: 0, noPrice: 0 },
  details: { frozen: [], expelled: [], noTariff: [], noPrice: [], wouldCreate: [], truncated: false },
});

/**
 * Bitta oy uchun majburiyatlarni shakllantiradi.
 *
 * @param {number|string} monthInput - YYYYMM
 * @param {object} options
 * @param {string|null} [options.actorId] - null → cron
 * @param {"cron"|"manual"} [options.source]
 * @param {string[]} [options.studentIds] - ixtiyoriy toraytirish
 * @param {string} [options.classId] - ixtiyoriy toraytirish
 * @param {boolean} [options.dryRun] - yozmasdan, nima bo'lishini qaytaradi
 * @returns {Promise<object>} summary
 */
const generateForMonth = async (monthInput, options = {}) => {
  const startedAt = Date.now();
  const {
    actorId = null,
    source = "cron",
    studentIds,
    classId,
    dryRun = false,
  } = options;

  const month = parseMonthKey(monthInput, "Oy");
  const settings = await getFinanceSettings();

  // ── Qo'riqchilar ──────────────────────────
  if (month > currentMonthKey()) {
    throw new BadRequestError(
      "Kelajakdagi oy uchun majburiyat shakllantirilmaydi",
    );
  }

  const academic = describeAcademicMonth(month, settings);
  if (!academic.isAcademicMonth) {
    return emptySummary(month, settings, SKIP_REASONS.NOT_ACADEMIC);
  }

  if (settings.firstInvoiceMonth != null && month < settings.firstInvoiceMonth) {
    return emptySummary(month, settings, SKIP_REASONS.BEFORE_FIRST_INVOICE_MONTH);
  }

  // Ta'til — butun maktabga: hech kimga majburiyat yozilmaydi
  const vacationSet = await getVacationSet(academic.academicYear);
  if (vacationSet.has(month)) {
    return emptySummary(month, settings, SKIP_REASONS.VACATION);
  }

  // Ota-ona ko'radigan "8 oydan 5-si" — ta'til oylari chegirilgan holda,
  // va u ham SNAPSHOT: keyin qo'shilgan ta'til bu yorliqni o'zgartirmaydi.
  const billableMonth = describeBillableMonth(month, settings, vacationSet);

  // ── 1. O'quvchilar ────────────────────────
  // `isActive` ATAYLAB filtrlanmaydi: u login bayrog'i, o'qishga yozilish emas.
  // O'chirilgan login qarzni bekor qilmaydi.
  const students = await prisma.user.findMany({
    where: {
      role: ROLES.STUDENT,
      isArchived: false,
      ...(studentIds?.length ? { id: { in: studentIds } } : {}),
      ...(classId ? { classes: { some: { classId } } } : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      username: true,
      classes: { select: { class: { select: { id: true, name: true } } } },
    },
  });

  const summary = emptySummary(month, settings, null);
  summary.dryRun = dryRun;
  summary.eligible = students.length;

  if (students.length === 0) {
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const allIds = students.map((s) => s.id);

  // ── 2. Holat ──────────────────────────────
  const statusByStudent = await resolveStatusesForMonth(month, {
    studentIds: allIds,
  });

  const pushDetail = (bucket, item) => {
    if (summary.details[bucket].length < DETAILS_LIMIT) {
      summary.details[bucket].push(item);
    } else {
      summary.details.truncated = true;
    }
  };

  const billable = [];
  for (const student of students) {
    const status = statusByStudent.get(student.id)?.status ?? "active";

    if (NON_BILLABLE.has(status)) {
      summary.skipped[status] += 1;
      pushDetail(status, { studentId: student.id, fullName: fullNameOf(student) });
      continue;
    }

    billable.push(student);
  }

  if (billable.length === 0) {
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  const billableIds = billable.map((s) => s.id);

  // ── 3. Narx, chegirma va 4. mavjud hisob-fakturalar ─
  const [{ byStudent }, discountsByStudent, existing] = await Promise.all([
    resolveManyForMonth(month, { studentIds: billableIds }),
    resolveDiscountsForMonth(month, { studentIds: billableIds }),
    prisma.monthlyInvoice.findMany({
      where: { month, studentId: { in: billableIds } },
      select: { studentId: true },
    }),
  ]);

  // Bekor qilingan hisob-faktura ham "mavjud" hisoblanadi: u qaror, bo'shliq emas.
  const existingIds = new Set(existing.map((e) => e.studentId));

  // ── 5. Qatorlarni yig'ish ─────────────────
  const rows = [];
  const amounts = [];
  const discountAmounts = [];

  for (const student of billable) {
    if (existingIds.has(student.id)) {
      summary.skipped.alreadyExists += 1;
      continue;
    }

    const resolved = byStudent.get(student.id);

    if (!resolved || resolved.reason === REASONS.NO_ASSIGNMENT) {
      summary.skipped.noTariff += 1;
      pushDetail("noTariff", { studentId: student.id, fullName: fullNameOf(student) });
      continue;
    }

    if (resolved.reason === REASONS.NO_PRICE) {
      // Konfiguratsiya xatosi — ochiq ko'rsatiladi. Nol summali hisob-faktura
      // yaratilmaydi: 0 qarz — yolg'on, hisob-fakturaning yo'qligi esa
      // "narx belgilanmagan" degan haqiqatni to'g'ri ifodalaydi.
      summary.skipped.noPrice += 1;
      pushDetail("noPrice", {
        studentId: student.id,
        fullName: fullNameOf(student),
        tariffId: resolved.assignment?.tariffId ?? null,
      });
      continue;
    }

    const item = resolved.items[0];
    const baseAmount = parseAmount(resolved.total, "Oylik summa");

    // Chegirma AYNAN shu yerda qo'llanadi va natijasi muhrlanadi: keyin
    // chegirma o'zgarsa ham bu oy summasi qimirlamaydi.
    const discounted = applyDiscounts(baseAmount, discountsByStudent.get(student.id) ?? [], {
      maxPercent: settings.maxDiscountPercent,
    });

    const amount = discounted.finalAmount;
    amounts.push(amount);
    discountAmounts.push(discounted.discountAmount);

    const klass = student.classes[0]?.class ?? null;

    // Nol summali hisob-faktura darhol "to'langan" bo'ladi — qamrov to'liq
    // qoladi, uydirma qarz yaralmaydi. Bu `noPrice` skip'idan TUBDAN farq
    // qiladi: u yerda 0 yolg'on edi, bu yerda 0 (100% chegirma yoki grant
    // tarifi) — haqiqat.
    const isZero = amount.isZero();

    rows.push({
      studentId: student.id,
      month,
      academicYear: academic.academicYear,
      academicIndex: academic.academicIndex,
      billableIndex: billableMonth.billableIndex,
      billableMonthCount: billableMonth.billableMonthCount,
      tariffId: item.tariff.id,
      tariffVersionId: item.version.id,
      tariffName: item.tariff.name,
      baseAmount,
      discountAmount: discounted.discountAmount,
      discountSnapshot: discounted.snapshot.length ? discounted.snapshot : null,
      amount,
      paidAmount: 0,
      status: isZero ? "paid" : "unpaid",
      paidAt: isZero ? new Date() : null,
      source,
      studentSnapshot: {
        firstName: student.firstName,
        lastName: student.lastName ?? "",
        username: student.username,
        classId: klass?.id ?? null,
        className: klass?.name ?? null,
      },
      createdBy: actorId,
    });

    if (dryRun) {
      pushDetail("wouldCreate", {
        studentId: student.id,
        fullName: fullNameOf(student),
        baseAmount: formatAmount(baseAmount),
        discountAmount: formatAmount(discounted.discountAmount),
        amount: formatAmount(amount),
        tariffName: item.tariff.name,
        discounts: discounted.snapshot.map((d) => d.name),
      });
    }
  }

  summary.totalAmount = formatAmount(sumAmounts(amounts));
  summary.discountTotal = formatAmount(sumAmounts(discountAmounts));

  // ── 6. Yozish ─────────────────────────────
  if (!dryRun && rows.length > 0) {
    for (const part of chunk(rows, CHUNK_SIZE)) {
      const result = await prisma.monthlyInvoice.createMany({
        data: part,
        skipDuplicates: true,
      });
      summary.created += result.count;
    }
  } else if (dryRun) {
    summary.created = rows.length;
  }

  // ── 7. Depozitni qo'llash ─────────────────
  // Oldindan to'lab qo'ygan o'quvchining yangi hisob-fakturasi darhol
  // yopiladi. ALOHIDA va IDEMPOTENT qadam: yarim bajarilgan pass qayta
  // ishga tushirilsa ham dublikat bermaydi, chunki sharti "qoldiq > 0 va
  // ochiq hisob-faktura bor".
  if (!dryRun && summary.created > 0 && settings.depositAutoApply) {
    const deposits = await applyDepositsForStudents(
      rows.map((row) => row.studentId),
    );
    summary.depositApplied = deposits.applied;
    summary.depositStudents = deposits.students;
    if (deposits.failed.length) summary.depositFailed = deposits.failed;
  }

  summary.durationMs = Date.now() - startedAt;
  return summary;
};

/**
 * Oylar oralig'i uchun (cron'ning catch-up'i va admin backfill'i).
 * Akademik bo'lmagan oylar shunchaki `reason: "not_academic"` qaytaradi.
 *
 * @param {number} fromMonth
 * @param {number} toMonth
 * @param {object} options
 * @returns {Promise<object[]>}
 */
const generateForRange = async (fromMonth, toMonth, options = {}) => {
  const from = parseMonthKey(fromMonth, "Boshlanish oyi");
  const to = parseMonthKey(toMonth, "Tugash oyi");

  if (to < from) {
    throw new BadRequestError("Tugash oyi boshlanish oyidan oldin bo'lishi mumkin emas");
  }

  const summaries = [];
  let month = from;

  while (month <= to) {
    summaries.push(await generateForMonth(month, options));
    month = nextMonth(month);
  }

  return summaries;
};

module.exports = {
  SKIP_REASONS,
  DETAILS_LIMIT,
  generateForMonth,
  generateForRange,
};
