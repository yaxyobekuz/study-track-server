/**
 * AI YORDAMCHI — moliya (KIRIM) bo'limining amallari.
 *
 * Har bir amal ikki bosqichli: `prepare` hech narsa yozmasdan joriy holatni
 * o'qiydi, servis rad etadigan hamma narsani OLDINDAN tekshiradi va egaga
 * "nima bo'ladi" ni raqamlar bilan ko'rsatadi; `execute` esa ega tasdiqlagach
 * AYNAN HTTP controller chaqiradigan servis funksiyasini o'sha argumentlar
 * bilan chaqiradi.
 *
 * ⚠️ CONTROLLER DARVOZALARI EGA UCHUN DOIM OCHIQ (`req.user.role === owner`).
 * Shu sababli bu yerda yordamchining O'ZI yagona to'siq: o'tgan oyga yozish
 * faqat ega aniq so'raganda (`allowPastStart`) taklif qilinadi, qolgan
 * hollarda rad etiladi — kod (`studentTariff.createAssignment`) buni
 * tekshirmasa ham.
 *
 * ⚠️ KOD QOIDALAR HUJJATIDAN FARQ QILADI (`map/finance-income.md` §1):
 * tarif/chegirma yozuvlari hisob-fakturalarni darhol qayta hisoblaydi,
 * to'lov tushgan fakturani esa faqat summa OSHSA joyida tuzatadi; kunlik
 * moslashtirish passi ham shunday qiladi. Ko'rinishlar KODGA qarab yoziladi.
 *
 * ⚠️ HISOB-FAKTURA ID'SIGA TAYANILMAYDI: to'lanmagan faktura qayta
 * shakllantirilganda o'chirilib yangi id bilan yoziladi. Shuning uchun
 * faktura amallari `(studentId, month)` bo'yicha har safar qayta topiladi.
 */

const prisma = require("../../../config/prisma");
const platformPrisma = require("../../../config/platformPrisma");
const {
  defineAction,
  AiToolError,
  idSchema,
  monthSchema,
  daySchema,
  requireId,
  monthArg,
  dayArg,
  reqLike,
  formatMoneyUz,
  monthLabel,
  personName,
} = require("../assistant.toolkit");
const { ROLES } = require("../../../utils/constants");
const {
  currentMonthKey,
  prevMonth,
  nextMonth,
  parseDayDate,
  monthKeyOfDate,
  formatMonthRange,
  coveringMonthWhere,
  overlappingPeriodWhere,
  todayIsoTashkent,
  shiftIsoDays,
  parseRangeBound,
} = require("../../../helpers/month.helpers");
const { Decimal, formatAmount, parseAmount, sumAmounts } = require("../../../helpers/money.helpers");
const { allocateFifo } = require("../../../helpers/allocation.helpers");
const { resolveEnrollmentForMonth } = require("../../../helpers/enrollment.helpers");
const { formatDateUz, formatDateTimeUz } = require("../../../helpers/date.helpers");

const { getFinanceSettings } = require("../../settings.service");
const { computeMonthlyAmount, buildInvoiceRow } = require("../../invoiceBuilder.service");
const tariffResolutionService = require("../../tariffResolution.service");
const studentTariffService = require("../../studentTariff.service");
const studentDiscountService = require("../../studentDiscount.service");
const studentEnrollmentService = require("../../studentEnrollment.service");
const studentFinanceStatusService = require("../../studentFinanceStatus.service");
const studentMonthOverrideService = require("../../studentMonthOverride.service");
const studentAccountService = require("../../studentAccount.service");
const serviceCatalogService = require("../../service.service");
const vacationMonthService = require("../../vacationMonth.service");
const invoiceService = require("../../invoice.service");
const invoiceGenerationService = require("../../invoiceGeneration.service");
const paymentService = require("../../payment.service");
const paymentAccountService = require("../../paymentAccount.service");
const externalIncomeService = require("../../externalIncome.service");
const incomeCategoryService = require("../../incomeCategory.service");
const incomePlanService = require("../../incomePlan.service");
const debtReminderService = require("../../debtReminder.service");

const TOOLSET = "finance";

const END_REASON_LABELS = studentEnrollmentService.END_REASON_LABELS;
const END_REASONS = studentEnrollmentService.END_REASONS;

/** O'tgan oy bilan ishlash uchun ega aniq so'raganini bildiruvchi bayroq. */
const allowPastSchema = {
  type: "boolean",
  description:
    "Set true ONLY when the owner explicitly asked for a start in a past month. Past-month starts recompute already issued invoices.",
};

const noteSchema = (description) => ({ type: "string", maxLength: 300, description });

// ─────────────────────────────────────────────────────────────────────────
// Umumiy yordamchilar
// ─────────────────────────────────────────────────────────────────────────

/** Oylar ro'yxati yorlig'i — uzun ro'yxat kesiladi, lekin soni aytiladi. */
const monthsText = (months, max = 8) => {
  const labels = months.map((month) => monthLabel(month));
  if (labels.length <= max) return labels.join(", ");
  return `${labels.slice(0, max).join(", ")} va yana ${labels.length - max} ta`;
};

/** Davr yorlig'i: bir oylik davr "Avgust, 2026 — Avgust, 2026" emas, "Avgust, 2026". */
const periodText = (startMonth, endMonth) =>
  startMonth === endMonth ? monthLabel(startMonth) : formatMonthRange(startMonth, endMonth);

const namesText = (names, max = 10) =>
  names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} va yana ${names.length - max} ta`;

/**
 * O'quvchini yuklaydi. Controller yo'lida servis `NotFoundError` beradi;
 * bu yerda esa u egaga ko'rinishdan OLDIN aniq sabab bilan chiqadi.
 */
const loadStudent = async (studentId) => {
  const student = await prisma.user.findUnique({
    where: { id: requireId(studentId, "O'quvchi id") },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      role: true,
      isArchived: true,
      classes: { select: { class: { select: { name: true } } } },
    },
  });

  if (!student || student.role !== ROLES.STUDENT) {
    throw new AiToolError("O'quvchi topilmadi");
  }

  const name = personName(student);
  const className = student.classes[0]?.class?.name ?? null;

  return {
    id: student.id,
    name,
    isArchived: student.isArchived,
    target: className ? `${name} — ${className}` : name,
  };
};

const archivedWarning = (student) =>
  student.isArchived ? ["O'quvchi arxivlangan: unga yangi hisob-faktura yozilmaydi"] : [];

/**
 * Bitta o'quvchi-oy uchun summa hisoblashga kerakli hamma kirishlar.
 * `invoice.getMyFinance` va `regenerateInvoice` aynan shu manbalarni o'qiydi.
 */
const loadBillingContext = async (studentId, month) => {
  const [resolved, discounts, services, periods, monthOverride, settings, status, isVacation] =
    await Promise.all([
      tariffResolutionService.resolveForStudentMonth(studentId, month),
      studentDiscountService.resolveDiscountsForStudent(studentId, month),
      serviceCatalogService.resolveServicesForStudent(studentId, month),
      studentEnrollmentService.getPeriodsForStudent(studentId),
      studentMonthOverrideService.resolveOne(studentId, month),
      getFinanceSettings(),
      studentFinanceStatusService.resolveStatusForStudent(studentId, month),
      vacationMonthService.isVacationMonth(month),
    ]);

  return { month, resolved, discounts, services, periods, monthOverride, settings, status, isVacation };
};

/**
 * Oylik summa — YAGONA quruvchi (`computeMonthlyAmount`) orqali. Faraziy
 * narx yoki chegirmalar berilsa "keyin" ko'rinishi hisoblanadi.
 *
 * @returns {object|null} null — narx yo'q (tarif biriktirilmagan / narxsiz)
 */
const priceMonth = (billing, { baseAmount, discounts } = {}) => {
  const base = baseAmount !== undefined ? baseAmount : billing.resolved.total;
  if (base == null) return null;

  return computeMonthlyAmount({
    baseAmount: base,
    discounts: discounts ?? billing.discounts,
    services: billing.services,
    periods: billing.periods,
    month: billing.month,
    settings: billing.settings,
    monthOverride: billing.monthOverride,
  });
};

const amountText = (computed) => {
  if (!computed) return "Hisoblanmaydi (tarif yoki narx yo'q)";
  if (!computed.enrollment.enrolled) return "Hisoblanmaydi (o'qimaydi)";
  return formatMoneyUz(formatAmount(computed.amount));
};

/** Oy uchun hisob-faktura baribir yozilmasligini bildiruvchi holatlar. */
const billingWarnings = (billing) => {
  const label = monthLabel(billing.month);
  const warnings = [];
  if (billing.isVacation) warnings.push(`${label} — ta'til oyi: hisob-faktura yozilmaydi`);
  if (billing.status.status === "frozen") warnings.push(`${label} oyida o'quvchi muzlatilgan: hisob-faktura yozilmaydi`);
  if (!resolveEnrollmentForMonth(billing.periods, billing.month).enrolled) {
    warnings.push(`${label} oyida o'quvchining o'qish davri yo'q: hisob-faktura yozilmaydi`);
  }
  if (billing.monthOverride) {
    warnings.push(
      `${label} uchun qo'lda belgilangan summa bor (${formatMoneyUz(formatAmount(billing.monthOverride.amount))}) — tarif, chegirma va xizmatlar bu oyga ta'sir qilmaydi`,
    );
  }
  return warnings;
};

/**
 * Faraziy summa bo'yicha bitta hisob-fakturaga servislarning `autoRegen` i
 * (`regenerateInvoice(id, …, { skipIfUnchanged: true })`) AYNAN nima
 * qilishini aytadi. Mantiq servis bilan bir xil tartibda:
 *
 *   to'lov yo'q → o'qimaydi/tarif/narx yo'q bo'lsa servis xato beradi va
 *                 faktura ESKI summada qoladi; summa maydonlari teng bo'lsa
 *                 tegilmaydi; aks holda o'chirilib yangi summa bilan yoziladi.
 *   to'lov bor  → `amendPaidInvoice`: skip yoki teng summa — tegilmaydi;
 *                 yangi summa TO'LANGANDAN kam — tegilmaydi; aks holda joyida
 *                 tuzatiladi (KAMAYISHI ham mumkin, holat qayta hisoblanadi).
 *
 * @param {object} invoice - MonthlyInvoice qatori
 * @param {object|null} computed - `priceMonth` natijasi (null — narx yo'q)
 * @returns {{ changed: boolean, effect: string|null, warning: string|null }}
 */
const predictRealign = (invoice, computed) => {
  const label = monthLabel(invoice.month);
  const paid = new Decimal(invoice.paidAmount);
  const oldAmount = new Decimal(invoice.amount);
  const oldText = formatMoneyUz(formatAmount(oldAmount));
  const billable = Boolean(computed && computed.enrollment.enrolled);

  if (paid.greaterThan(0)) {
    if (!billable || computed.amount.equals(oldAmount)) {
      return { changed: false, effect: null, warning: null };
    }
    if (computed.amount.lessThan(paid)) {
      return {
        changed: false,
        effect: null,
        warning:
          `${label} hisob-fakturasiga ${formatMoneyUz(formatAmount(paid))} to'langan, yangi summa ` +
          `(${formatMoneyUz(formatAmount(computed.amount))}) undan kam — hisob-faktura O'ZGARMAYDI (${oldText}); ` +
          "ortiqcha to'lov masalasi alohida hal qilinadi",
      };
    }
    const debt = computed.amount.minus(paid);
    return {
      changed: true,
      effect:
        `${label}: to'lov tushgan hisob-faktura joyida tuzatiladi — ${oldText} → ` +
        `${formatMoneyUz(formatAmount(computed.amount))}, qarz ${formatMoneyUz(formatAmount(debt))} ` +
        `(${invoiceService.STATUS_LABELS[debt.greaterThan(0) ? "partial" : "paid"]})`,
      warning: null,
    };
  }

  if (!billable) {
    return {
      changed: false,
      effect: null,
      warning: `${label} uchun yangi holatda narx yoki o'qish davri yo'q — mavjud hisob-faktura avtomatik qayta yozilmaydi va ${oldText} bo'lib qoladi`,
    };
  }
  const unchanged =
    computed.amount.equals(oldAmount) &&
    computed.baseAmount.equals(invoice.baseAmount) &&
    computed.proratedAmount.equals(invoice.proratedAmount ?? invoice.baseAmount) &&
    computed.discountAmount.equals(invoice.discountAmount ?? 0);
  if (unchanged) return { changed: false, effect: null, warning: null };

  return {
    changed: true,
    effect:
      `${label}: to'lanmagan hisob-faktura qayta yoziladi — ${oldText} → ${formatMoneyUz(formatAmount(computed.amount))}` +
      (computed.amount.isZero() ? " (0 so'm — darhol \"to'langan\" bo'ladi)" : ""),
    warning: null,
  };
};

/** Bir chaqiruvda aniq bashorat qilinadigan hisob-fakturalar chegarasi. */
const MAX_PREDICTED_INVOICES = 24;

/**
 * Servislarning `autoRegen` i (`regenerateForStudents`, oraliq
 * `[min(fromMonth, joriy), joriy]`, bekor qilinganlar chetda) har bir
 * hisob-fakturaga nima qilishini `computeAfter(billing)` faraziy summasi
 * bo'yicha aytadi. Juda ko'p bo'lsa — aniq, lekin umumiy matn.
 *
 * @returns {Promise<{effects: string[], warnings: string[]}>}
 */
