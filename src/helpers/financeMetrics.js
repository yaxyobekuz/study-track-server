/**
 * RAHBAR DASHBOARDIDAGI KO'RSATKICHLAR KATALOGI.
 *
 * Bitta ro'yxat ikki narsani boshqaradi:
 *   1. `FinanceTarget.metric` da qanday kalit yozilishi mumkinligi (validatsiya)
 *   2. Reja ekranida qanday qatorlar chiqishi va ular qanday formatlanishi
 *
 * ⚠️ Kalitlar BAZAGA yoziladi — o'zgartirilsa mavjud rejalar "noma'lum
 * metrika" bo'lib qoladi. Yangi ko'rsatkich qo'shish mumkin, mavjudini
 * QAYTA NOMLASH mumkin emas (yorlig'ini o'zgartirish — mumkin).
 *
 * `manualActual` — tizimda AMALDAGI qiymatning manbasi yo'q degani.
 * Hozircha bittasi: NPS (ota-onalar so'rovi tizimda yuritilmaydi), shuning
 * uchun uning "amalda" ustuni qo'lda kiritiladi. Qolgan hamma ko'rsatkichda
 * amaldagi qiymat HISOBLANADI va qo'lda yozib bo'lmaydi — aks holda
 * hisobotni "chiroyli" qilib qo'yish bir daqiqalik ish bo'lardi.
 */

/** Qiymat turi — frontend formatlashni shundan biladi. */
const METRIC_KINDS = {
  MONEY: "money", // so'm
  PERCENT: "percent", // %
  COUNT: "count", // dona
};

/** Reja ekranidagi guruhlar. */
const METRIC_GROUPS = {
  PNL: "pnl", // moliyaviy natija (CFO byudjeti)
  KPI: "kpi", // maktab ko'rsatkichlari (CEO paneli)
  CUSTOM: "custom", // rahbar o'zi qo'shgan qatorlar
};

const FINANCE_METRICS = [
  {
    key: "income",
    label: "Jami tushum",
    kind: METRIC_KINDS.MONEY,
    group: METRIC_GROUPS.PNL,
    hint: "Kassaga tushgan butun pul",
  },
  {
    key: "expense",
    label: "Jami xarajat",
    kind: METRIC_KINDS.MONEY,
    group: METRIC_GROUPS.PNL,
    hint: "To'langan oylik + xarajatlar",
  },
  {
    key: "profit",
    label: "Sof foyda",
    kind: METRIC_KINDS.MONEY,
    group: METRIC_GROUPS.PNL,
    hint: "Tushum − xarajat",
  },
  {
    key: "margin",
    label: "Sof foyda margin",
    kind: METRIC_KINDS.PERCENT,
    group: METRIC_GROUPS.PNL,
    hint: "Sof foyda tushumga nisbatan",
  },
  {
    key: "cashBalance",
    label: "Pul qoldig'i",
    kind: METRIC_KINDS.MONEY,
    group: METRIC_GROUPS.PNL,
    hint: "Oy oxiridagi barcha to'lov turlari qoldig'i",
  },
  {
    key: "academicQuality",
    label: "Akademik sifat",
    kind: METRIC_KINDS.PERCENT,
    group: METRIC_GROUPS.KPI,
    hint: "Baholar jurnalidagi o'rtacha baho (5 ballik shkala)",
  },
  {
    key: "paymentDiscipline",
    label: "To'lov intizomi",
    kind: METRIC_KINDS.PERCENT,
    group: METRIC_GROUPS.KPI,
    hint: "Shu oy majburiyatining to'langan ulushi",
  },
  {
    key: "attendance",
    label: "Davomat",
    kind: METRIC_KINDS.PERCENT,
    group: METRIC_GROUPS.KPI,
    hint: "Keldi va kechikdi — jami darslarga nisbatan",
  },
  {
    key: "nps",
    label: "Ota-onalar qoniqishi (NPS)",
    kind: METRIC_KINDS.PERCENT,
    group: METRIC_GROUPS.KPI,
    hint: "So'rov natijasi — qo'lda kiritiladi",
    manualActual: true,
  },
  {
    key: "newAdmissions",
    label: "Yangi qabul",
    kind: METRIC_KINDS.COUNT,
    group: METRIC_GROUPS.KPI,
    hint: "Shu oyda ochilgan o'qish davrlari",
  },
];

const METRIC_BY_KEY = new Map(FINANCE_METRICS.map((m) => [m.key, m]));

/**
 * QO'LDA QO'SHILGAN QATOR — kalit prefiksi.
 *
 * Rahbar rejaga o'z satrini qo'sha oladi ("Tashqi qarz", "Ta'sischiga
 * to'lov"). Ularning nomi va turi BAZADA saqlanadi, katalogda emas.
 *
 * ⚠️ Kalit NOMDAN yasalmaydi, id dan yasaladi: aks holda qatorni qayta
 * nomlaganda u yangi qator bo'lib ketar va o'tgan oylarning rejasi
 * yetim qolardi.
 */
const CUSTOM_PREFIX = "custom:";

/** Kalit qo'lda qo'shilgan qatornikimi. */
const isCustomMetric = (key) =>
  typeof key === "string" && key.startsWith(CUSTOM_PREFIX);

/** Yangi qator uchun kalit. `VarChar(40)` ga sig'adi: 7 + 24 = 31 belgi. */
const buildCustomKey = (id) => `${CUSTOM_PREFIX}${id}`;

/**
 * Qo'lda qo'shilgan qator uchun soxta metrika ta'rifi.
 * Katalogdagi bilan bir xil shakl — chaqiruvchi kod farqini bilmasligi
 * kerak.
 */
const customMetric = (key, label, kind) => ({
  key,
  label: label || "Nomsiz qator",
  kind: Object.values(METRIC_KINDS).includes(kind) ? kind : METRIC_KINDS.MONEY,
  group: METRIC_GROUPS.CUSTOM,
  hint: "",
  // Tizimda manbasi yo'q — amaldagi qiymat qo'lda kiritiladi
  manualActual: true,
  isCustom: true,
});

/** Kalit katalogda bormi. */
const isMetricKey = (key) => METRIC_BY_KEY.has(key);

/** Metrika ta'rifi yoki `null`. */
const getMetric = (key) => METRIC_BY_KEY.get(key) ?? null;

/**
 * Faqat shu metrikalarda "amalda" qiymati qo'lda kiritiladi.
 * Qo'lda qo'shilgan qatorlarda esa BOSHQA yo'l yo'q — ularning tizimda
 * manbasi umuman yo'q.
 */
const allowsManualActual = (key) =>
  isCustomMetric(key) || Boolean(METRIC_BY_KEY.get(key)?.manualActual);

module.exports = {
  METRIC_KINDS,
  METRIC_GROUPS,
  FINANCE_METRICS,
  CUSTOM_PREFIX,
  isMetricKey,
  isCustomMetric,
  buildCustomKey,
  customMetric,
  getMetric,
  allowsManualActual,
};
