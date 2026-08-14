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
const { describeAcademicMonth } = require("../helpers/academicYear.helpers");
const { getFinanceSettings } = require("./settings.service");
const { resolveManyForMonth, REASONS } = require("./tariffResolution.service");
const { resolveStatusesForMonth, NON_BILLABLE } = require("./studentFinanceStatus.service");

// `details` ro'yxatlari cheksiz o'smasin — admin uchun 200 ta ism yetarli
const DETAILS_LIMIT = 200;
// Postgres parametr chegarasiga urilmaslik uchun
const CHUNK_SIZE = 1000;

// Nima uchun oy o'tkazib yuborildi
const SKIP_REASONS = {
  NOT_ACADEMIC: "not_academic",
  BEFORE_FIRST_INVOICE_MONTH: "before_first_invoice_month",
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

  // ── 3. Narx va 4. mavjud hisob-fakturalar ─
  const [{ byStudent }, existing] = await Promise.all([
    resolveManyForMonth(month, { studentIds: billableIds }),
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
    const amount = parseAmount(resolved.total, "Oylik summa");
    amounts.push(amount);

    const klass = student.classes[0]?.class ?? null;

    // Nol summali grant tarifi darhol "to'langan" bo'ladi — qamrov to'liq
    // qoladi, uydirma qarz yaralmaydi.
    const isZero = amount.isZero();

    rows.push({
      studentId: student.id,
      month,
      academicYear: academic.academicYear,
      academicIndex: academic.academicIndex,
      tariffId: item.tariff.id,
      tariffVersionId: item.version.id,
      tariffName: item.tariff.name,
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
        amount: formatAmount(amount),
        tariffName: item.tariff.name,
      });
    }
  }

  summary.totalAmount = formatAmount(sumAmounts(amounts));

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