const predictRegeneration = async (studentId, fromMonth, computeAfter) => {
  const now = currentMonthKey();
  const invoices = await prisma.monthlyInvoice.findMany({
    where: {
      studentId,
      month: { gte: Math.min(fromMonth, now), lte: now },
      status: { in: ["unpaid", "partial", "paid"] },
    },
    orderBy: { month: "asc" },
  });

  if (invoices.length === 0) return { effects: [], warnings: [] };

  if (invoices.length > MAX_PREDICTED_INVOICES) {
    return {
      effects: [
        `${monthsText(invoices.map((i) => i.month))} hisob-fakturalari joriy qoidalar bo'yicha darhol qayta hisoblanadi: ` +
          "o'zgargan to'lanmaganlari qayta yoziladi, to'lov tushganlari esa yangi summa to'langan summadan kam bo'lmasagina joyida tuzatiladi (kamayishi ham mumkin)",
      ],
      warnings: [],
    };
  }

  const effects = [];
  const warnings = [];
  const unchanged = [];
  for (const invoice of invoices) {
    const billing = await loadBillingContext(studentId, invoice.month);
    const outcome = predictRealign(invoice, computeAfter(billing));
    if (outcome.effect) effects.push(outcome.effect);
    if (outcome.warning) warnings.push(outcome.warning);
    if (!outcome.changed && !outcome.warning) unchanged.push(invoice.month);
  }
  if (unchanged.length > 0 && effects.length + warnings.length > 0) {
    effects.push(`${monthsText(unchanged)} ${unchanged.length === 1 ? "hisob-fakturasi" : "hisob-fakturalari"} o'zgarmaydi`);
  }

  return { effects, warnings };
};

/**
 * Yangi tarif biriktirilgach HALI HISOB-FAKTURASI YO'Q oylardan qaysilari
 * kunlik avtomatik shakllantirishda (`runInvoiceGenerationPass`: joriy oy va
 * `catchUpMonths` orqaga, `firstInvoiceMonth` dan oldin emas) yoziladi.
 * Bekor qilingan qator ham shu passda tiklanadi. O'quvchi arxivlangan, ta'til,
 * muzlatilgan, o'qimaydigan va narxsiz oylar generatsiyada tashlab ketiladi.
 *
 * @returns {Promise<string[]>} effekt satrlari
 */
const describeUpcomingGeneration = async (student, fromMonth, endMonth, computeAfter) => {
  if (student.isArchived) return [];

  const now = currentMonthKey();
  const settings = await getFinanceSettings();
  let windowStart = now;
  for (let i = 0; i < settings.catchUpMonths; i += 1) windowStart = prevMonth(windowStart);

  const start = Math.max(fromMonth, windowStart, settings.firstInvoiceMonth ?? 0);
  const end = Math.min(endMonth ?? now, now);
  if (start > end) return [];

  const live = await prisma.monthlyInvoice.findMany({
    where: { studentId: student.id, month: { gte: start, lte: end }, status: { not: "cancelled" } },
    select: { month: true },
  });
  const liveMonths = new Set(live.map((row) => row.month));

  const rows = [];
  for (let month = start; month <= end; month = nextMonth(month)) {
    if (liveMonths.has(month)) continue;
    const billing = await loadBillingContext(student.id, month);
    if (billing.isVacation || billing.status.status === "frozen") continue;
    const computed = computeAfter(billing);
    if (!computed || !computed.enrollment.enrolled) continue;
    rows.push(`${monthLabel(month)} (${formatMoneyUz(formatAmount(computed.amount))})`);
  }

  if (rows.length === 0) return [];

  return [
    settings.autoGenerateEnabled
      ? `Hisob-fakturasi hali yo'q oylar kunlik avtomatik shakllantirishda (oyning ${settings.invoiceDayOfMonth}-kunidan) yangi tarif bo'yicha yoziladi: ${namesText(rows, 12)}`
      : `Avtomatik shakllantirish o'chirilgan — hisob-fakturasi yo'q oylar faqat qo'lda shakllantirilganda yoziladi: ${namesText(rows, 12)}`,
  ];
};

/**
 * Kun ("YYYY-MM-DD") → servisga beriladigan pul harakati vaqti.
 * Bugun yoki bo'sh — `null` (servis "hozir" ni oladi); o'tgan kun —
 * Toshkent tush payti, kun hech bir taymzonada siljimasligi uchun.
 */
const recordedAtParam = (day, today, subject) => {
  if (!day || day === today) return null;
  const iso = dayArg(day, "Sana");
  if (iso > today) throw new AiToolError(`Kelajakdagi sana bilan ${subject} qayd etib bo'lmaydi`);
  return `${iso}T12:00:00.000+05:00`;
};

const recordedAtLabel = (value) => (value ? formatDateUz(value) : "Hozir (tasdiqlangan payt)");

/** 0 so'mlik individual narx — grant: faktura darhol "to'langan", `wipedByDiscount` ham sanamaydi. */
const ZERO_CUSTOM_WARNING =
  "Individual narx 0 so'm: har oyning hisob-fakturasi darhol \"to'langan\" bo'lib yopiladi va qarzdorlar ro'yxatida ham, chegirma hisobotida ham ko'rinmaydi";

/** Hisob-fakturani `(studentId, month)` bo'yicha topadi. */
const findInvoice = (studentId, month) =>
  prisma.monthlyInvoice.findUnique({ where: { studentId_month: { studentId, month } } });

// ─────────────────────────────────────────────────────────────────────────
// 1. Tarif biriktirish
// ─────────────────────────────────────────────────────────────────────────

