/**
 * TA'LIM DASHBOARDINING KO'RSATKICHLAR KATALOGI.
 *
 * Bitta ro'yxat ikki narsani boshqaradi:
 *   1. `AcademicTarget.metric` da qanday kalit yozilishi mumkinligi (validatsiya)
 *   2. Reja oynasida qanday qatorlar chiqishi va ular qanday formatlanishi
 *
 * ⚠️ Kalitlar BAZAGA yoziladi — o'zgartirilsa mavjud rejalar "noma'lum
 * ko'rsatkich" bo'lib qoladi. Yangi ko'rsatkich qo'shish mumkin, mavjudini
 * QAYTA NOMLASH mumkin emas (yorlig'ini o'zgartirish — mumkin).
 *
 * ⚠️ `financeMetrics.js` dan ATAYLAB alohida: u yerda reja bilan birga
 * "amalda" ustuni ham saqlanadi (NPS), bu yerda esa AMALDAGI QIYMAT DOIM
 * HISOBLANADI — baho, davomat, topshiriq va yutuq jadvallaridan. Qo'lda
 * yoziladigan "amalda" ustuni yo'q: u hisobotni "chiroyli" qilib
 * qo'yishning eng oson yo'li bo'lardi.
 */

/** Qiymat turi — frontend formatlashni shundan biladi. */
const METRIC_KINDS = {
  PERCENT: "percent", // %
  COUNT: "count", // dona
  GRADE: "grade", // 5 ballik shkala (4.32)
};

/**
 * Har bir turning yuqori chegarasi. Reja "900%" yoki "12 ball" bo'lib
 * ketmasligi uchun — bunday raqam bajarilish foizini ma'nosiz qiladi.
 */
const METRIC_MAX = {
  [METRIC_KINDS.PERCENT]: 100,
  [METRIC_KINDS.COUNT]: 100000,
  [METRIC_KINDS.GRADE]: 5,
};

const ACADEMIC_METRICS = [
  {
    key: "students",
    label: "Jami o'quvchilar",
    kind: METRIC_KINDS.COUNT,
    hint: "Shu oyda o'qish davri ochiq bo'lgan o'quvchilar",
  },
  {
    key: "averageGrade",
    label: "O'rtacha baho",
    kind: METRIC_KINDS.GRADE,
    hint: "Baholar jurnalidagi o'rtacha (5 ballik shkala)",
  },
  {
    key: "qualityRate",
    label: "A'lo va yaxshi",
    kind: METRIC_KINDS.PERCENT,
    hint: "4 va 5 baholarning barcha baholarga nisbati",
  },
  {
    key: "attendanceRate",
    label: "Davomat",
    kind: METRIC_KINDS.PERCENT,
    hint: "Keldi va kechikdi — barcha belgilarga nisbatan",
  },
  {
    key: "taskCompletion",
    label: "Topshiriq bajarish",
    kind: METRIC_KINDS.PERCENT,
    hint: "Muddati shu oyda tugagan topshiriqlardan bajarilgani",
  },
  {
    key: "achievements",
    label: "Olimpiada / musobaqa",
    kind: METRIC_KINDS.COUNT,
    hint: "Shu oyda qayd etilgan yutuqlar soni",
  },
];

const METRIC_MAP = new Map(ACADEMIC_METRICS.map((metric) => [metric.key, metric]));

/** Kalit bo'yicha ko'rsatkich (yo'q bo'lsa `null`). */
const getMetric = (key) => METRIC_MAP.get(key) ?? null;

/** Kalit katalogda bormi. */
const isKnownMetric = (key) => METRIC_MAP.has(key);

module.exports = {
  METRIC_KINDS,
  METRIC_MAX,
  ACADEMIC_METRICS,
  getMetric,
  isKnownMetric,
};
