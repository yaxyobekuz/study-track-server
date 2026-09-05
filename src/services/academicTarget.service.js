/**
 * AKADEMIK REJA — ta'lim dashboardidagi "Reja:" raqamlari.
 *
 * Dashboarddagi har bir ko'rsatkichning AMALDAGI qiymati tizimdan
 * hisoblanadi; "shuncha bo'lishi kerak edi" degan raqam esa o'quv
 * bo'limining qarori va faqat shu yerda saqlanadi.
 *
 * ⚠️ `financeTarget.service.js` ning ko'zgusi, lekin IKKI FARQI BOR:
 *   1. Qo'lda qo'shiladigan ("custom:") qatorlar YO'Q — akademik
 *      ko'rsatkichlar ro'yxati yopiq, chunki ularning har biri aniq bir
 *      jadvaldan hisoblanadi. Erkin qator qo'shilsa, uning amaldagi
 *      qiymatini hech narsa bermasdi.
 *   2. "Amalda" ustuni YO'Q — hammasi hisoblanadi.
 *
 * ⚠️ Bu service PULGA TEGMAYDI: lock tartibi ham, tranzaksiya ham kerak
 * emas. Bitta oyning qatorlari `upsert` bilan yoziladi.
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
  ACADEMIC_METRICS,
  METRIC_KINDS,
  METRIC_MAX,
  getMetric,
} = require("../helpers/academicMetrics");

/**
 * Bitta qiymatni ko'rsatkich turiga qarab tekshiradi.
 *
 * Uch tur ham bitta `Decimal(14,2)` ustuniga tushadi — kalitning o'zi
 * qaysi biri ekanini bir ma'noda aytadi.
 *
 * @param {object} metric - ACADEMIC_METRICS elementi
 * @param {*} raw
 * @returns {Decimal}
 */
const parseMetricValue = (metric, raw) => {
  let value;
  try {
    value = new Decimal(raw);
  } catch {
    throw new BadRequestError(`${metric.label}: reja noto'g'ri formatda`);
  }

  if (!value.isFinite() || value.isNegative()) {
    throw new BadRequestError(`${metric.label}: reja manfiy bo'lishi mumkin emas`);
  }
  if (value.decimalPlaces() > 2) {
    throw new BadRequestError(`${metric.label}: reja 2 xonagacha kasr bo'lishi kerak`);
  }

  // ⚠️ Sanoq ko'rsatkichi butun bo'ladi: "1300.5 ta o'quvchi" degan reja
  // bajarilish foizini ham, jadvaldagi ustunni ham ma'nosiz qilardi.
  if (metric.kind === METRIC_KINDS.COUNT && !value.isInteger()) {
    throw new BadRequestError(`${metric.label}: reja butun son bo'lishi kerak`);
  }

  const max = METRIC_MAX[metric.kind];
  if (max != null && value.greaterThan(max)) {
    throw new BadRequestError(`${metric.label}: reja ${max} dan oshmasligi kerak`);
  }

  return value;
};

/**
 * Bir oyning reja qatorlari — katalogdagi HAMMA ko'rsatkich qaytariladi,
 * belgilanmaganida `planValue: null`.
 *
 * Frontend shu ro'yxatni to'g'ridan-to'g'ri formaga aylantiradi: qaysi
 * ko'rsatkichlar borligini u bilishi shart emas (katalog serverda).
 *
 * @param {{month?: number|string}} query
 */
const getTargets = async (query = {}) => {
  const month = parseOptionalMonthKey(query.month, "Oy") ?? currentMonthKey();

  const rows = await prisma.academicTarget.findMany({ where: { month } });
  const byMetric = new Map(rows.map((row) => [row.metric, row]));

  return {
    month,
    monthLabel: formatMonthKey(month),
    items: ACADEMIC_METRICS.map((metric) => {
      const row = byMetric.get(metric.key);

      return {
        metric: metric.key,
        label: metric.label,
        kind: metric.kind,
        hint: metric.hint ?? "",
        planValue: row ? formatAmount(row.planValue) : null,
        updatedAt: row?.updatedAt ?? null,
      };
    }),
  };
};

/**
 * Bir oyning rejasini yozadi.
 *
 * Yuborilgan ko'rsatkichlargina tegiladi: `planValue: null` (yoki bo'sh
 * satr) kelgan qator O'CHIRILADI — "rejani olib tashlash" uchun alohida
 * endpoint ochishning ma'nosi yo'q. Yuborilmagani esa o'z holicha qoladi.
 *
 * ⚠️ AVVAL HAMMASI TEKSHIRILADI, KEYIN YOZILADI. Yarim yozilgan reja
 * ("uchtasi tushdi, to'rtinchisi xato berdi") eng yomon holat: rahbar
 * ekranda nima saqlanganini bilmay qoladi.
 *
 * @param {{month: number|string, items: Array<{metric: string, planValue?: *}>}} data
 * @param {string} userId
 */
const upsertTargets = async (data = {}, userId) => {
  const month = parseMonthKey(data.month, "Oy");

  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw new BadRequestError("Reja qatorlari yuborilmadi");
  }
  if (data.items.length > ACADEMIC_METRICS.length) {
    throw new BadRequestError("Reja qatorlari juda ko'p");
  }

  const seen = new Set();
  const plan = [];

  for (const item of data.items) {
    const key = String(item?.metric ?? "");
    const metric = getMetric(key);

    if (!metric) throw new BadRequestError(`Noma'lum ko'rsatkich: ${key || "—"}`);
    if (seen.has(key)) throw new BadRequestError("Qator ikki marta yuborilgan");
    seen.add(key);

    // Bo'sh reja — "qatorni olib tashla" degani
    if (item.planValue == null || item.planValue === "") {
      plan.push({ metric: key, remove: true });
      continue;
    }

    plan.push({ metric: key, planValue: parseMetricValue(metric, item.planValue) });
  }

  const removals = plan.filter((row) => row.remove).map((row) => row.metric);
  const writes = plan.filter((row) => !row.remove);

  if (removals.length > 0) {
    await prisma.academicTarget.deleteMany({ where: { month, metric: { in: removals } } });
  }

  for (const row of writes) {
    await prisma.academicTarget.upsert({
      where: { month_metric: { month, metric: row.metric } },
      create: {
        month,
        metric: row.metric,
        planValue: row.planValue,
        createdBy: userId,
        updatedBy: userId,
      },
      update: { planValue: row.planValue, updatedBy: userId },
    });
  }

  return getTargets({ month });
};

/**
 * Dashboard uchun reja xaritasi: `Map<metric, Decimal>`.
 *
 * ⚠️ Dashboard `getTargets()` ni CHAQIRMAYDI: u yerda qiymatlar allaqachon
 * `formatAmount()` bilan STRING'ga aylangan bo'lardi va bajarilish foizini
 * hisoblash uchun qayta `Decimal` ga o'girish kerak bo'lardi.
 *
 * @param {number} month
 * @returns {Promise<Map<string, Decimal>>}
 */
const loadTargetMap = async (month) => {
  const rows = await prisma.academicTarget.findMany({ where: { month } });

  return new Map(rows.map((row) => [row.metric, new Decimal(row.planValue)]));
};

module.exports = {
  getTargets,
  upsertTargets,
  loadTargetMap,
};