const assignStudentTariff = defineAction({
  type: "finance.assign_tariff",
  toolName: "propose_assign_student_tariff",
  toolset: TOOLSET,
  title: "O'quvchiga tarif biriktirish",
  risk: "high",
  permission: "tariffs.assign",
  description:
    "Propose assigning a tariff to a student who has NO tariff for that period (use propose_change_student_tariff when a tariff already covers the month). startMonth defaults to the current month; a past startMonth is refused unless allowPastStart is true because it recomputes issued invoices. Optional individual monthly price (customAmount) overrides the catalog price. The preview shows the resulting monthly amount and which invoices are recomputed.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId", "tariffId"],
    properties: {
      studentId: idSchema("Student user id."),
      tariffId: idSchema("Tariff id from finance_catalog."),
      startMonth: monthSchema("First month of the assignment, YYYYMM. Omit for the current month."),
      endMonth: monthSchema("Last month (inclusive), YYYYMM. Omit for an open-ended assignment."),
      customAmount: {
        type: "number",
        minimum: 0,
        description: "Individual monthly price in so'm instead of the catalog price. Omit to use the catalog price.",
      },
      note: noteSchema("Short reason stored on the assignment."),
      allowPastStart: allowPastSchema,
    },
  },
  async prepare(args) {
    const student = await loadStudent(args.studentId);
    const tariffId = requireId(args.tariffId, "Tarif id");
    const now = currentMonthKey();
    const startMonth = monthArg(args.startMonth, "Boshlanish oyi");
    const endMonth = args.endMonth != null ? monthArg(args.endMonth, "Tugash oyi") : null;

    if (endMonth != null && endMonth < startMonth) {
      throw new AiToolError("Tugash oyi boshlanish oyidan oldin bo'lishi mumkin emas");
    }
    if (startMonth < now && args.allowPastStart !== true) {
      throw new AiToolError(
        `${monthLabel(startMonth)} — o'tgan oy. O'tgan oydan tarif biriktirish chiqarilgan hisob-fakturalarni qayta hisoblaydi, shuning uchun faqat ega buni aniq so'raganda taklif qilinadi`,
      );
    }

    const tariff = await platformPrisma.tariff.findUnique({
      where: { id: tariffId },
      select: { id: true, name: true, isActive: true, isArchived: true },
    });
    if (!tariff) throw new AiToolError("Tarif topilmadi");
    if (tariff.isArchived) throw new AiToolError("Arxivlangan tarifni biriktirib bo'lmaydi");

    const customAmount = args.customAmount != null ? formatAmount(parseAmount(args.customAmount, "Individual narx")) : null;

    const conflict = await prisma.studentTariff.findFirst({
      where: { studentId: student.id, ...overlappingPeriodWhere(startMonth, endMonth) },
      orderBy: { startMonth: "asc" },
    });
    if (conflict) {
      const conflictTariff = await platformPrisma.tariff.findUnique({
        where: { id: conflict.tariffId },
        select: { name: true },
      });
      throw new AiToolError(
        `O'quvchida bu davr uchun "${conflictTariff?.name ?? "Noma'lum"}" tarifi biriktirilgan (${periodText(
          conflict.startMonth,
          conflict.endMonth,
        )}). Tarifni almashtirish kerak bo'lsa, almashtirish amalini taklif qiling`,
      );
    }

    // Ko'rinish oyi — davr ICHIDAGI eng dolzarb oy: kelajakdan boshlansa
    // o'sha oy, butunlay o'tgan davr bo'lsa uning oxirgi oyi, aks holda joriy
    // oy (qolgan o'tgan oylar qayta hisoblash effektida aytiladi).
    const previewMonth =
      startMonth >= now ? startMonth : endMonth != null && endMonth < now ? endMonth : now;
    const [versions, billing] = await Promise.all([
      platformPrisma.tariffVersion.findMany({ where: { tariffId }, orderBy: { startMonth: "desc" } }),
      loadBillingContext(student.id, previewMonth),
    ]);

    // `tariffResolution` qoidasi: narx versiyasi bo'lmasa individual narx ham
    // qo'llanmaydi (sabab `no_price`, hisob-faktura yozilmaydi).
    const versionFor = (month) =>
      versions.find((v) => v.startMonth <= month && (v.endMonth == null || v.endMonth >= month)) ?? null;
    const baseFor = (month) => {
      const version = versionFor(month);
      if (!version) return null;
      return customAmount ?? formatAmount(version.monthlyAmount);
    };
    const inPeriod = (month) => month >= startMonth && (endMonth == null || month <= endMonth);
    const computeAfter = (monthBilling) => {
      if (!inPeriod(monthBilling.month)) return priceMonth(monthBilling);
      const base = baseFor(monthBilling.month);
      return base != null ? priceMonth(monthBilling, { baseAmount: base }) : null;
    };

    const startVersion = versionFor(startMonth);
    const previewVersion = versionFor(previewMonth);
    const after = computeAfter(billing);

    const warnings = [...archivedWarning(student)];
    if (!startVersion) {
      warnings.push(
        `"${tariff.name}" tarifida ${monthLabel(startMonth)} oyi uchun narx belgilanmagan — narx kiritilmaguncha hisob-faktura yozilmaydi` +
          (customAmount ? " (individual narx ham narx versiyasisiz qo'llanmaydi)" : ""),
      );
    } else if (!previewVersion) {
      warnings.push(
        `"${tariff.name}" tarifida ${monthLabel(previewMonth)} oyi uchun narx belgilanmagan — shu oy hisob-fakturasi yozilmaydi`,
      );
    }
    if (!tariff.isActive) warnings.push(`"${tariff.name}" tarifi nofaol deb belgilangan`);
    if (customAmount != null && new Decimal(customAmount).isZero()) warnings.push(ZERO_CUSTOM_WARNING);
    if (startMonth < now) {
      warnings.push(
        `Boshlanish ${monthLabel(startMonth)} — o'tgan oy: o'tgan oylar ham yangi tarif bo'yicha hisoblanadi (aniq oylar va summalar ta'sirlar ro'yxatida)`,
      );
    }
    warnings.push(...billingWarnings(billing));

    const regeneration = await predictRegeneration(student.id, startMonth, computeAfter);
    warnings.push(...regeneration.warnings);
    const effects = [
      ...regeneration.effects,
      ...(await describeUpcomingGeneration(student, startMonth, endMonth, computeAfter)),
    ];
    if (effects.length === 0) {
      effects.push("Biriktirishning o'zi hisob-faktura yaratmaydi: kerakli oylar kunlik avtomatik yoki qo'lda shakllantirishda yoziladi");
    }

    return {
      params: { studentId: student.id, tariffId, startMonth, endMonth, customAmount, note: args.note ?? "" },
      preview: {
        summary: `${student.name}ga "${tariff.name}" tarifi ${periodText(startMonth, endMonth)} biriktiriladi`,
        target: student.target,
        fields: [
          { label: "Tarif", before: billing.resolved.items[0]?.tariff?.name ?? "Biriktirilmagan", after: tariff.name },
          { label: "Davr", before: "—", after: periodText(startMonth, endMonth) },
          {
            label: `Oylik narx (${monthLabel(previewMonth)})`,
            before: "—",
            after: !previewVersion
              ? "Narx belgilanmagan"
              : customAmount
                ? `${formatMoneyUz(customAmount)} (individual)`
                : formatMoneyUz(formatAmount(previewVersion.monthlyAmount)),
          },
          {
            label: `To'lanadigan summa (${monthLabel(previewMonth)})`,
            before: amountText(priceMonth(billing)),
            after: amountText(after),
          },
        ],
        effects,
        warnings,
      },
    };
  },
  // Mirrors studentTariff.controller.createAssignment: createAssignment(req.body, req.user.id).
  async execute(params, ctx) {
    const result = await studentTariffService.createAssignment(params, ctx.user.id);
    const name = personName(result.student);

    return {
      summary: `${name}ga "${result.tariff?.name}" tarifi ${periodText(result.startMonth, result.endMonth)} biriktirildi`,
      details: result.warnings.map((warning) => ({ label: "Ogohlantirish", value: warning })),
      data: { assignmentId: result.id },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Tarifni almashtirish
// ─────────────────────────────────────────────────────────────────────────

/** `fromMonth` ni qamragan amaldagi biriktirish (tariffResolution qoidasi). */
const findCoveringAssignment = (studentId, month) =>
  prisma.studentTariff.findFirst({
    where: { studentId, ...coveringMonthWhere(month) },
    orderBy: { startMonth: "desc" },
  });

const changeStudentTariff = defineAction({
  type: "finance.change_tariff",
  toolName: "propose_change_student_tariff",
  toolset: TOOLSET,
  title: "O'quvchi tarifini almashtirish",
  risk: "high",
  permission: "tariffs.assign",
  description:
    "Propose switching a student's current tariff to another tariff from fromMonth (current month or later; past months cannot be changed). The existing assignment is closed at fromMonth-1 (or replaced if it starts in fromMonth) and the new one keeps its end month. Optional individual price. Preview shows before/after monthly amount and what happens to the fromMonth invoice (unpaid is rewritten; a paid/partial one is only amended upward).",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId", "tariffId"],
    properties: {
      studentId: idSchema("Student user id."),
      tariffId: idSchema("New tariff id from finance_catalog."),
      fromMonth: monthSchema("First month of the new tariff, YYYYMM (not earlier than the current month). Omit for the current month."),
      customAmount: {
        type: "number",
        minimum: 0,
        description: "Individual monthly price in so'm for the new tariff. Omit to use the catalog price.",
      },
      note: noteSchema("Short reason stored on the new assignment."),
    },
  },
  async prepare(args) {
    const student = await loadStudent(args.studentId);
    const tariffId = requireId(args.tariffId, "Tarif id");
    const now = currentMonthKey();
    const fromMonth = monthArg(args.fromMonth, "Boshlanish oyi");

    if (fromMonth < now) {
      throw new AiToolError(`Tarifni almashtirish ${monthLabel(now)} oyidan oldin boshlanishi mumkin emas`);
    }

    const assignment = await findCoveringAssignment(student.id, fromMonth);
    if (!assignment) {
      throw new AiToolError(
        `${monthLabel(fromMonth)} oyida o'quvchiga tarif biriktirilmagan — almashtirish emas, yangi tarif biriktirish kerak`,
      );
    }
    if (assignment.tariffId === tariffId) {
      throw new AiToolError("Yangi tarif joriy tarif bilan bir xil");
    }

    const [tariff, oldTariff] = await Promise.all([
      platformPrisma.tariff.findUnique({
        where: { id: tariffId },
        select: { id: true, name: true, isActive: true, isArchived: true },
      }),
      platformPrisma.tariff.findUnique({ where: { id: assignment.tariffId }, select: { name: true } }),
    ]);
    if (!tariff) throw new AiToolError("Tarif topilmadi");
    if (tariff.isArchived) throw new AiToolError("Arxivlangan tarifni biriktirib bo'lmaydi");

    const newPeriod = { startMonth: fromMonth, endMonth: assignment.endMonth };
    const conflict = await prisma.studentTariff.findFirst({
      where: {
        studentId: student.id,
        id: { not: assignment.id },
        ...overlappingPeriodWhere(newPeriod.startMonth, newPeriod.endMonth),
      },
    });
    if (conflict) {
      throw new AiToolError(
        `O'quvchida ${periodText(conflict.startMonth, conflict.endMonth)} uchun boshqa tarif biriktirilgan — yangi davr u bilan kesishadi`,
      );
    }

    const customAmount = args.customAmount != null ? formatAmount(parseAmount(args.customAmount, "Individual narx")) : null;

    const [version, billing, invoice] = await Promise.all([
      platformPrisma.tariffVersion.findFirst({
        where: { tariffId, ...coveringMonthWhere(fromMonth) },
        orderBy: { startMonth: "desc" },
      }),
      loadBillingContext(student.id, fromMonth),
      prisma.monthlyInvoice.findFirst({
        where: { studentId: student.id, month: fromMonth, status: { not: "cancelled" } },
      }),
    ]);

    // `tariffResolution`: versiya bo'lmasa individual narx ham qo'llanmaydi.
    const newBase = version ? customAmount ?? formatAmount(version.monthlyAmount) : null;
    const before = priceMonth(billing);
    const after = newBase != null ? priceMonth(billing, { baseAmount: newBase }) : null;
    const replaced = fromMonth === assignment.startMonth;
    const oldName = oldTariff?.name ?? "Noma'lum";

    const effects = [
      replaced
        ? `"${oldName}" biriktiruvi (${periodText(assignment.startMonth, assignment.endMonth)}) shu oydan boshlangani uchun o'chirilib, o'rniga yangisi yoziladi`
        : `"${oldName}" tarifi ${monthLabel(prevMonth(fromMonth))} bilan yopiladi`,
      `"${tariff.name}" tarifi ${periodText(fromMonth, assignment.endMonth)} amal qiladi`,
    ];

    const warnings = [...archivedWarning(student)];
    if (!version) {
      warnings.push(
        `"${tariff.name}" tarifida ${monthLabel(fromMonth)} uchun narx yo'q — hisob-faktura yozilmaydi` +
          (customAmount ? " (individual narx ham narx versiyasisiz qo'llanmaydi)" : ""),
      );
    }
    if (customAmount != null && new Decimal(customAmount).isZero()) warnings.push(ZERO_CUSTOM_WARNING);
    // `autoRegen` oralig'i joriy oy bilan tugaydi: kelajakdagi oydan
    // almashtirishda mavjud hisob-fakturaga tegilmaydi.
    if (invoice && invoice.month <= currentMonthKey()) {
      const outcome = predictRealign(invoice, after);
      if (outcome.effect) effects.push(outcome.effect);
      if (outcome.warning) warnings.push(outcome.warning);
      if (!outcome.changed && !outcome.warning) {
        effects.push(`${monthLabel(fromMonth)} hisob-fakturasi o'zgarmaydi (${formatMoneyUz(formatAmount(invoice.amount))})`);
      }
    } else if (!invoice && fromMonth === currentMonthKey() && after && after.enrollment.enrolled && !student.isArchived) {
      effects.push(
        `${monthLabel(fromMonth)} hisob-fakturasi hali yo'q — shakllantirilganda ${formatMoneyUz(formatAmount(after.amount))} bo'lib yoziladi`,
      );
    }
    warnings.push(...billingWarnings(billing));

    const preview = {
      summary: `${student.name}ning tarifi ${monthLabel(fromMonth)} dan "${oldName}" o'rniga "${tariff.name}" bo'ladi`,
      target: student.target,
      fields: [
        { label: "Tarif", before: oldName, after: tariff.name },
        {
          label: "Oylik narx",
          before: billing.resolved.total ? formatMoneyUz(billing.resolved.total) : "Narx belgilanmagan",
          after: !version
            ? "Narx belgilanmagan"
            : customAmount
              ? `${formatMoneyUz(customAmount)} (individual)`
              : formatMoneyUz(formatAmount(version.monthlyAmount)),
        },
        { label: `To'lanadigan summa (${monthLabel(fromMonth)})`, before: amountText(before), after: amountText(after) },
      ],
      effects,
      warnings,
    };

    return {
      params: { studentId: student.id, tariffId, fromMonth, customAmount, note: args.note ?? "" },
      preview,
      fingerprint: {
        preview,
        assignmentId: assignment.id,
        invoice: invoice && {
          id: invoice.id,
          status: invoice.status,
          amount: formatAmount(invoice.amount),
          paidAmount: formatAmount(invoice.paidAmount),
        },
      },
    };
  },
  // Mirrors studentTariff.controller.changeTariff: changeTariff(req.params.id, req.body, req.user.id).
  // Biriktirish id'si tasdiq paytida qayta topiladi (fingerprint o'zgarmaganini yadro tekshirgan).
  async execute(params, ctx) {
    const assignment = await findCoveringAssignment(params.studentId, params.fromMonth);
    if (!assignment) {
      throw new AiToolError(`${monthLabel(params.fromMonth)} oyini qamragan tarif biriktiruvi endi yo'q`);
    }

    const result = await studentTariffService.changeTariff(
      assignment.id,
      {
        tariffId: params.tariffId,
        fromMonth: params.fromMonth,
        customAmount: params.customAmount,
        note: params.note,
      },
      ctx.user.id,
    );

    return {
      summary: `${personName(result.created.student)}ning tarifi ${monthLabel(params.fromMonth)} dan "${result.created.tariff?.name}" ga almashtirildi`,
      details: result.warnings.map((warning) => ({ label: "Ogohlantirish", value: warning })),
      data: { assignmentId: result.created.id, replaced: result.replaced },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Chegirma biriktirish
// ─────────────────────────────────────────────────────────────────────────

const percentSum = (discounts) =>
  sumAmounts(discounts.filter((d) => d.type === "percent").map((d) => new Decimal(String(d.value))));

const attachStudentDiscount = defineAction({
  type: "finance.attach_discount",
  toolName: "propose_attach_student_discount",
  toolset: TOOLSET,
  title: "O'quvchiga chegirma biriktirish",
  risk: "high",
  permission: "discounts.assign",
  description:
    "Propose giving a student a catalog discount from startMonth (default current month; a past month only with allowPastStart). Checks what the service rejects: the same discount already covering the period, and exclusive (grant) discounts that cannot be combined. Percent discounts ADD UP (20% + 20% = 40%); a total of 100% makes the month free (invoice auto-paid, hidden from debtors) — flagged in warnings. Preview shows before/after monthly amount and invoices recomputed.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId", "discountId"],
    properties: {
      studentId: idSchema("Student user id."),
      discountId: idSchema("Discount id from finance_catalog."),
      startMonth: monthSchema("First month, YYYYMM. Omit for the current month."),
      endMonth: monthSchema("Last month (inclusive), YYYYMM. Omit for open-ended."),
      note: noteSchema("Short reason stored on the assignment."),
      allowPastStart: allowPastSchema,
    },
  },
  async prepare(args) {
    const student = await loadStudent(args.studentId);
    const discountId = requireId(args.discountId, "Chegirma id");
    const now = currentMonthKey();
    const startMonth = monthArg(args.startMonth, "Boshlanish oyi");
    const endMonth = args.endMonth != null ? monthArg(args.endMonth, "Tugash oyi") : null;

    if (endMonth != null && endMonth < startMonth) {
      throw new AiToolError("Tugash oyi boshlanish oyidan oldin bo'lishi mumkin emas");
    }
    if (startMonth < now && args.allowPastStart !== true) {
      throw new AiToolError(
        `${monthLabel(startMonth)} — o'tgan oy. O'tgan oydan chegirma berish chiqarilgan hisob-fakturalarni qayta hisoblaydi, shuning uchun faqat ega buni aniq so'raganda taklif qilinadi`,
      );
    }

    const discount = await platformPrisma.discount.findUnique({ where: { id: discountId } });
    if (!discount) throw new AiToolError("Chegirma topilmadi");
    if (discount.isArchived || !discount.isActive) {
      throw new AiToolError("Arxivlangan yoki nofaol chegirmani biriktirib bo'lmaydi");
    }

    const sameConflict = await prisma.studentDiscount.findFirst({
      where: { studentId: student.id, discountId, ...overlappingPeriodWhere(startMonth, endMonth) },
      orderBy: { startMonth: "asc" },
    });
    if (sameConflict) {
      throw new AiToolError(
        `"${discount.name}" chegirmasi o'quvchiga shu davr uchun allaqachon biriktirilgan (${periodText(
          sameConflict.startMonth,
          sameConflict.endMonth,
        )})`,
      );
    }

    const others = await prisma.studentDiscount.findMany({
      where: { studentId: student.id, discountId: { not: discountId }, ...overlappingPeriodWhere(startMonth, endMonth) },
      select: { discountId: true },
    });
    if (others.length > 0) {
      if (discount.isExclusive) {
        throw new AiToolError(
          `"${discount.name}" boshqa chegirmalar bilan birga berilmaydi, lekin o'quvchida shu davrda ${others.length} ta chegirma bor`,
        );
      }
      const exclusive = await platformPrisma.discount.findFirst({
        where: { id: { in: others.map((o) => o.discountId) }, isExclusive: true },
        select: { name: true },
      });
      if (exclusive) {
        throw new AiToolError(
          `O'quvchida shu davrda "${exclusive.name}" chegirmasi bor — u boshqa chegirmalar bilan birga berilmaydi`,
        );
      }
    }

    // Ko'rinish oyi davr ICHIDA bo'lishi shart: butunlay o'tgan davr uchun
    // joriy oyga chegirma qo'shib ko'rsatish yolg'on "keyin" summasi bo'lardi.
    const previewMonth =
      startMonth >= now ? startMonth : endMonth != null && endMonth < now ? endMonth : now;
    const billing = await loadBillingContext(student.id, previewMonth);
    const newDiscount = {
      id: discount.id,
      name: discount.name,
      type: discount.type,
      value: discount.value,
      isExclusive: discount.isExclusive,
    };
    const withNew = [...billing.discounts, newDiscount];
    const inPeriod = (month) => month >= startMonth && (endMonth == null || month <= endMonth);
    const computeAfter = (monthBilling) =>
      priceMonth(monthBilling, {
        discounts: inPeriod(monthBilling.month) ? [...monthBilling.discounts, newDiscount] : monthBilling.discounts,
      });

    const before = priceMonth(billing);
    const after = computeAfter(billing);
    const totalPercent = percentSum(withNew);
    const valueLabel =
      discount.type === "percent" ? `${Number(discount.value)}%` : formatMoneyUz(formatAmount(discount.value));

    const warnings = [...archivedWarning(student)];
    if (totalPercent.greaterThanOrEqualTo(100)) {
      warnings.push(
        `Foizli chegirmalar yig'indisi ${totalPercent.toFixed(0)}% bo'ladi: oy summasi 0 so'mga tushadi, hisob-faktura darhol "to'langan" bo'lib, qarzdorlar ro'yxatida ko'rinmaydi`,
      );
    } else if (after && after.wipedByDiscount) {
      warnings.push("Chegirmalardan keyin oy summasi 0 so'm bo'ladi va hisob-faktura darhol \"to'langan\" bo'ladi");
    }
    if (startMonth < now) {
      warnings.push(`Boshlanish ${monthLabel(startMonth)} — o'tgan oy: o'tgan oylar hisob-fakturalari ham qayta hisoblanishi mumkin (aniq o'zgarishlar ta'sirlar ro'yxatida)`);
    }
    if (!before) warnings.push(`${monthLabel(previewMonth)} uchun o'quvchida tarif narxi yo'q — chegirma hozircha summaga ta'sir qilmaydi`);
    warnings.push(...billingWarnings(billing));

    // `createAssignment` → `autoRegen([studentId], startMonth)`.
    const regeneration = await predictRegeneration(student.id, startMonth, computeAfter);
    warnings.push(...regeneration.warnings);

    return {
      params: { studentId: student.id, discountId, startMonth, endMonth, note: args.note ?? "" },
      preview: {
        summary: `${student.name}ga "${discount.name}" (${valueLabel}) chegirmasi ${periodText(startMonth, endMonth)} beriladi`,
        target: student.target,
        fields: [
          { label: "Chegirma", before: billing.discounts.map((d) => d.name).join(", ") || "Yo'q", after: withNew.map((d) => d.name).join(", ") },
          { label: "Foizli chegirmalar jami", before: `${percentSum(billing.discounts).toFixed(0)}%`, after: `${totalPercent.toFixed(0)}%` },
          { label: `To'lanadigan summa (${monthLabel(previewMonth)})`, before: amountText(before), after: amountText(after) },
        ],
        effects: regeneration.effects,
        warnings,
      },
    };
  },
  // Mirrors discount.controller.createAssignment: allowPast = assertPastAllowed(req, startMonth)
  // (ega uchun: startMonth < joriy oy), so'ng createAssignment(req.body, req.user.id, { allowPast }).
  async execute(params, ctx) {
    const result = await studentDiscountService.createAssignment(params, ctx.user.id, {
      allowPast: params.startMonth < currentMonthKey(),
    });

    return {
      summary: `${personName(result.student)}ga "${result.discount?.name}" chegirmasi ${result.periodLabel} biriktirildi`,
      data: { assignmentId: result.id },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Chegirmani yopish
// ─────────────────────────────────────────────────────────────────────────

const closeStudentDiscount = defineAction({
  type: "finance.close_discount",
  toolName: "propose_close_student_discount",
  toolset: TOOLSET,
  title: "O'quvchi chegirmasini tugatish",
  risk: "medium",
  permission: "discounts.assign",
  description:
    "Propose ending a student's discount: endMonth is the LAST month the discount still applies (default current month; cannot be before the current month for a discount already in effect). The discount must currently apply or be scheduled. Preview shows the monthly amount of the following month with and without the discount.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId", "discountId"],
    properties: {
      studentId: idSchema("Student user id."),
      discountId: idSchema("Discount id (see finance_student discounts)."),
      endMonth: monthSchema("Last month the discount applies (inclusive), YYYYMM. Omit for the current month."),
    },
  },
  async prepare(args) {
    const student = await loadStudent(args.studentId);
    const discountId = requireId(args.discountId, "Chegirma id");
    const now = currentMonthKey();
    const endMonth = monthArg(args.endMonth, "Tugash oyi");

    const rows = await prisma.studentDiscount.findMany({
      where: { studentId: student.id, discountId, OR: [{ endMonth: null }, { endMonth: { gte: now } }] },
      orderBy: { startMonth: "asc" },
    });
    if (rows.length === 0) throw new AiToolError("Bu chegirma o'quvchida amalda ham, rejada ham yo'q");
    if (rows.length > 1) {
      throw new AiToolError(
        `Bu chegirmaning bir nechta davri bor (${rows
          .map((row) => periodText(row.startMonth, row.endMonth))
          .join("; ")}) — qaysi davrni tugatish kerakligini aniqlang`,
      );
    }

    const row = rows[0];
    const discount = await platformPrisma.discount.findUnique({ where: { id: discountId }, select: { name: true } });
    const minEnd = row.startMonth <= now ? Math.max(now, row.startMonth) : row.startMonth;

    if (endMonth < minEnd) {
      throw new AiToolError(
        row.startMonth <= now
          ? `Amaldagi chegirmani ${monthLabel(minEnd)} dan oldin yopib bo'lmaydi`
          : "Tugash oyi boshlanish oyidan oldin bo'lishi mumkin emas",
      );
    }
    if (row.endMonth != null && endMonth >= row.endMonth) {
      throw new AiToolError(`Chegirma allaqachon ${monthLabel(row.endMonth)} bilan tugaydi`);
    }

    const afterMonth = nextMonth(endMonth);
    const billing = await loadBillingContext(student.id, afterMonth);
    const without = billing.discounts.filter((d) => d.id !== discountId);

    // `closeAssignment` → `autoRegen([studentId], row.startMonth)`: yopilgan
    // chegirma `endMonth >= joriy oy` gacha amal qilgani uchun bu oraliqdagi
    // summalar o'zgarmaydi — faqat qoidalardan chetlashgan fakturalar
    // tekislanadi va ular aniq ko'rsatiladi.
    const regeneration = await predictRegeneration(student.id, row.startMonth, (monthBilling) => priceMonth(monthBilling));

    return {
      params: { studentId: student.id, assignmentId: row.id, endMonth },
      preview: {
        summary: `${student.name}ning "${discount?.name ?? "Noma'lum"}" chegirmasi ${monthLabel(endMonth)} bilan tugaydi`,
        target: student.target,
        fields: [
          { label: "Davr", before: periodText(row.startMonth, row.endMonth), after: periodText(row.startMonth, endMonth) },
          {
            label: `To'lanadigan summa (${monthLabel(afterMonth)})`,
            before: amountText(priceMonth(billing)),
            after: amountText(priceMonth(billing, { discounts: without })),
          },
        ],
        effects: [
          `${monthLabel(afterMonth)} dan boshlab chegirma qo'llanmaydi`,
          ...regeneration.effects,
        ],
        warnings: [...billingWarnings(billing), ...regeneration.warnings],
      },
    };
  },
  // Mirrors discount.controller.closeAssignment: closeAssignment(req.params.id, req.body.endMonth).
  async execute(params) {
    const result = await studentDiscountService.closeAssignment(params.assignmentId, params.endMonth);

    return {
      summary: `${personName(result.student)}ning "${result.discount?.name}" chegirmasi ${monthLabel(params.endMonth)} bilan tugatildi`,
      data: { assignmentId: result.id, periodLabel: result.periodLabel },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 5. O'qish davrini yopish (maktabdan ketdi)
// ─────────────────────────────────────────────────────────────────────────

const closeStudentEnrollment = defineAction({
  type: "finance.close_enrollment",
  toolName: "propose_close_student_enrollment",
  toolset: TOOLSET,
  title: "O'quvchining o'qish davrini yopish",
  risk: "high",
  permission: "enrollment.update",
  description:
    "Propose recording that a student left the school: closes the student's open enrollment period at endDate (the LAST day studied, YYYY-MM-DD, required) with a leave category: left (own decision), expelled, graduated, transferred (to another branch). Exit is NOT prorated — the month of endDate is billed in full; no invoices are generated after it. Existing invoices for later months are NOT cancelled automatically: the preview lists them so the owner can cancel them separately.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId", "endDate", "endReason"],
    properties: {
      studentId: idSchema("Student user id."),
      endDate: daySchema("Last day the student studied, YYYY-MM-DD (inclusive)."),
      endReason: {
        type: "string",
        enum: END_REASONS,
        description: "left = left on own decision, expelled, graduated, transferred = moved to another branch.",
      },
      reason: noteSchema("Free-text explanation."),
    },
  },
  async prepare(args) {
    const student = await loadStudent(args.studentId);

    // ⚠️ TUZOQ: servis `endDate` siz chaqirilsa 200 qaytaradi-yu hech narsa
    // yopilmaydi. Sxema majburiy qiladi, bu yerda esa format ham qat'iy.
    if (!args.endDate) throw new AiToolError("Tugash sanasi majburiy");
    const endDate = parseDayDate(args.endDate, "Tugash sanasi");
    if (!END_REASONS.includes(args.endReason)) throw new AiToolError("Ketish sababi noto'g'ri");

    const periods = await studentEnrollmentService.getPeriodsForStudent(student.id);
    const open = periods.find((period) => period.endDate == null);
    if (!open) {
      throw new AiToolError(
        periods.length === 0 ? "O'quvchida o'qish davri yo'q" : "O'quvchida ochiq o'qish davri yo'q — u allaqachon ketgan deb qayd etilgan",
      );
    }
    if (endDate < open.startDate) {
      throw new AiToolError(
        `Tugash sanasi davr boshlanishidan (${formatDateUz(open.startDate, { utc: true })}) oldin bo'lishi mumkin emas`,
      );
    }

    const nextPeriods = periods.map((period) => (period.id === open.id ? { ...period, endDate } : period));
    const endMonth = monthKeyOfDate(endDate);

    const [invoices, balance, frozen] = await Promise.all([
      prisma.monthlyInvoice.findMany({
        where: { studentId: student.id, status: { not: "cancelled" } },
        select: { month: true, amount: true, paidAmount: true, status: true },
        orderBy: { month: "asc" },
      }),
      studentAccountService.getBalance(student.id),
      prisma.studentFinanceStatus.findMany({
        where: { studentId: student.id, status: "frozen", OR: [{ endMonth: null }, { endMonth: { gt: endMonth } }] },
        select: { startMonth: true, endMonth: true },
      }),
    ]);

    const extra = invoices.filter((invoice) => !resolveEnrollmentForMonth(nextPeriods, invoice.month).enrolled);

    const warnings = [];
    if (extra.length > 0) {
      const paidTotal = sumAmounts(extra.map((i) => new Decimal(i.paidAmount)));
      warnings.push(
        `Ketgandan keyingi oylar uchun hisob-faktura mavjud va avtomatik bekor qilinMAYDI: ${extra
          .map((i) => `${monthLabel(i.month)} (${formatMoneyUz(formatAmount(i.amount))})`)
          .join(", ")}. Ularni alohida bekor qilish kerak` +
          (paidTotal.greaterThan(0) ? `; bekor qilinsa ${formatMoneyUz(formatAmount(paidTotal))} depozitga qaytadi` : ""),
      );
    }
    if (balance.greaterThan(0)) {
      warnings.push(`O'quvchi depozitida ${formatMoneyUz(formatAmount(balance))} bor — qaytarish moliya bo'limi tomonidan alohida hal qilinadi`);
    }
    if (frozen.length > 0) {
      warnings.push("O'quvchida ketish sanasidan keyingi oylarni qamragan muzlatish yozuvi bor — u ortiqcha bo'lib qoladi");
    }
    if (args.endDate < todayIsoTashkent()) {
      warnings.push("Tugash sanasi o'tgan kun — tarix orqaga qarab yoziladi");
    }

    return {
      params: {
        studentId: student.id,
        enrollmentId: open.id,
        endDate: args.endDate,
        endReason: args.endReason,
        reason: args.reason ?? "",
      },
      preview: {
        summary: `${student.name}ning o'qish davri ${formatDateUz(endDate, { utc: true })} bilan yopiladi (${END_REASON_LABELS[args.endReason]})`,
        target: student.target,
        fields: [
          {
            label: "O'qish davri",
            before: `${formatDateUz(open.startDate, { utc: true })} dan (hozirgacha)`,
            after: `${formatDateUz(open.startDate, { utc: true })} — ${formatDateUz(endDate, { utc: true })}`,
          },
          { label: "Ketish sababi", before: "—", after: END_REASON_LABELS[args.endReason] },
        ],
        effects: [
          `${monthLabel(endMonth)} to'liq hisoblanadi (chiqishda proratsiya yo'q)`,
          `${monthLabel(nextMonth(endMonth))} dan boshlab yangi hisob-faktura yozilmaydi`,
        ],
        warnings,
      },
    };
  },
  // Mirrors studentEnrollment.controller.closeEnrollment:
  // closeEnrollment(req.params.id, req.body, { allowPast: canAdjust(req) }) — ega uchun true.
  async execute(params) {
    if (!params.endDate) throw new AiToolError("Tugash sanasi majburiy");

    const result = await studentEnrollmentService.closeEnrollment(
      params.enrollmentId,
      { endDate: params.endDate, endReason: params.endReason, reason: params.reason },
      { allowPast: true },
    );

    if (!result.endDate) {
      throw new AiToolError("O'qish davri yopilmadi — tugash sanasi saqlanmadi");
    }

    return {
      summary: `O'qish davri ${formatDateUz(result.endDate, { utc: true })} bilan yopildi (${result.endReasonLabel})`,
      details: result.warnings.map((warning) => ({ label: "Ogohlantirish", value: warning })),
      data: { enrollmentId: result.id },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 6–7. Muzlatish va muzlatishni bekor qilish
// ─────────────────────────────────────────────────────────────────────────

const freezeStudent = defineAction({
  type: "finance.freeze",
  toolName: "propose_freeze_student",
  toolset: TOOLSET,
  title: "O'quvchini muzlatish",
  risk: "medium",
  permission: "finance.status",
  description:
    "Propose freezing a student (temporary break inside the enrollment, e.g. long illness) for whole months from startMonth to endMonth: no invoices are generated for frozen months and there is no proration on return. startMonth defaults to the current month; a past month only with allowPastStart. Invoices already issued for those months are NOT cancelled — the preview lists them. For leaving the school use propose_close_student_enrollment instead.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId", "reason"],
    properties: {
      studentId: idSchema("Student user id."),
      startMonth: monthSchema("First frozen month, YYYYMM. Omit for the current month."),
      endMonth: monthSchema("Last frozen month (inclusive), YYYYMM. Omit for an open-ended freeze."),
      reason: { type: "string", minLength: 3, maxLength: 300, description: "Why the student is frozen." },
      allowPastStart: allowPastSchema,
    },
  },
  async prepare(args) {
    const student = await loadStudent(args.studentId);
    const now = currentMonthKey();
    const startMonth = monthArg(args.startMonth, "Boshlanish oyi");
    const endMonth = args.endMonth != null ? monthArg(args.endMonth, "Tugash oyi") : null;

    if (endMonth != null && endMonth < startMonth) {
      throw new AiToolError("Tugash oyi boshlanish oyidan oldin bo'lishi mumkin emas");
    }
    if (startMonth < now && args.allowPastStart !== true) {
      throw new AiToolError(
        `${monthLabel(startMonth)} — o'tgan oy. O'tgan oydan muzlatish faqat ega buni aniq so'raganda taklif qilinadi`,
      );
    }

    const conflict = await prisma.studentFinanceStatus.findFirst({
      where: { studentId: student.id, ...overlappingPeriodWhere(startMonth, endMonth) },
      orderBy: { startMonth: "asc" },
    });
    if (conflict) {
      throw new AiToolError(
        `O'quvchida bu davr uchun boshqa holat belgilangan (${conflict.status === "frozen" ? "Muzlatilgan" : "Faol"}, ${periodText(
          conflict.startMonth,
          conflict.endMonth,
        )})`,
      );
    }

    const [invoices, periods] = await Promise.all([
      prisma.monthlyInvoice.findMany({
        where: {
          studentId: student.id,
          status: { not: "cancelled" },
          month: { gte: startMonth, ...(endMonth != null ? { lte: endMonth } : {}) },
        },
        select: { month: true, status: true },
        orderBy: { month: "asc" },
      }),
      studentEnrollmentService.getPeriodsForStudent(student.id),
    ]);

    const warnings = [...archivedWarning(student)];
    if (invoices.length > 0) {
      warnings.push(
        `${monthsText(invoices.map((i) => i.month))} uchun hisob-faktura allaqachon shakllangan — u avtomatik bekor qilinmaydi; kerak bo'lsa alohida bekor qiling`,
      );
    }
    if (!resolveEnrollmentForMonth(periods, startMonth).enrolled) {
      warnings.push(
        `${monthLabel(startMonth)} oyida o'quvchining o'qish davri yo'q — muzlatish davr ichidagi tanaffus uchun; maktabdan ketgan bo'lsa davrni yopish kerak`,
      );
    }
    if (startMonth < now) warnings.push(`Boshlanish ${monthLabel(startMonth)} — o'tgan oy`);

    return {
      params: { studentId: student.id, startMonth, endMonth, reason: args.reason },
      preview: {
        summary: `${student.name} ${periodText(startMonth, endMonth)} muzlatiladi`,
        target: student.target,
        fields: [
          { label: "Holat", before: "Faol", after: "Muzlatilgan" },
          { label: "Davr", before: "—", after: periodText(startMonth, endMonth) },
          { label: "Sabab", before: "—", after: args.reason },
        ],
        effects: ["Muzlatilgan oylar uchun yangi hisob-faktura yozilmaydi", "Qaytganda kirish proratsiyasi qo'llanmaydi"],
        warnings,
      },
    };
  },
  // Mirrors studentFinanceStatus.controller.createStatus:
  // allowPast = resolveAllowPast(req, startMonth) (ega uchun: startMonth < joriy oy),
  // createStatus(req.body, req.user.id, { allowPast }).
  async execute(params, ctx) {
    const result = await studentFinanceStatusService.createStatus(
      {
        studentId: params.studentId,
        status: "frozen",
        startMonth: params.startMonth,
        endMonth: params.endMonth,
        reason: params.reason,
      },
      ctx.user.id,
      { allowPast: params.startMonth < currentMonthKey() },
    );

    return {
      summary: `${personName(result.student)} ${periodText(result.startMonth, result.endMonth)} muzlatildi`,
      details: result.warnings.map((warning) => ({ label: "Ogohlantirish", value: warning })),
      data: { statusId: result.id },
    };
  },
});

const unfreezeStudent = defineAction({
  type: "finance.unfreeze",
  toolName: "propose_unfreeze_student",
  toolset: TOOLSET,
  title: "O'quvchini muzlatishdan chiqarish",
  risk: "medium",
  permission: "finance.status",
  description:
    "Propose ending a student's freeze so billing resumes from resumeMonth (the first billable month). Default resumeMonth is NEXT month (the current month stays frozen); pass the current month only when the owner wants the current month billed too. resumeMonth cannot be in the past. A freeze that starts in resumeMonth or later cannot be removed through the assistant.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId"],
    properties: {
      studentId: idSchema("Student user id."),
      resumeMonth: monthSchema("First month billed again, YYYYMM (current month or later). Omit for next month."),
      reason: noteSchema("Short reason (stored when billing resumes in the current month)."),
    },
  },
  async prepare(args) {
    const student = await loadStudent(args.studentId);
    const now = currentMonthKey();
    const resumeMonth = args.resumeMonth != null ? monthArg(args.resumeMonth, "Qayta boshlanish oyi") : nextMonth(now);

    if (resumeMonth < now) {
      throw new AiToolError("Muzlatishni o'tgan oydan bekor qilib bo'lmaydi");
    }

    const row = await prisma.studentFinanceStatus.findFirst({
      where: {
        studentId: student.id,
        status: "frozen",
        startMonth: { lt: resumeMonth },
        OR: [{ endMonth: null }, { endMonth: { gte: resumeMonth } }],
      },
      orderBy: { startMonth: "desc" },
    });

    if (!row) {
      const later = await prisma.studentFinanceStatus.findFirst({
        where: { studentId: student.id, status: "frozen", startMonth: { gte: resumeMonth } },
        orderBy: { startMonth: "asc" },
      });
      throw new AiToolError(
        later
          ? `Muzlatish ${monthLabel(later.startMonth)} dan boshlanadi — ${monthLabel(resumeMonth)} dan oldin boshlanmagan muzlatishni yordamchi orqali olib tashlab bo'lmaydi`
          : `${monthLabel(resumeMonth)} oyida o'quvchi muzlatilmagan`,
      );
    }

    const mode = resumeMonth === now ? "change" : "close";
    const effects =
      mode === "change"
        ? [
            `Muzlatish ${monthLabel(prevMonth(now))} bilan yopiladi va "Faol" holat yoziladi: ${periodText(now, row.endMonth)}`,
            `${monthLabel(now)} hisob-fakturasi kunlik avtomatik shakllantirishda yoki qo'lda shakllantirishda yoziladi`,
          ]
        : [
            `Muzlatish ${monthLabel(prevMonth(resumeMonth))} bilan tugaydi`,
            `${monthLabel(resumeMonth)} dan boshlab hisob-faktura yana yoziladi`,
          ];

    return {
      params: { studentId: student.id, statusId: row.id, mode, resumeMonth, reason: args.reason ?? "" },
      preview: {
        summary: `${student.name} ${monthLabel(resumeMonth)} dan muzlatishdan chiqariladi`,
        target: student.target,
        fields: [
          {
            label: "Muzlatish davri",
            before: periodText(row.startMonth, row.endMonth),
            after: periodText(row.startMonth, prevMonth(resumeMonth)),
          },
        ],
        effects,
        warnings: archivedWarning(student),
      },
    };
  },
  // mode "close"  → studentFinanceStatus.controller.closeStatus: closeStatus(req.params.id, req.body.endMonth).
  // mode "change" → studentFinanceStatus.controller.changeStatus: changeStatus(req.params.id, req.body, req.user.id).
  async execute(params, ctx) {
    if (params.mode === "change") {
      const result = await studentFinanceStatusService.changeStatus(
        params.statusId,
        { status: "active", fromMonth: params.resumeMonth, reason: params.reason },
        ctx.user.id,
      );
      return {
        summary: `${personName(result.created.student)} ${monthLabel(params.resumeMonth)} dan muzlatishdan chiqarildi`,
        data: { closedStatusId: result.closed.id, activeStatusId: result.created.id },
      };
    }

    const result = await studentFinanceStatusService.closeStatus(params.statusId, prevMonth(params.resumeMonth));
    return {
      summary: `${personName(result.student)}ning muzlatishi ${result.endMonthLabel} bilan tugatildi`,
      data: { statusId: result.id },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 8–10. Hisob-fakturalar
// ─────────────────────────────────────────────────────────────────────────

const invoiceTarget = (student, month) => `${student.target} · ${monthLabel(month)}`;

const cancelInvoice = defineAction({
  type: "finance.cancel_invoice",
  toolName: "propose_cancel_invoice",
  toolset: TOOLSET,
  title: "Hisob-fakturani bekor qilish",
  risk: "high",
  permission: "finance.cancel",
  description:
    "Propose cancelling one student's invoice for one month (reason required). Money already paid on it is returned to the student's deposit (not to cash). Warning: if the student is still billable for that month (enrolled, not frozen, has a priced tariff, not a vacation month) the next invoice generation RESTORES the invoice — durable removal needs fixing the cause (close enrollment, freeze, vacation).",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId", "month", "reason"],
    properties: {
      studentId: idSchema("Student user id."),
      month: monthSchema("Invoice month, YYYYMM."),
      reason: { type: "string", minLength: 3, maxLength: 300, description: "Why the invoice is cancelled." },
    },
  },
  async prepare(args) {
    const student = await loadStudent(args.studentId);
    const month = monthArg(args.month);
    const now = currentMonthKey();

    const invoice = await findInvoice(student.id, month);
    if (!invoice) throw new AiToolError(`${monthLabel(month)} uchun hisob-faktura yo'q`);
    if (invoice.status === "cancelled") throw new AiToolError("Hisob-faktura allaqachon bekor qilingan");

    const billing = await loadBillingContext(student.id, month);
    const paid = new Decimal(invoice.paidAmount);
    const settings = billing.settings;

    const stillBillable =
      !student.isArchived &&
      !billing.isVacation &&
      billing.status.status !== "frozen" &&
      billing.resolved.reason == null &&
      resolveEnrollmentForMonth(billing.periods, month).enrolled &&
      (settings.firstInvoiceMonth == null || month >= settings.firstInvoiceMonth);

    let windowStart = now;
    for (let i = 0; i < settings.catchUpMonths; i += 1) windowStart = prevMonth(windowStart);
    const autoRestores = settings.autoGenerateEnabled && month >= windowStart;

    const warnings = [];
    if (stillBillable) {
      warnings.push(
        (autoRestores
          ? "O'quvchi bu oy uchun hali ham to'lovchi (o'qiydi, tarifi bor, muzlatilmagan): kunlik avtomatik shakllantirish hisob-fakturani QAYTA TIKLAYDI. Doimiy olib tashlash uchun sababni tuzating (davrni yopish yoki muzlatish)"
          : "O'quvchi bu oy uchun hali ham to'lovchi: keyingi qo'lda shakllantirishda hisob-faktura qayta tiklanadi") +
          // `generateForMonth` depozitni faqat YANGI yaratilgan qatorlarga qo'llaydi, tiklanganlarga emas
          (paid.greaterThan(0) ? "; tiklangan hisob-faktura to'lanmagan holda qaytadi, depozitdagi pul unga avtomatik qo'llanmaydi" : ""),
      );
    }
    if (month < now) warnings.push(`${monthLabel(month)} — o'tgan oy: tarix qayta yoziladi`);

    const effects = ["Hisob-faktura \"Bekor qilingan\" holatiga o'tadi va qarzdan chiqadi"];
    if (paid.greaterThan(0)) {
      effects.push(`To'langan ${formatMoneyUz(formatAmount(paid))} o'quvchi depozitiga qaytadi (kassadan pul chiqmaydi)`);
    }

    return {
      params: { studentId: student.id, month, reason: args.reason },
      preview: {
        summary: `${student.name}ning ${monthLabel(month)} hisob-fakturasi bekor qilinadi`,
        target: invoiceTarget(student, month),
        fields: [
          { label: "Holat", before: invoiceService.STATUS_LABELS[invoice.status], after: "Bekor qilingan" },
          { label: "Summa", before: formatMoneyUz(formatAmount(invoice.amount)), after: formatMoneyUz(formatAmount(invoice.amount)) },
          { label: "Qarz", before: formatMoneyUz(formatAmount(new Decimal(invoice.amount).minus(paid))), after: "0 so'm" },
          { label: "Depozitga qaytadi", before: "—", after: formatMoneyUz(formatAmount(paid)) },
        ],
        effects,
        warnings,
      },
    };
  },
  // Mirrors invoice.controller.cancelInvoice: getInvoiceById(id) (o'tgan oy darvozasi ega
  // uchun ochiq), so'ng cancelInvoice(req.params.id, req.body.reason, req.user.id).
  // Id `(studentId, month)` bo'yicha qayta topiladi — qayta shakllantirish uni almashtirgan bo'lishi mumkin.
  async execute(params, ctx) {
    const found = await findInvoice(params.studentId, params.month);
    if (!found) throw new AiToolError(`${monthLabel(params.month)} uchun hisob-faktura endi yo'q`);
    if (found.status === "cancelled") throw new AiToolError("Hisob-faktura allaqachon bekor qilingan");

    await invoiceService.getInvoiceById(found.id);
    const result = await invoiceService.cancelInvoice(found.id, params.reason, ctx.user.id);

    return {
      summary: `${result.studentName}ning ${result.monthLabel} hisob-fakturasi bekor qilindi`,
      details: [
        { label: "Depozitga qaytdi", value: formatMoneyUz(result.releasedToDeposit) },
        ...(result.warnings ?? []).map((warning) => ({ label: "Ogohlantirish", value: warning })),
      ],
      data: { invoiceId: result.id, releasedToDeposit: result.releasedToDeposit },
    };
  },
});

const regenerateInvoice = defineAction({
  type: "finance.regenerate_invoice",
  toolName: "propose_regenerate_invoice",
  toolset: TOOLSET,
  title: "Hisob-fakturani qayta hisoblash",
  risk: "high",
  permission: "finance.adjust",
  description:
    "Propose recomputing one student's invoice for one month from the CURRENT tariff, discounts, services and enrollment (reason required), e.g. after a late discount or a price fix. An unpaid invoice is deleted and re-created (new invoice id). An invoice with payments is amended in place only if the new amount is not lower than what is already paid (a paid invoice can become partially paid). Refused when nothing would change or the student is not billable that month. Cancelled invoices are not handled here (use propose_generate_invoices to restore them).",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId", "month", "reason"],
    properties: {
      studentId: idSchema("Student user id."),
      month: monthSchema("Invoice month, YYYYMM."),
      reason: { type: "string", minLength: 3, maxLength: 300, description: "Why the invoice is recomputed." },
    },
  },
  async prepare(args, ctx) {
    const student = await loadStudent(args.studentId);
    const month = monthArg(args.month);

    const invoice = await findInvoice(student.id, month);
    if (!invoice) throw new AiToolError(`${monthLabel(month)} uchun hisob-faktura yo'q`);
    if (invoice.status === "cancelled") {
      throw new AiToolError("Hisob-faktura bekor qilingan — uni tiklash uchun oyni shakllantirish amalidan foydalaning");
    }

    const billing = await loadBillingContext(student.id, month);
    // `regenerateInvoice` / `amendPaidInvoice` aynan shu quruvchini chaqiradi.
    const { row, skip, computed } = buildInvoiceRow({
      student: { id: student.id },
      month,
      settings: billing.settings,
      resolved: billing.resolved,
      discounts: billing.discounts,
      services: billing.services,
      periods: billing.periods,
      monthOverride: billing.monthOverride,
      source: "manual",
      actorId: ctx.user.id,
      studentSnapshot: invoice.studentSnapshot,
    });

    const paid = new Decimal(invoice.paidAmount);
    const oldAmount = new Decimal(invoice.amount);

    if (paid.greaterThan(0)) {
      if (skip) {
        throw new AiToolError("To'lov tushgan hisob-faktura o'zgarmaydi: o'quvchi bu oyda o'qimaydi yoki tarif/narx yo'q");
      }
      if (computed.amount.equals(oldAmount)) {
        throw new AiToolError("Qayta hisoblangan summa hozirgisi bilan bir xil — o'zgarish yo'q");
      }
      if (computed.amount.lessThan(paid)) {
        throw new AiToolError(
          `Yangi summa (${formatMoneyUz(formatAmount(computed.amount))}) to'langan summadan (${formatMoneyUz(formatAmount(paid))}) kam — to'lov tushgan hisob-faktura bunday holda tuzatilmaydi`,
        );
      }
    } else {
      if (skip === "notEnrolled") {
        throw new AiToolError("O'quvchi bu oyda o'qimagan — qayta hisoblash emas, hisob-fakturani bekor qilish kerak");
      }
      if (skip) throw new AiToolError("O'quvchida bu oy uchun tarif yoki narx yo'q — qayta hisoblab bo'lmaydi");
      if (
        computed.amount.equals(oldAmount) &&
        computed.baseAmount.equals(invoice.baseAmount) &&
        computed.discountAmount.equals(invoice.discountAmount ?? 0)
      ) {
        throw new AiToolError("Qayta hisoblangan summa hozirgisi bilan bir xil — o'zgarish yo'q");
      }
    }

    const newDebt = computed.amount.minus(paid);
    const newStatus = paid.greaterThan(0)
      ? newDebt.greaterThan(0)
        ? "partial"
        : "paid"
      : row.status;

    const warnings = [];
    if (month < currentMonthKey()) warnings.push(`${monthLabel(month)} — o'tgan oy: tarix qayta yoziladi`);
    if (computed.wipedByDiscount) warnings.push("Yangi summa 0 so'm — hisob-faktura darhol \"to'langan\" bo'ladi");

    return {
      params: { studentId: student.id, month, reason: args.reason },
      preview: {
        summary: `${student.name}ning ${monthLabel(month)} hisob-fakturasi joriy qoidalar bo'yicha qayta hisoblanadi`,
        target: invoiceTarget(student, month),
        fields: [
          { label: "Tarif", before: invoice.tariffName || "—", after: row.tariffName },
          { label: "Asosiy summa", before: formatMoneyUz(formatAmount(invoice.baseAmount)), after: formatMoneyUz(formatAmount(computed.baseAmount)) },
          { label: "Chegirma", before: formatMoneyUz(formatAmount(invoice.discountAmount ?? 0)), after: formatMoneyUz(formatAmount(computed.discountAmount)) },
          { label: "Summa", before: formatMoneyUz(formatAmount(oldAmount)), after: formatMoneyUz(formatAmount(computed.amount)) },
          { label: "Qarz", before: formatMoneyUz(formatAmount(oldAmount.minus(paid))), after: formatMoneyUz(formatAmount(newDebt)) },
          { label: "Holat", before: invoiceService.STATUS_LABELS[invoice.status], after: invoiceService.STATUS_LABELS[newStatus] },
        ],
        effects: [
          paid.greaterThan(0)
            ? "To'lovlar va taqsimotlar saqlanadi, faqat summa maydonlari joyida qayta yoziladi"
            : "Eski hisob-faktura o'chirilib, yangisi yoziladi (yangi id bilan)",
        ],
        warnings,
      },
    };
  },
  // Mirrors invoice.controller.regenerateInvoice: regenerateInvoice(req.params.id, req.body.reason, req.user.id).
  async execute(params, ctx) {
    const found = await findInvoice(params.studentId, params.month);
    if (!found) throw new AiToolError(`${monthLabel(params.month)} uchun hisob-faktura endi yo'q`);
    // ⚠️ Servis bekor qilingan qatorni rad ETMAYDI: `paidAmount = 0` bo'lgani
    // uchun uni o'chirib "to'lanmagan" qilib qayta yozardi — bu tiklash, qayta
    // hisoblash emas. Tasdiqdan keyin bekor qilingan bo'lsa, to'xtatiladi.
    if (found.status === "cancelled") {
      throw new AiToolError("Hisob-faktura shu orada bekor qilingan — qayta hisoblanmaydi");
    }

    const result = await invoiceService.regenerateInvoice(found.id, params.reason, ctx.user.id);

    return {
      summary: `${result.studentName}ning ${result.monthLabel} hisob-fakturasi qayta hisoblandi: ${formatMoneyUz(result.amount)}`,
      details: [
        { label: "Holat", value: result.statusLabel },
        { label: "Qarz", value: formatMoneyUz(result.debt) },
      ],
      data: { invoiceId: result.id },
    };
  },
});

const generateInvoices = defineAction({
  type: "finance.generate_month",
  toolName: "propose_generate_invoices",
  toolset: TOOLSET,
  title: "Oylik hisob-fakturalarni shakllantirish",
  risk: "high",
  permission: "finance.generate",
  description:
    "Propose generating missing invoices for a month (whole branch, a class or up to 200 students). A dry run computes exactly what would be written: new invoices, previously cancelled invoices that come back (restored), total amount, and students skipped because of no tariff, no price, not enrolled or frozen. Existing live invoices are never changed. Future months are refused; a past month creates debt retroactively. Refused when nothing would be created.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema("Month to generate, YYYYMM (not in the future). Omit for the current month."),
      classId: idSchema("Limit to one class."),
      studentIds: {
        type: "array",
        maxItems: 200,
        items: idSchema("Student user id."),
        description: "Limit to these students.",
      },
    },
  },
  async prepare(args, ctx) {
    const month = monthArg(args.month);
    const now = currentMonthKey();
    if (month > now) throw new AiToolError("Kelajakdagi oy uchun hisob-faktura shakllantirilmaydi");

    const studentIds = args.studentIds?.length ? [...new Set(args.studentIds)].sort() : undefined;
    const classId = args.classId || undefined;

    const [summary, settings] = await Promise.all([
      invoiceGenerationService.generateForMonth(month, {
        actorId: ctx.user.id,
        source: "manual",
        studentIds,
        classId,
        dryRun: true,
      }),
      getFinanceSettings(),
    ]);

    if (summary.reason === "vacation") throw new AiToolError(`${monthLabel(month)} — ta'til oyi, hisob-faktura yozilmaydi`);
    if (summary.reason === "before_first_invoice_month") {
      throw new AiToolError(`${monthLabel(month)} birinchi hisob-faktura oyidan oldin — shakllantirilmaydi`);
    }
    if (summary.created + summary.restored === 0) {
      const s = summary.skipped;
      throw new AiToolError(
        `${monthLabel(month)} uchun yoziladigan yangi hisob-faktura yo'q (mavjud: ${s.alreadyExists}, tarifsiz: ${s.noTariff + s.noTariffNewlyEnrolled}, narxsiz: ${s.noPrice}, o'qimaydi: ${s.notEnrolled}, muzlatilgan: ${s.frozen})`,
      );
    }

    const details = summary.details;
    const wouldCreate = details.wouldCreate.map((row) => `${row.fullName} (${formatMoneyUz(row.amount)})`);
    const wouldRestore = details.wouldRestore.map((row) => `${row.fullName} (${formatMoneyUz(row.amount)})`);
    const skippedNames = [...(details.noTariff ?? []), ...(details.noTariffNewlyEnrolled ?? []), ...(details.noPrice ?? [])].map(
      (row) => row.fullName,
    );

    const effects = [];
    if (wouldCreate.length) effects.push(`Yangi: ${namesText(wouldCreate)}`);
    if (wouldRestore.length) effects.push(`Bekor qilingandan tiklanadi: ${namesText(wouldRestore)}`);
    if (summary.created + summary.restored > 0 && settings.depositAutoApply) {
      effects.push("Depozitida puli bor o'quvchilarning yangi va tiklangan hisob-fakturalari depozitdan avtomatik yopiladi");
    }

    const warnings = [];
    if (month < now) warnings.push(`${monthLabel(month)} — o'tgan oy: o'quvchilarga orqaga qarab qarz yoziladi`);
    if (summary.restored > 0) warnings.push(`${summary.restored} ta avval bekor qilingan hisob-faktura qayta amalga kiradi`);
    if (skippedNames.length) warnings.push(`Tarif yoki narx yo'qligi sabab yozilmaydi: ${namesText(skippedNames)}`);
    if (summary.wipedByDiscount > 0) warnings.push(`${summary.wipedByDiscount} ta hisob-faktura chegirma sabab 0 so'm bo'ladi`);
    if (details.truncated) warnings.push("Ro'yxatlar 200 ta ism bilan cheklangan");

    const scope = studentIds ? `${studentIds.length} ta o'quvchi` : classId ? "tanlangan sinf" : "butun filial";

    return {
      params: { month, classId: classId ?? null, studentIds: studentIds ?? null },
      preview: {
        summary: `${monthLabel(month)} uchun ${summary.created + summary.restored} ta hisob-faktura yoziladi, jami ${formatMoneyUz(summary.totalAmount)}`,
        target: `${monthLabel(month)} · ${scope}`,
        fields: [
          { label: "Yangi hisob-fakturalar", before: "—", after: String(summary.created) },
          { label: "Tiklanadiganlar", before: "—", after: String(summary.restored) },
          { label: "Jami summa", before: "—", after: formatMoneyUz(summary.totalAmount) },
          { label: "Chegirmalar", before: "—", after: formatMoneyUz(summary.discountTotal) },
          { label: "Allaqachon mavjud", before: String(summary.skipped.alreadyExists), after: String(summary.skipped.alreadyExists) },
        ],
        effects,
        warnings,
      },
      // Ko'rinishda ismlar 10 ta bilan kesiladi — tasdiq paytidagi taqqoslash
      // esa HAR BIR o'quvchi va summani qamrashi kerak.
      // `details` ro'yxatlari 200 ta bilan kesiladi — sanoq va jami summa ham
      // kiradi, aks holda kesilgan qismdagi o'zgarish sezilmay qolardi.
      fingerprint: {
        month,
        scope: [classId ?? null, studentIds ?? null],
        createdCount: summary.created,
        restoredCount: summary.restored,
        created: details.wouldCreate.map((row) => [row.studentId, row.amount]).sort(),
        restored: details.wouldRestore.map((row) => [row.studentId, row.amount]).sort(),
        totalAmount: summary.totalAmount,
        discountTotal: summary.discountTotal,
        skipped: summary.skipped,
        depositAutoApply: settings.depositAutoApply,
      },
    };
  },
  // Mirrors invoice.controller.generateInvoices: o'tgan oy darvozasi (canAdjust) ega uchun ochiq,
  // generateForMonth(month, { actorId: req.user.id, source: "manual", studentIds, classId, dryRun: false }).
  async execute(params, ctx) {
    const summary = await invoiceGenerationService.generateForMonth(params.month, {
      actorId: ctx.user.id,
      source: "manual",
      studentIds: params.studentIds ?? undefined,
      classId: params.classId ?? undefined,
      dryRun: false,
    });

    return {
      summary: `${summary.monthLabel}: ${summary.created} ta yangi, ${summary.restored} ta tiklangan hisob-faktura yozildi`,
      details: [
        { label: "Jami summa", value: formatMoneyUz(summary.totalAmount) },
        { label: "Depozitdan yopildi", value: formatMoneyUz(summary.depositApplied) },
        { label: "Allaqachon mavjud", value: String(summary.skipped.alreadyExists) },
      ],
      data: { created: summary.created, restored: summary.restored, totalAmount: summary.totalAmount },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 11. O'quvchi to'lovini qayd etish
// ─────────────────────────────────────────────────────────────────────────

const recordStudentPayment = defineAction({
  type: "finance.record_payment",
  toolName: "propose_record_student_payment",
  toolset: TOOLSET,
  title: "O'quvchi to'lovini qayd etish",
  risk: "critical",
  permission: "finance.pay",
  description:
    "Propose recording that a student's payment was RECEIVED into a payment account (use only when the owner states the money arrived, with amount, student and account). The amount is applied to the oldest unpaid invoices first (FIFO) and any remainder goes to the student's deposit; a receipt number is issued and the account balance increases. Irreversible except by a separate void. The preview shows the month-by-month allocation, the deposit part and possible duplicate receipts.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId", "accountId", "amount"],
    properties: {
      studentId: idSchema("Student user id."),
      accountId: idSchema("Active payment account id from finance_payment_accounts."),
      amount: { type: "number", minimum: 0.01, description: "Amount received in so'm (up to 2 decimals)." },
      paidDate: daySchema("Day the money was received, YYYY-MM-DD (Tashkent). Omit for now; cannot be in the future."),
      note: noteSchema("Note printed on the receipt."),
    },
  },
  async prepare(args, ctx) {
    const student = await loadStudent(args.studentId);
    const accountId = requireId(args.accountId, "To'lov turi id");
    const paidAt = recordedAtParam(args.paidDate, ctx.today, "to'lov");

    const [preview, account] = await Promise.all([
      paymentService.previewPayment(student.id, args.amount),
      paymentAccountService.assertActiveAccount(accountId),
    ]);

    const debtRow = await prisma.monthlyInvoice.aggregate({
      where: { studentId: student.id, status: { in: ["unpaid", "partial"] } },
      _sum: { amount: true, paidAmount: true },
    });
    const debt = new Decimal(debtRow._sum.amount ?? 0).minus(debtRow._sum.paidAmount ?? 0);
    const debtAfter = debt.minus(preview.allocatedAmount);

    // Takroriy kiritish belgisi: shu o'quvchidan AYNAN shu summa so'nggi 3 kun
    // ichida KIRITILGAN (orqaga sanalgan chek ham) yoki shu kunlarga sanalgan.
    // Oyna kun chegarasida o'zgaradi — tasdiq oynasi ichida barqaror qoladi.
    const windowFrom = parseRangeBound(shiftIsoDays(ctx.today, -2), "Sana", "start");
    const duplicates = await prisma.payment.findMany({
      where: {
        studentId: student.id,
        isVoided: false,
        amount: preview.amount,
        OR: [{ paidAt: { gte: windowFrom } }, { createdAt: { gte: windowFrom } }],
      },
      select: { receiptNo: true, paidAt: true },
      orderBy: { receiptNo: "desc" },
    });

    const warnings = [
      "Bu amal pul haqiqatda qabul qilinganini tasdiqlaydi: kassa qoldig'i oshadi va qarz yopiladi. Noto'g'ri yozuvni faqat to'lovni bekor qilish orqali qaytarish mumkin",
      ...archivedWarning(student),
    ];
    if (duplicates.length > 0) {
      warnings.push(
        `So'nggi kunlarda shu o'quvchidan aynan shu summa allaqachon qabul qilingan: ${duplicates
          .map((p) => `#${String(p.receiptNo).padStart(6, "0")} (${formatDateTimeUz(p.paidAt)})`)
          .join(", ")} — takroriy kiritish emasligini tekshiring`,
      );
    }
    if (new Decimal(preview.depositAmount).greaterThan(0)) {
      warnings.push(`${formatMoneyUz(preview.depositAmount)} ochiq qarzdan ortiq — o'quvchi depozitiga tushadi`);
    }
    if (paidAt) warnings.push(`To'lov sanasi o'tgan kun: ${formatDateUz(paidAt)}`);

    const params = {
      studentId: student.id,
      accountId: account.id,
      amount: preview.amount,
      paidAt,
      note: args.note ?? "",
    };

    const allocations = preview.allocations.map((a) => ({
      invoiceId: a.invoiceId,
      month: a.month,
      amount: a.amount,
      previousPaidAmount: a.previousPaidAmount,
      status: a.status,
    }));

    return {
      params,
      // Kassa qoldig'i boshqa o'quvchilar to'lovlari bilan doim o'zgaradi —
      // barmoq izi faqat SHU o'quvchining pul holatiga bog'lanadi (taqsimot,
      // qarz, depozit, takroriy cheklar), aks holda tasdiq behuda eskirardi.
      fingerprint: {
        params,
        accountName: account.name,
        debt: formatAmount(debt),
        deposit: preview.currentBalance,
        depositAmount: preview.depositAmount,
        allocations,
        duplicates: duplicates.map((p) => p.receiptNo),
        isArchived: student.isArchived,
      },
      preview: {
        summary: `${student.name}dan ${formatMoneyUz(preview.amount)} "${account.name}" orqali qabul qilingani qayd etiladi`,
        target: student.target,
        fields: [
          { label: "To'lov summasi", before: "—", after: formatMoneyUz(preview.amount) },
          { label: "To'lov turi", before: "—", after: account.name },
          { label: "Sana", before: "—", after: recordedAtLabel(paidAt) },
          { label: "Ochiq qarz", before: formatMoneyUz(formatAmount(debt)), after: formatMoneyUz(formatAmount(debtAfter)) },
          {
            label: "Depozit",
            before: formatMoneyUz(preview.currentBalance),
            after: formatMoneyUz(formatAmount(new Decimal(preview.currentBalance).plus(preview.depositAmount))),
          },
          {
            label: `"${account.name}" qoldig'i`,
            before: formatMoneyUz(formatAmount(account.balance)),
            after: formatMoneyUz(formatAmount(new Decimal(account.balance).plus(preview.amount))),
          },
        ],
        effects: preview.allocations.length
          ? preview.allocations.map(
              (a) =>
                `${a.monthLabel}: ${formatMoneyUz(a.amount)} tushadi — ${a.closes ? "to'liq to'lanadi" : `qisman to'langan bo'lib qoladi (jami to'langan ${formatMoneyUz(a.newPaidAmount)})`}`,
            )
          : ["Ochiq hisob-faktura yo'q — butun summa depozitga tushadi"],
        warnings,
      },
    };
  },
  // Mirrors payment.controller.createPayment: createPayment(req.body, req.user.id).
  async execute(params, ctx) {
    const result = await paymentService.createPayment(params, ctx.user.id);

    return {
      summary: `${result.studentName}dan ${formatMoneyUz(result.amount)} qabul qilindi, chek ${result.receiptLabel}`,
      details: [
        { label: "Hisob-fakturalarga", value: formatMoneyUz(result.summary.allocatedAmount) },
        { label: "Depozitga", value: formatMoneyUz(result.summary.depositAmount) },
        { label: "To'liq yopilgan oylar", value: String(result.summary.closedCount) },
        { label: "To'lov turi", value: result.account?.name ?? "—" },
      ],
      data: { paymentId: result.id, receiptNo: result.receiptNo },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 12. Qarzdorlarga eslatma
// ─────────────────────────────────────────────────────────────────────────

const sendDebtReminders = defineAction({
  type: "finance.remind_debtors",
  toolName: "propose_send_debt_reminders",
  toolset: TOOLSET,
  title: "Qarzdorlarga Telegram eslatmasi",
  risk: "high",
  permission: "debtors.remind",
  description:
    "Propose sending a Telegram debt reminder to parents: one message per student with their current total debt, number of unpaid months and oldest month, plus an optional note. Target EITHER explicit studentIds (max 200), OR classId (all debtors of a class), OR allDebtors=true (all debtors of the branch, refused when more than 200). Students without debt or without a connected Telegram are skipped. Messages cannot be recalled. Preview shows recipients with/without Telegram and the total debt.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      studentIds: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: idSchema("Student user id."),
        description: "Explicit students to remind.",
      },
      classId: idSchema("Remind all debtors of this class."),
      allDebtors: { type: "boolean", description: "Remind all debtors of the branch (max 200)." },
      note: noteSchema("Optional line added to every message (plain text)."),
    },
  },
  async prepare(args, ctx) {
    const scopes = [args.studentIds?.length ? 1 : 0, args.classId ? 1 : 0, args.allDebtors === true ? 1 : 0];
    const scopeCount = scopes.reduce((a, b) => a + b, 0);
    if (scopeCount !== 1) {
      throw new AiToolError("Qabul qiluvchilarni bitta usulda bering: o'quvchilar ro'yxati, sinf yoki barcha qarzdorlar");
    }

    const max = debtReminderService.MAX_RECIPIENTS;
    let ids;
    if (args.studentIds?.length) {
      ids = [...new Set(args.studentIds)];
    } else {
      const debtors = await invoiceService.getDebtors(reqLike(ctx, { classId: args.classId, limit: max + 1 }));
      if (debtors.pagination.total > max) {
        throw new AiToolError(
          `Qarzdorlar ${debtors.pagination.total} ta — bir marta ${max} tagacha eslatma yuboriladi. Sinf bo'yicha bo'lib yuboring`,
        );
      }
      ids = debtors.data.map((row) => row.id);
    }
    ids.sort();
    if (ids.length === 0) throw new AiToolError("Tanlangan qamrovda qarzdor o'quvchi yo'q");

    // `debtReminder.remindDebtors` bilan AYNI so'rovlar: qarz serverda qayta
    // hisoblanadi, Telegram faqat faol va bildirishnomasi yoqilgan chatlar.
    const [grouped, students, tgUsers] = await Promise.all([
      prisma.monthlyInvoice.groupBy({
        by: ["studentId"],
        where: { studentId: { in: ids }, status: { in: ["unpaid", "partial"] } },
        _sum: { amount: true, paidAmount: true },
      }),
      prisma.user.findMany({
        where: { id: { in: ids }, role: ROLES.STUDENT },
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      }),
      prisma.tgUser.findMany({
        where: { student: { in: ids }, isActive: true, notificationsEnabled: true },
        select: { student: true },
      }),
    ]);

    if (students.length !== ids.length) {
      if (args.studentIds?.length) {
        throw new AiToolError(`${ids.length - students.length} ta id o'quvchiga tegishli emas`);
      }
      // Sinf/filial qamrovi qarzdorlar registridan olinadi va u o'chirilgan
      // o'quvchining qolib ketgan qarzini ham ko'rsatadi — servis bunday
      // id'ni jimgina o'tkazib yuboradi, shuning uchun bu yerda ham chiqariladi.
      const known = new Set(students.map((s) => s.id));
      ids = ids.filter((id) => known.has(id));
    }

    const debtById = new Map(
      grouped.map((row) => [row.studentId, new Decimal(row._sum.amount ?? 0).minus(row._sum.paidAmount ?? 0)]),
    );
    const chatCount = new Map();
    for (const tg of tgUsers) chatCount.set(tg.student, (chatCount.get(tg.student) ?? 0) + 1);

    const sendable = [];
    const noDebt = [];
    const noTelegram = [];
    for (const student of students) {
      const name = personName(student);
      const debt = debtById.get(student.id);
      if (!debt || debt.lessThanOrEqualTo(0)) noDebt.push(name);
      else if (!chatCount.get(student.id)) noTelegram.push(name);
      else sendable.push({ id: student.id, name, debt, chats: chatCount.get(student.id) });
    }

    if (sendable.length === 0) {
      throw new AiToolError(
        `Eslatma yuboriladigan o'quvchi yo'q: qarzi yo'q — ${noDebt.length}, Telegram ulanmagan — ${noTelegram.length}`,
      );
    }

    const klass = args.classId
      ? await prisma.class.findUnique({ where: { id: args.classId }, select: { name: true } })
      : null;
    const totalDebt = sumAmounts(sendable.map((s) => s.debt));
    const messages = sendable.reduce((sum, s) => sum + s.chats, 0);
    const note = (args.note ?? "").trim();

    const warnings = ["Xabarlar ota-onalarning Telegramiga ketadi va ularni qaytarib olib bo'lmaydi"];
    if (noTelegram.length) warnings.push(`Telegram ulanmagan, xabar bormaydi: ${namesText(noTelegram)}`);
    if (noDebt.length) warnings.push(`Qarzi yo'q, xabar yuborilmaydi: ${namesText(noDebt)}`);

    return {
      params: { studentIds: ids, note },
      preview: {
        summary: `${sendable.length} ta o'quvchining ota-onasiga qarz eslatmasi yuboriladi`,
        target: args.allDebtors
          ? "Filialning barcha qarzdorlari"
          : args.classId
            ? `${klass?.name ?? "Tanlangan sinf"} qarzdorlari`
            : `${ids.length} ta tanlangan o'quvchi`,
        fields: [
          { label: "Xabar oladigan o'quvchilar", before: "—", after: String(sendable.length) },
          { label: "Telegram xabarlari", before: "—", after: String(messages) },
          { label: "Ular bo'yicha jami qarz", before: "—", after: formatMoneyUz(formatAmount(totalDebt)) },
          { label: "Qo'shimcha izoh", before: "—", after: note || "Yo'q" },
        ],
        effects: [
          `Qabul qiluvchilar: ${namesText(sendable.map((s) => `${s.name} (${formatMoneyUz(formatAmount(s.debt))})`), 15)}`,
          "Har bir eslatma \"Xabarlar\" tarixida saqlanadi",
        ],
        warnings,
      },
    };
  },
  // Mirrors invoice.controller.remindDebtors:
  // remindDebtors(req.body.studentIds, { note: req.body.note, actorId: req.user.id }).
  // Izoh servis ichida `escapeHtml` qilinadi — bu yerda qayta ekranlanmaydi.
  async execute(params, ctx) {
    const result = await debtReminderService.remindDebtors(params.studentIds, {
      note: params.note,
      actorId: ctx.user.id,
    });

    return {
      summary: `${result.sentTo} ta o'quvchi bo'yicha ${result.queued} ta eslatma navbatga qo'yildi`,
      details: [
        { label: "Qarzi yo'q (yuborilmadi)", value: String(result.skipped.noDebt.length) },
        { label: "Telegram yo'q (yuborilmadi)", value: String(result.skipped.noTelegram.length) },
      ],
      data: { queued: result.queued, sentTo: result.sentTo },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 13. Tashqi kirim
// ─────────────────────────────────────────────────────────────────────────

const recordExternalIncome = defineAction({
  type: "finance.record_external_income",
  toolName: "propose_record_external_income",
  toolset: TOOLSET,
  title: "Tashqi kirimni qayd etish",
  risk: "high",
  permission: "income.create",
  description:
    "Propose recording non-tuition income that ARRIVED (rent, sponsorship, uniform sales…) into a payment account under an active income category, optionally with payer, responsible staff member (counts toward their collection plan) and the day received. The account balance increases. Use only when the owner states the money arrived.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["categoryId", "accountId", "amount"],
    properties: {
      categoryId: idSchema("Active income category id (finance_external_income categories)."),
      accountId: idSchema("Active payment account id."),
      amount: { type: "number", minimum: 0.01, description: "Amount in so'm (up to 2 decimals)." },
      payer: { type: "string", maxLength: 120, description: "Who paid." },
      responsibleId: idSchema("Staff member responsible for collecting it (not a student)."),
      occurredDate: daySchema("Day the money arrived, YYYY-MM-DD (Tashkent). Omit for now; not in the future."),
      note: noteSchema("Note."),
    },
  },
  async prepare(args, ctx) {
    const occurredAt = recordedAtParam(args.occurredDate, ctx.today, "kirim");
    const amount = formatAmount(parseAmount(args.amount, "Summa"));
    if (!new Decimal(amount).greaterThan(0)) throw new AiToolError("Summa noldan katta bo'lishi kerak");

    const [category, account, responsible] = await Promise.all([
      incomeCategoryService.assertActiveCategory(requireId(args.categoryId, "Kategoriya id")),
      paymentAccountService.assertActiveAccount(requireId(args.accountId, "To'lov turi id")),
      externalIncomeService.resolveResponsible(args.responsibleId ? requireId(args.responsibleId, "Mas'ul id") : null),
    ]);

    const warnings = ["Bu amal pul haqiqatda kelganini tasdiqlaydi: kassa qoldig'i oshadi. Xato yozuvni faqat bekor qilish orqali qaytarish mumkin"];
    if (occurredAt) warnings.push(`Kirim sanasi o'tgan kun: ${formatDateUz(occurredAt)}`);
    if (!responsible.id) warnings.push("Mas'ul xodim belgilanmagan — yig'ish rejasi hisobotida \"Mas'ul belgilanmagan\" qatoriga tushadi");

    const params = {
      categoryId: category.id,
      accountId: account.id,
      amount,
      payer: args.payer ?? "",
      note: args.note ?? "",
      occurredAt,
      responsibleId: responsible.id,
    };

    return {
      params,
      // Kassa qoldig'i har qanday boshqa pul harakati bilan o'zgaradi — u
      // barmoq iziga kirmaydi (aks holda tasdiq doim "ma'lumot o'zgargan" bo'lardi).
      fingerprint: {
        params,
        categoryName: category.name,
        accountName: account.name,
        responsibleName: responsible.name,
      },
      preview: {
        summary: `"${category.name}" bo'yicha ${formatMoneyUz(amount)} "${account.name}" ga kirim qilinadi`,
        target: category.name,
        fields: [
          { label: "Summa", before: "—", after: formatMoneyUz(amount) },
          { label: "Kirim turi", before: "—", after: category.name },
          { label: "Kimdan", before: "—", after: args.payer || "—" },
          { label: "Mas'ul", before: "—", after: responsible.name || "Belgilanmagan" },
          { label: "Sana", before: "—", after: recordedAtLabel(occurredAt) },
          {
            label: `"${account.name}" qoldig'i`,
            before: formatMoneyUz(formatAmount(account.balance)),
            after: formatMoneyUz(formatAmount(new Decimal(account.balance).plus(amount))),
          },
        ],
        effects: ["Kirim hujjati va to'lov turi daftariga yozuv bitta tranzaksiyada yoziladi"],
        warnings,
      },
    };
  },
  // Mirrors externalIncome.controller.createIncome: createIncome(req.body, req.user.id).
  async execute(params, ctx) {
    const result = await externalIncomeService.createIncome(params, ctx.user.id);

    return {
      summary: `"${result.categoryName}" bo'yicha ${formatMoneyUz(result.amount)} "${result.accountName}" ga kirim qilindi`,
      data: { incomeId: result.id },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 14. Yig'ish rejasi
// ─────────────────────────────────────────────────────────────────────────

const setIncomePlan = defineAction({
  type: "finance.set_income_plan",
  toolName: "propose_set_income_plan",
  toolset: TOOLSET,
  title: "Yig'ish rejasini belgilash",
  risk: "low",
  permission: "reports.plan",
  description:
    "Propose setting (or removing with remove=true) one monthly collection plan row: how much external income a responsible staff member should collect in an income category for a month. Only this row changes; student count and note keep their current values unless given. No money moves — it changes plan-achievement reporting.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["responsibleId", "categoryId"],
    properties: {
      month: monthSchema("Plan month, YYYYMM. Omit for the current month."),
      responsibleId: idSchema("Responsible staff member id (not a student)."),
      categoryId: idSchema("Income category id."),
      targetAmount: { type: "number", minimum: 0, description: "Target amount in so'm. Required unless remove is true." },
      studentCount: { type: "integer", minimum: 0, maximum: 100000, description: "Number of students the plan covers." },
      note: noteSchema("Note on the plan row."),
      remove: { type: "boolean", description: "Remove this plan row instead of setting it." },
    },
  },
  async prepare(args) {
    const month = monthArg(args.month);
    const responsibleId = requireId(args.responsibleId, "Mas'ul id");
    const categoryId = requireId(args.categoryId, "Kategoriya id");
    const remove = args.remove === true;

    if (!remove && args.targetAmount == null) throw new AiToolError("Reja summasi ko'rsatilmagan");

    const [staff, category, existing, report] = await Promise.all([
      prisma.user.findUnique({
        where: { id: responsibleId },
        select: { id: true, firstName: true, lastName: true, role: true, isArchived: true },
      }),
      prisma.incomeCategory.findUnique({ where: { id: categoryId }, select: { id: true, name: true, isArchived: true } }),
      prisma.incomePlan.findUnique({
        where: { month_responsibleId_categoryId: { month, responsibleId, categoryId } },
      }),
      incomePlanService.getPlans({ month }),
    ]);

    if (!staff) throw new AiToolError("Mas'ul xodim topilmadi");
    if (staff.role === ROLES.STUDENT) throw new AiToolError("O'quvchini mas'ul qilib belgilab bo'lmaydi");
    if (!category) throw new AiToolError("Kirim turi topilmadi");
    if (remove && !existing) throw new AiToolError("Bu mas'ul va kirim turi uchun shu oyda reja yo'q");

    const targetAmount = remove ? null : formatAmount(parseAmount(args.targetAmount, "Reja summasi"));
    const studentCount = args.studentCount ?? existing?.studentCount ?? 0;
    const note = args.note ?? existing?.note ?? "";
    const cell = report.items.find((row) => row.responsibleId === responsibleId && row.categoryId === categoryId);
    const staffName = personName(staff);

    const warnings = [];
    if (staff.isArchived) warnings.push(`${staffName} arxivlangan`);
    if (category.isArchived) warnings.push(`"${category.name}" kirim turi arxivlangan`);

    return {
      params: { month, responsibleId, categoryId, targetAmount, studentCount, note },
      preview: {
        summary: remove
          ? `${staffName}ning "${category.name}" bo'yicha ${monthLabel(month)} rejasi olib tashlanadi`
          : `${staffName} ${monthLabel(month)} da "${category.name}" bo'yicha ${formatMoneyUz(targetAmount)} yig'ishi rejalashtiriladi`,
        target: `${staffName} · ${category.name} · ${monthLabel(month)}`,
        fields: [
          {
            label: "Reja summasi",
            before: existing ? formatMoneyUz(formatAmount(existing.targetAmount)) : "Yo'q",
            after: remove ? "Yo'q" : formatMoneyUz(targetAmount),
          },
          { label: "O'quvchilar soni", before: existing ? String(existing.studentCount) : "—", after: remove ? "—" : String(studentCount) },
          { label: "Shu oy yig'ilgan", before: formatMoneyUz(cell?.collected ?? "0.00"), after: formatMoneyUz(cell?.collected ?? "0.00") },
        ],
        effects: ["Faqat reja hisobotiga ta'sir qiladi — pul harakatlanmaydi"],
        warnings,
      },
    };
  },
  // Mirrors financeReport.controller.saveIncomePlans: upsertPlans(req.body, req.user.id)
  // bitta qatorli `items` bilan (bo'sh summa — qatorni o'chirish).
  async execute(params, ctx) {
    const report = await incomePlanService.upsertPlans(
      {
        month: params.month,
        items: [
          {
            responsibleId: params.responsibleId,
            categoryId: params.categoryId,
            targetAmount: params.targetAmount,
            studentCount: params.studentCount,
            note: params.note,
          },
        ],
      },
      ctx.user.id,
    );

    return {
      summary:
        params.targetAmount == null
          ? `${report.monthLabel} yig'ish rejasidan qator olib tashlandi`
          : `${report.monthLabel} yig'ish rejasi saqlandi: ${formatMoneyUz(params.targetAmount)}`,
      details: [
        { label: "Oy bo'yicha jami reja", value: formatMoneyUz(report.totals.target) },
        { label: "Yig'ilgan", value: formatMoneyUz(report.totals.collected) },
      ],
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 15. Depozitni qarzga qo'llash
// ─────────────────────────────────────────────────────────────────────────

const applyStudentDeposit = defineAction({
  type: "finance.apply_deposit",
  toolName: "propose_apply_student_deposit",
  toolset: TOOLSET,
  title: "Depozitni ochiq qarzga qo'llash",
  risk: "medium",
  permission: "finance.pay",
  description:
    "Propose applying a student's deposit (prepaid remainder) to their open invoices, oldest month first. Internal allocation only: no cash moves and no ledger entry is written. Refused when the deposit is zero or there is no open invoice.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId"],
    properties: {
      studentId: idSchema("Student user id."),
    },
  },
  async prepare(args) {
    const student = await loadStudent(args.studentId);

    const [balance, invoices, remainders] = await Promise.all([
      studentAccountService.getBalance(student.id),
      prisma.monthlyInvoice.findMany({
        where: { studentId: student.id, status: { in: ["unpaid", "partial"] } },
        orderBy: [{ month: "asc" }, { id: "asc" }],
      }),
      prisma.payment.aggregate({
        where: { studentId: student.id, isVoided: false, depositAmount: { gt: 0 } },
        _sum: { depositAmount: true },
      }),
    ]);

    if (balance.lessThanOrEqualTo(0)) throw new AiToolError("O'quvchi depozitida pul yo'q");
    if (invoices.length === 0) throw new AiToolError("O'quvchida ochiq hisob-faktura yo'q — depozit qo'llanmaydi");

    // `depositSettlement.settleDepositInTx` (manual) bilan AYNI hisob:
    // byudjet = min(balans, cheklar qoldig'i) — chekka bog'lanmagan to'g'rilash
    // pulini yechib bo'lmaydi; "avtomat yechish to'xtatilgan" oylar ham
    // qamraladi (qo'lda qo'llash belgini tozalaydi). Sana faqat "to'liq
    // yopilgan payt" uchun kerak va ko'rinishga kirmaydi.
    const budget = Decimal.min(balance, new Decimal(remainders._sum.depositAmount ?? 0));
    if (budget.lessThanOrEqualTo(0)) {
      throw new AiToolError("Depozitdagi pul hech qaysi chekka bog'lanmagan (qo'lda to'g'rilash) — qarzga yechib bo'lmaydi");
    }
    const { allocations, allocated } = allocateFifo(invoices, budget, new Date());
    if (allocations.length === 0) {
      throw new AiToolError("Ochiq hisob-fakturalarda qoldiq qarz yo'q — depozit qo'llanmaydi");
    }

    const debt = sumAmounts(invoices.map((i) => new Decimal(i.amount).minus(i.paidAmount)));

    return {
      params: { studentId: student.id },
      preview: {
        summary: `${student.name}ning depozitidan ${formatMoneyUz(formatAmount(allocated))} ochiq qarzga qo'llanadi`,
        target: student.target,
        fields: [
          { label: "Depozit", before: formatMoneyUz(formatAmount(balance)), after: formatMoneyUz(formatAmount(balance.minus(allocated))) },
          { label: "Ochiq qarz", before: formatMoneyUz(formatAmount(debt)), after: formatMoneyUz(formatAmount(debt.minus(allocated))) },
        ],
        effects: allocations.map(
          (a) =>
            `${monthLabel(a.month)}: ${formatMoneyUz(formatAmount(a.amount))} — ${a.status === "paid" ? "to'liq to'lanadi" : "qisman to'lanadi"}`,
        ),
        warnings: ["Kassaga pul kirmaydi va chiqmaydi — bu faqat avval to'langan pulni oylarga taqsimlash"],
      },
    };
  },
  // Mirrors payment.controller.applyDeposit: applyDepositsForStudent(studentId, { manual: true }).
  async execute(params) {
    const result = await studentAccountService.applyDepositsForStudent(params.studentId, {
      manual: true,
    });

    return {
      summary: `Depozitdan ${formatMoneyUz(result.applied)} qo'llandi`,
      details: result.allocations.map((a) => ({ label: a.monthLabel, value: formatMoneyUz(a.amount) })),
      data: { applied: result.applied },
    };
  },
});

module.exports = [
  assignStudentTariff,
  changeStudentTariff,
  attachStudentDiscount,
  closeStudentDiscount,
  closeStudentEnrollment,
  freezeStudent,
  unfreezeStudent,
  cancelInvoice,
  regenerateInvoice,
  generateInvoices,
  recordStudentPayment,
  sendDebtReminders,
  recordExternalIncome,
  setIncomePlan,
  applyStudentDeposit,
];
