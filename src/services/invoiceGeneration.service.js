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
const { Decimal, formatAmount, sumAmounts } = require("../helpers/money.helpers");

const { getFinanceSettings } = require("./settings.service");
const { resolveManyForMonth } = require("./tariffResolution.service");
const { resolveStatusesForMonth, NON_BILLABLE } = require("./studentFinanceStatus.service");
const { resolveDiscountsForMonth } = require("./studentDiscount.service");
const { resolveEnrollmentsForStudents } = require("./studentEnrollment.service");
const { resolveForMonth: resolveOverridesForMonth } = require("./studentMonthOverride.service");
const { isVacationMonth } = require("./vacationMonth.service");
const { applyDepositsForStudents } = require("./studentAccount.service");
const { buildInvoiceRow, prorationGap } = require("./invoiceBuilder.service");

// `details` ro'yxatlari cheksiz o'smasin — admin uchun 200 ta ism yetarli
const DETAILS_LIMIT = 200;
// Postgres parametr chegarasiga urilmaslik uchun
const CHUNK_SIZE = 1000;

// Nima uchun oy o'tkazib yuborildi.
//
// O'quv yili tushunchasi yo'q: sukut bo'yicha HAR OY to'lanadi, shuning
// uchun "akademik oy emas" degan sabab ham yo'q. Oy faqat ta'til deb
// belgilangani yoki qattiq poldan oldin turgani uchun o'tkazib yuboriladi.
const SKIP_REASONS = {
  BEFORE_FIRST_INVOICE_MONTH: "before_first_invoice_month",
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
 * Bo'sh natija — xato emas. Cron ta'til oyidan jimgina o'tib ketishi kerak,
 * admin esa "2026-07 — ta'til" deb ko'rishi kerak.
 */
const emptySummary = (month, reason) => ({
  month,
  monthLabel: formatMonthKey(month),
  reason,
  dryRun: false,
  eligible: 0,
  created: 0,
  // Bekor qilingandan qaytarilganlari — YARATILGANDAN alohida sanaladi:
  // "3 ta yangi" bilan "3 tasi bekordan qaytarildi" boshqa xabar.
  restored: 0,
  totalAmount: "0.00",
  discountTotal: "0.00",
  // Kirish proratsiyasi tufayli hisoblanmagan summa — admin kartasida
  // `baseAmount − amount` farqi yorliqsiz g'oyib bo'lmasligi uchun
  prorationTotal: "0.00",
  prorated: 0,
  // Chegirma oyni butunlay nolga tushirgan hollar (proratsiya bilan ham,
  // proratsiyasiz ham). `financeReport.getTariffBreakdown` dagi shu nomli
  // sanoqchi bilan AYNI ma'noda.
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
    wouldRestore: [],
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

  if (settings.firstInvoiceMonth != null && month < settings.firstInvoiceMonth) {
    return emptySummary(month, SKIP_REASONS.BEFORE_FIRST_INVOICE_MONTH);
  }

  // Ta'til — butun maktabga: hech kimga majburiyat yozilmaydi
  if (await isVacationMonth(month)) {
    return emptySummary(month, SKIP_REASONS.VACATION);
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

  // ⚠️ `emptySummary(month, reason)` — IKKI argument. Ilgari bu yerda
  // uchinchi argument bilan `settings` uzatilgan edi va u `reason` bo'lib
  // qolardi: javobda butun FinanceSettings obyekti chiqar, cron logi esa
  // "reason bor" deb hisoblab har passda haqiqiy hisobot satrini bosmasdan
  // `[object Object]` yozardi.
  const summary = emptySummary(month, null);
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
  const [{ byStudent }, discountsByStudent, periodsByStudent, overridesByStudent, existing] =
    await Promise.all([
      resolveManyForMonth(month, { studentIds: billableIds }),
      resolveDiscountsForMonth(month, { studentIds: billableIds }),
      resolveEnrollmentsForStudents(billableIds),
      resolveOverridesForMonth(month, billableIds),
      prisma.monthlyInvoice.findMany({
        where: { month, studentId: { in: billableIds } },
        select: { id: true, studentId: true, status: true, paidAmount: true, note: true },
      }),
    ]);

  // ⚠️ IKKI XIL "mavjud" bor va ular BOSHQACHA ishlanadi:
  //   amaldagi (unpaid/partial/paid) → TEGILMAYDI, summa muhrlangan;
  //   bekor qilingani                → TIKLANADI (`restorable`).
  //
  // Ilgari bekor qilingani ham "qaror, bo'shliq emas" deb o'tkazib
  // yuborilardi va oqibati og'ir edi: bir marta bekor qilingan oy
  // "Shakllantirish" necha marta bosilsa ham QAYTMASDI. Ekranda esa
  // "yangi majburiyat yo'q" deb chiqar va foydalanuvchi tugma buzuq deb
  // o'ylardi — yagona yo'l har bir qatorni qo'lda qaytarish edi.
  //
  // ⚠️ Bekor qilingan qatorda `paidAmount` HAR DOIM 0 bo'ladi
  // (`releaseInvoiceAllocations` uni nolga tushiradi va pulni depozitga
  // qaytaradi), lekin tiklashdan oldin yana tekshiriladi — pul tushgan
  // qatorning summasini qayta yozish taqsimotni yolg'onga aylantirardi.
  const restorable = new Map();
  const existingIds = new Set();

  for (const row of existing) {
    if (row.status === "cancelled" && !new Decimal(row.paidAmount).greaterThan(0)) {
      restorable.set(row.studentId, row);
    } else {
      existingIds.add(row.studentId);
    }
  }

  // ── 5. Qatorlarni yig'ish ─────────────────
  // Summa mantig'i `invoiceBuilder.service.js` da — qayta shakllantirish
  // ham AYNAN shuni chaqiradi. Ikkita mustaqil quruvchi bo'lsa, proratsiya
  // faqat bittasiga qo'shilib qolardi.
  const rows = [];
  // Bekordan qaytariladiganlar — JOYIDA yangilanadi, yangi qator
  // yaratilmaydi: bekor qilish izi tarixda bitta qatorda qolishi kerak
  // (`restoreInvoice` bilan bir xil mulohaza).
  const restores = [];
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
      resolved: byStudent.get(student.id),
      discounts: discountsByStudent.get(student.id) ?? [],
      periods: periodsByStudent.get(student.id) ?? [],
      monthOverride: overridesByStudent.get(student.id) ?? null,
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
    // Chegirma oyni butunlay yeb qo'ydi — bu ongli qabul qilingan qoida,
    // lekin JIM qolmasligi kerak: 0 so'mlik qator darhol "to'langan"
    // bo'lib yopiladi va qarzdorlar registrida umuman ko'rinmaydi.
    if (computed.wipedByDiscount) summary.wipedByDiscount += 1;

    const cancelled = restorable.get(student.id);

    if (cancelled) {
      // ⚠️ `studentId`/`month` yangilanmaydi — ular o'zgarmas kalit.
      // Bekor qilish izi esa TOZALANADI: qator endi amaldagi majburiyat.
      const { studentId: _s, month: _m, createdBy: _c, ...facts } = row;

      restores.push({
        id: cancelled.id,
        data: {
          ...facts,
          note: cancelled.note,
          cancelReason: "",
          cancelledAt: null,
          cancelledBy: null,
        },
      });
    } else {
      rows.push(row);
    }

    if (dryRun) {
      pushDetail(cancelled ? "wouldRestore" : "wouldCreate", {
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

  // ── 6b. Bekordan qaytarish ────────────────
  //
  // ⚠️ COMPARE-AND-SWAP: shart ichida `status: "cancelled"` va
  // `paidAmount: 0` turadi. Tekshiruv bilan yozuv orasida kassir to'lov
  // kiritib ulgursa yoki ikkinchi pass o'tib ketsa, bu yerda HECH NARSA
  // yozilmaydi — `count` 0 qaytadi va sanoq "allaqachon bor" ga o'tadi.
  // Modul bo'ylab bitta shakl (`finance.md` §8).
  if (!dryRun && restores.length > 0) {
    for (const part of chunk(restores, CHUNK_SIZE)) {
      const results = await prisma.$transaction(
        part.map((item) =>
          prisma.monthlyInvoice.updateMany({
            where: { id: item.id, status: "cancelled", paidAmount: 0 },
            data: item.data,
          }),
        ),
      );

      const done = results.reduce((sum, r) => sum + r.count, 0);
      summary.restored += done;
      summary.skipped.alreadyExists += part.length - done;
    }
  } else if (dryRun) {
    summary.restored = restores.length;
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
 * Ta'til oylari shunchaki `reason: "vacation"` qaytaradi.
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
