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
const { formatAmount, sumAmounts } = require("../helpers/money.helpers");
const {
  describeAcademicMonth,
  describeBillableMonth,
} = require("../helpers/academicYear.helpers");
const { getFinanceSettings } = require("./settings.service");
const { resolveManyForMonth } = require("./tariffResolution.service");
const { resolveStatusesForMonth, NON_BILLABLE } = require("./studentFinanceStatus.service");
const { resolveDiscountsForMonth } = require("./studentDiscount.service");
const { resolveEnrollmentsForStudents } = require("./studentEnrollment.service");
const { getVacationSet } = require("./vacationMonth.service");
const { applyDepositsForStudents } = require("./studentAccount.service");
const { buildInvoiceRow, prorationGap } = require("./invoiceBuilder.service");

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
  // Kirish proratsiyasi tufayli hisoblanmagan summa — admin kartasida
  // `baseAmount − amount` farqi yorliqsiz g'oyib bo'lmasligi uchun
  prorationTotal: "0.00",
  prorated: 0,
  // Qat'iy chegirma proratsiya qilingan oyni nolga tushirgan hollar
  wipedByDiscount: 0,
  depositApplied: "0.00",
  skipped: {
    alreadyExists: 0,
    notEnrolled: 0,
    frozen: 0,
    noTariff: 0,
    noTariffNewlyEnrolled: 0,
    noPrice: 0,
  },
  details: {
    notEnrolled: [],
    frozen: [],
    noTariff: [],
    noTariffNewlyEnrolled: [],
    noPrice: [],
    wouldCreate: [],
    truncated: false,
  },
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
    // Sanoqchi kaliti ish vaqtida hosil bo'ladi — oldindan e'lon qilinmagan
    // bucket `undefined + 1 = NaN` berib, butun hisobotni buzardi.
    summary.details[bucket] ??= [];

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
      summary.skipped[status] = (summary.skipped[status] ?? 0) + 1;
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

  // ── 3. Narx, chegirma, o'qish davri va 4. mavjud hisob-fakturalar ─
  // Hammasi `billableIds` bo'yicha — passga qo'shimcha aylanish qo'shilmaydi.
  const [{ byStudent }, discountsByStudent, periodsByStudent, existing] =
    await Promise.all([
      resolveManyForMonth(month, { studentIds: billableIds }),
      resolveDiscountsForMonth(month, { studentIds: billableIds }),
      resolveEnrollmentsForStudents(billableIds),
      prisma.monthlyInvoice.findMany({
        where: { month, studentId: { in: billableIds } },
        select: { studentId: true },
      }),
    ]);

  // Bekor qilingan hisob-faktura ham "mavjud" hisoblanadi: u qaror, bo'shliq emas.
  const existingIds = new Set(existing.map((e) => e.studentId));

  // ── 5. Qatorlarni yig'ish ─────────────────
  // Summa mantig'i `invoiceBuilder.service.js` da — qayta shakllantirish
  // ham AYNAN shuni chaqiradi. Ikkita mustaqil quruvchi bo'lsa, proratsiya
  // faqat bittasiga qo'shilib qolardi.
  const rows = [];
  const amounts = [];
  const discountAmounts = [];
  const prorationGaps = [];

  for (const student of billable) {
    if (existingIds.has(student.id)) {
      summary.skipped.alreadyExists += 1;
      continue;
    }

    const klass = student.classes[0]?.class ?? null;

    const { row, skip, computed } = buildInvoiceRow({
      student,
      month,
      settings,
      academic,
      billableMonth,
      resolved: byStudent.get(student.id),
      discounts: discountsByStudent.get(student.id) ?? [],
      periods: periodsByStudent.get(student.id) ?? [],
      source,
      actorId,
      studentSnapshot: {
        firstName: student.firstName,
        lastName: student.lastName ?? "",
        username: student.username,
        classId: klass?.id ?? null,
        className: klass?.name ?? null,
      },
    });

    if (skip) {
      summary.skipped[skip] = (summary.skipped[skip] ?? 0) + 1;
      pushDetail(skip, {
        studentId: student.id,
        fullName: fullNameOf(student),
        ...(skip === "noPrice"
          ? { tariffId: byStudent.get(student.id)?.assignment?.tariffId ?? null }
          : {}),
      });
      continue;
    }

    amounts.push(computed.amount);
    discountAmounts.push(computed.discountAmount);
    prorationGaps.push(prorationGap(computed.baseAmount, computed.proratedAmount));

    if (computed.isProrated) summary.prorated += 1;
    // Qat'iy chegirma proratsiya qilingan oyni butunlay yeb qo'ydi — bu
    // ongli qabul qilingan qoida, lekin JIM qolmasligi kerak.
    if (computed.wipedByDiscount) summary.wipedByDiscount += 1;

    rows.push(row);

    if (dryRun) {
      pushDetail("wouldCreate", {
        studentId: student.id,
        fullName: fullNameOf(student),
        baseAmount: formatAmount(computed.baseAmount),
        proratedAmount: formatAmount(computed.proratedAmount),
        isProrated: computed.isProrated,
        billableDays: row.billableDays,
        monthDays: row.monthDays,
        discountAmount: formatAmount(computed.discountAmount),
        amount: formatAmount(computed.amount),
        tariffName: row.tariffName,
        discounts: computed.snapshot.map((d) => d.name),
      });
    }
  }

  summary.totalAmount = formatAmount(sumAmounts(amounts));
  summary.discountTotal = formatAmount(sumAmounts(discountAmounts));
  summary.prorationTotal = formatAmount(sumAmounts(prorationGaps));

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
