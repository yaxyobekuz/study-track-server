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
  isCustomMetric,
  buildCustomKey,
  customMetric,
  allowsManualActual,
} = require("../helpers/financeMetrics");
const { generateId } = require("../utils/idGenerator");

/** Foizli ko'rsatkich 0..100 dan chiqmasligi kerak — 900% "reja" ma'nosiz. */
const MAX_PERCENT = 100;
/** Sanoq ko'rsatkichi (yangi qabul) — aqlga sig'adigan chegara. */
const MAX_COUNT = 100000;

/** Qo'lda qo'shilgan qatorlar soni — ekran ham, so'rov ham cheklangan. */
const MAX_CUSTOM_ROWS = 30;

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

  const rows = await prisma.financeTarget.findMany({
    where: { month },
    orderBy: { createdAt: "asc" },
  });
  const byMetric = new Map(rows.map((row) => [row.metric, row]));

  const serialize = (metric, row) => ({
    metric: metric.key,
    label: metric.label,
    kind: metric.kind,
    group: metric.group,
    hint: metric.hint ?? "",
    manualActual: Boolean(metric.manualActual),
    isCustom: Boolean(metric.isCustom),
    planValue: row ? formatAmount(row.planValue) : null,
    actualValue: row?.actualValue != null ? formatAmount(row.actualValue) : null,
    note: row?.note ?? "",
    updatedAt: row?.updatedAt ?? null,
  });

  // Katalog metrikalari — HAMMASI, belgilanmagani ham (`planValue: null`).
  // Qo'lda qo'shilganlari esa faqat bazada BOR bo'lganlari: ular oldindan
  // ma'lum ro'yxat emas.
  const catalog = FINANCE_METRICS.map((metric) => serialize(metric, byMetric.get(metric.key)));
  const custom = rows
    .filter((row) => isCustomMetric(row.metric))
    .map((row) => serialize(customMetric(row.metric, row.label, row.kind), row));

  return {
    month,
    monthLabel: formatMonthKey(month),
    items: [...catalog, ...custom],
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
  if (data.items.length > FINANCE_METRICS.length + MAX_CUSTOM_ROWS) {
    throw new BadRequestError("Reja qatorlari juda ko'p");
  }

  // ── Avval HAMMASI tekshiriladi, keyin yoziladi ──────────────────────
  // Yarim yozilgan reja ("uchtasi tushdi, to'rtinchisi xato berdi") eng
  // yomon holat: rahbar ekranda nima saqlanganini bilmay qoladi.
  const seen = new Set();
  const plan = [];

  let customCount = 0;

  for (const item of data.items) {
    // ── Qatorni aniqlash ────────────────────────────────────────────
    // Kalit yo'q yoki "custom:" bilan boshlansa — bu rahbar qo'shgan
    // qator. Uning nomi va turi SO'ROVDAN keladi, katalogdan emas.
    const raw = item?.metric;
    const custom = !raw || isCustomMetric(raw);
    const isEmpty = item.planValue == null || item.planValue === "";

    // ⚠️ O'CHIRISH NOMNI TALAB QILMAYDI. Bo'sh reja — "qatorni olib
    // tashla" degani va bunda faqat KALIT kerak. Nomni bu yerda ham
    // majburiy qilsak, ekrandan o'chirilgan qator hech qachon serverga
    // yetib bormasdi.
    if (isEmpty) {
      if (!raw) continue; // hali saqlanmagan bo'sh qator — e'tiborsiz
      if (seen.has(raw)) throw new BadRequestError("Qator ikki marta yuborilgan");
      seen.add(raw);
      plan.push({ metric: raw, remove: true });
      continue;
    }

    let metric;
    if (custom) {
      const label = String(item?.label ?? "").trim();
      if (!label) throw new BadRequestError("Qator nomi kiritilmagan");
      if (label.length > 60) throw new BadRequestError("Qator nomi juda uzun");

      // Yangi qatorga kalit SHU YERDA beriladi: frontend id o'ylab
      // topmasligi kerak, aks holda ikki brauzerda bir xil kalit chiqishi
      // mumkin edi
      metric = customMetric(raw || buildCustomKey(generateId()), label, item?.kind);
      customCount += 1;
      if (customCount > MAX_CUSTOM_ROWS) {
        throw new BadRequestError(
          `Qo'lda qo'shilgan qatorlar ${MAX_CUSTOM_ROWS} tadan oshmasligi kerak`,
        );
      }
    } else {
      metric = getMetric(raw);
      if (!metric) throw new BadRequestError(`Noma'lum ko'rsatkich: ${raw}`);
    }

    if (seen.has(metric.key)) {
      throw new BadRequestError(`"${metric.label}" ikki marta yuborilgan`);
    }
    seen.add(metric.key);

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
      // Nom va tur FAQAT custom qatorda saqlanadi — katalog metrikasida
      // ular koddan o'qiladi
      label: metric.isCustom ? metric.label : "",
      kind: metric.isCustom ? metric.kind : METRIC_KINDS.MONEY,
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
              label: row.label,
              kind: row.kind,
              planValue: row.planValue,
              actualValue: row.actualValue,
              note: row.note,
              createdBy: userId,
              updatedBy: userId,
            },
            update: {
              label: row.label,
              kind: row.kind,
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
        label: row.label,
        kind: row.kind,
      },
    ]),
  );
};

/**
 * Dashboarddagi "Budjet ijrosi" jadvaliga tushadigan QO'LDA qo'shilgan
 * qatorlar.
 *
 * Ularning amaldagi qiymati ham qo'lda kiritiladi — tizimda manbasi yo'q.
 * Kiritilmagan bo'lsa `actual: null` va jadvalda "—" turadi: nol deb
 * ko'rsatish "reja bajarilmadi" degan yolg'on xulosa berardi.
 *
 * @param {number} month
 */
const loadCustomTargets = async (month) => {
  const rows = await prisma.financeTarget.findMany({
    where: { month },
    orderBy: { createdAt: "asc" },
  });

  return rows
    .filter((row) => isCustomMetric(row.metric))
    .map((row) => ({
      key: row.metric,
      label: row.label || "Nomsiz qator",
      kind: Object.values(METRIC_KINDS).includes(row.kind)
        ? row.kind
        : METRIC_KINDS.MONEY,
      plan: new Decimal(row.planValue),
      actual: row.actualValue != null ? new Decimal(row.actualValue) : null,
    }));
};

module.exports = {
  getTargets,
  upsertTargets,
  loadTargetMap,
  loadCustomTargets,
};
