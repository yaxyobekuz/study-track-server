/**
 * MOLIYAVIY REJA (byudjet) — rahbar dashboardidagi "Reja:" raqamlari.
 *
 * Dashboarddagi har bir ko'rsatkichning AMALDAGI qiymati tizimdan
 * hisoblanadi; "shuncha bo'lishi kerak edi" degan raqam esa rahbarning
 * qarori va faqat shu yerda saqlanadi.
 *
 * ⚠️ Bu service PULGA TEGMAYDI: kassa daftariga yozmaydi, hisob-fakturaga
 * tegmaydi. Shuning uchun lock tartibi ham, tranzaksiya ham kerak emas —
 * bitta oy uchun qatorlar `upsert` bilan yoziladi.
 *
 * ⚠️ `actualValue` faqat `manualActual` metrikalarida qabul qilinadi
 * (hozircha NPS). Boshqa metrikada u JIM tashlab yuborilmaydi — xato
 * qaytariladi: hisoblanadigan ko'rsatkichga qo'lda "amalda" yozib qo'yish
 * hisobotni yolg'onlashtirishning eng oson yo'li.
 */

const prisma = require("../config/prisma");
const { BadRequestError } = require("../utils/errors");
const {
  parseMonthKey,
  parseOptionalMonthKey,
  currentMonthKey,
  formatMonthKey,
} = require("../helpers/month.helpers");
const { Decimal, formatAmount } = require("../helpers/money.helpers");
const {
  FINANCE_METRICS,
  METRIC_KINDS,
  getMetric,
  allowsManualActual,
} = require("../helpers/financeMetrics");

/** Foizli ko'rsatkich 0..100 dan chiqmasligi kerak — 900% "reja" ma'nosiz. */
const MAX_PERCENT = 100;
/** Sanoq ko'rsatkichi (yangi qabul) — aqlga sig'adigan chegara. */
const MAX_COUNT = 100000;

/**
 * Bitta qiymatni metrikaning turiga qarab tekshiradi.
 *
 * Pul `Decimal` bilan, foiz va sanoq oddiy son bilan tekshiriladi, lekin
 * BAZAGA hammasi bir xil `Decimal(14,2)` ustuniga tushadi: metrika kaliti
 * qaysi biri ekanini bir ma'noda aytadi.
 *
 * @param {object} metric - FINANCE_METRICS elementi
 * @param {*} raw
 * @param {string} label
 * @returns {Decimal}
 */
const parseMetricValue = (metric, raw, label) => {
  if (raw == null || raw === "") {
    throw new BadRequestError(`${metric.label}: ${label} kiritilmagan`);
  }

  let value;
  try {
    value = new Decimal(raw);
  } catch {
    throw new BadRequestError(`${metric.label}: ${label} noto'g'ri formatda`);
  }

  if (!value.isFinite() || value.isNegative()) {
    throw new BadRequestError(`${metric.label}: ${label} manfiy bo'lishi mumkin emas`);
  }
  if (value.decimalPlaces() > 2) {
    throw new BadRequestError(`${metric.label}: ${label} 2 xonagacha kasr bo'lishi kerak`);
  }

  if (metric.kind === METRIC_KINDS.PERCENT && value.greaterThan(MAX_PERCENT)) {
    throw new BadRequestError(`${metric.label}: ${label} 100% dan oshmasligi kerak`);
  }
  if (metric.kind === METRIC_KINDS.COUNT && value.greaterThan(MAX_COUNT)) {
    throw new BadRequestError(`${metric.label}: ${label} juda katta`);
  }
  if (metric.kind === METRIC_KINDS.MONEY && value.greaterThan(new Decimal("999999999999"))) {
    throw new BadRequestError(`${metric.label}: ${label} juda katta`);
  }

  return value;
};

/**
 * Bir oyning REJA qatorlari — katalogdagi HAMMA metrika qaytariladi,
 * belgilanmaganida `planValue: null`.
 *
 * Frontend shu ro'yxatni to'g'ridan-to'g'ri formaga aylantiradi: qaysi
 * metrikalar borligini u bilishi shart emas (katalog serverda).
 *
 * @param {{month?: number|string}} query
 */
const getTargets = async (query = {}) => {
  const month = parseOptionalMonthKey(query.month, "Oy") ?? currentMonthKey();

  const rows = await prisma.financeTarget.findMany({ where: { month } });
  const byMetric = new Map(rows.map((row) => [row.metric, row]));

  return {
    month,
    monthLabel: formatMonthKey(month),
    items: FINANCE_METRICS.map((metric) => {
      const row = byMetric.get(metric.key);
      return {
        metric: metric.key,
        label: metric.label,
        kind: metric.kind,
        group: metric.group,
        hint: metric.hint ?? "",
        manualActual: Boolean(metric.manualActual),
        planValue: row ? formatAmount(row.planValue) : null,
        actualValue: row?.actualValue != null ? formatAmount(row.actualValue) : null,
        note: row?.note ?? "",
        updatedAt: row?.updatedAt ?? null,
      };
    }),
  };
};

/**
 * Bir oyning rejasini yozadi.
 *
 * Yuborilgan metrikalargina tegiladi: `planValue: null` (yoki bo'sh satr)
 * kelgan qator O'CHIRILADI — "rejani olib tashlash" uchun alohida endpoint
 * ochishning ma'nosi yo'q. Yuborilmagan metrika esa o'z holicha qoladi.
 *
 * @param {{month: number|string, items: Array<{metric: string, planValue?: *, actualValue?: *, note?: string}>}} data
 * @param {string} userId
 */
const upsertTargets = async (data = {}, userId) => {
  const month = parseMonthKey(data.month, "Oy");

  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw new BadRequestError("Reja qatorlari yuborilmadi");
  }
  if (data.items.length > FINANCE_METRICS.length) {
    throw new BadRequestError("Reja qatorlari juda ko'p");
  }

  // ── Avval HAMMASI tekshiriladi, keyin yoziladi ──────────────────────
  // Yarim yozilgan reja ("uchtasi tushdi, to'rtinchisi xato berdi") eng
  // yomon holat: rahbar ekranda nima saqlanganini bilmay qoladi.
  const seen = new Set();
  const plan = [];

  for (const item of data.items) {
    const metric = getMetric(item?.metric);
    if (!metric) throw new BadRequestError(`Noma'lum ko'rsatkich: ${item?.metric}`);
    if (seen.has(metric.key)) {
      throw new BadRequestError(`"${metric.label}" ikki marta yuborilgan`);
    }
    seen.add(metric.key);

    const isEmpty = item.planValue == null || item.planValue === "";
    if (isEmpty) {
      plan.push({ metric: metric.key, remove: true });
      continue;
    }

    const planValue = parseMetricValue(metric, item.planValue, "reja");

    let actualValue = null;
    if (item.actualValue != null && item.actualValue !== "") {
      if (!allowsManualActual(metric.key)) {
        throw new BadRequestError(
          `"${metric.label}" amaldagi qiymati tizimdan hisoblanadi — qo'lda kiritilmaydi`,
        );
      }
      actualValue = parseMetricValue(metric, item.actualValue, "amaldagi qiymat");
    }

    plan.push({
      metric: metric.key,
      planValue,
      actualValue,
      note: String(item.note ?? "").trim().slice(0, 300),
    });
  }

  await prisma.$transaction(
    plan.map((row) =>
      row.remove
        ? prisma.financeTarget.deleteMany({ where: { month, metric: row.metric } })
        : prisma.financeTarget.upsert({
            where: { month_metric: { month, metric: row.metric } },
            create: {
              month,
              metric: row.metric,
              planValue: row.planValue,
              actualValue: row.actualValue,
              note: row.note,
              createdBy: userId,
              updatedBy: userId,
            },
            update: {
              planValue: row.planValue,
              actualValue: row.actualValue,
              note: row.note,
              updatedBy: userId,
            },
          }),
    ),
  );

  return getTargets({ month });
};

/**
 * Dashboard uchun ichki o'qish: `metric → { plan, actual }` (Decimal).
 * Belgilanmagan metrika xaritada UMUMAN bo'lmaydi — `null` va `0` ni
 * farqlash muhim: reja qo'yilmagan bo'lsa "bajarilish %" ham chizilmaydi.
 *
 * @param {number} month
 * @returns {Promise<Map<string, {plan: Decimal, actual: Decimal|null}>>}
 */
const loadTargetMap = async (month) => {
  const rows = await prisma.financeTarget.findMany({ where: { month } });
  return new Map(
    rows.map((row) => [
      row.metric,
      {
        plan: new Decimal(row.planValue),
        actual: row.actualValue != null ? new Decimal(row.actualValue) : null,
      },
    ]),
  );
};

module.exports = {
  getTargets,
  upsertTargets,
  loadTargetMap,
};
