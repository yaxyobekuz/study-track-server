/**
 * BAHOLAR TAHLILI — QOIDALAR DVIGATELI (sof funksiyalar, bazaga tegmaydi).
 *
 * Bitta o'quvchi uchun:
 *   1. `buildStudentFacts`  — XOM FAKTLAR: fanlar, mavzular, trend, sinfga
 *                             nisbatan o'rni, davomat ta'siri, diagnostika
 *   2. `detectFindings`     — kuchli tomonlar va SABABLAR (kodli ro'yxat)
 *   3. `buildViews`         — uch auditoriya uchun matn: o'quvchi ("siz"),
 *                             ota-ona ("farzandingiz"), xodim
 *
 * Qamrov (maktab / sinflar) uchun:
 *   4. `buildOverview`      — dashboard yig'masi (fanlar, sinf×fan xaritasi,
 *                             zaif mavzular, sabablar, xavf ostidagilar)
 *   5. `buildOverviewNarrative` — rahbariyat uchun qoidalar xulosasi
 *
 * ⚠️ RAQAMNI FAQAT SHU FAYL HISOBLAYDI. AI qatlami (`gradeAnalysisAi.service.js`)
 * shu faktlardan faqat MATN yozadi va har bir sonini shu faktlar bilan
 * solishtiradi. Yangi ko'rsatkich qo'shilsa — u faktlarga ham qo'shilishi
 * shart, aks holda model u haqda yozgan matn rad etiladi.
 *
 * ⚠️ SABAB — TAXMIN EMAS, ANIQ SHART. Har bir sabab kodining yonida uni
 * yoqadigan shart yozilgan (`THRESHOLDS`). "Bilimi yetmaydi" kabi umumiy
 * gap chiqmaydi: sabab yo davomatdan, yo sinf bilan taqqoslashdan, yo baho
 * dinamikasidan, yo diagnostika xatolarining turidan keladi.
 *
 * ⚠️ MA'LUMOT YETMASA XULOSA YO'Q. Kesim uchun baholar kam bo'lsa u
 * `dataGaps` ga tushadi va o'sha kesim bo'yicha na sabab, na tavsiya
 * yoziladi: bitta 2 baho "fan oqsayapti" degan xulosaga asos emas.
 */

/* ─────────────────────────── DAVRLAR ─────────────────────────── */

/**
 * Tahlil davrlari. Oyna — BUGUNDAN orqaga `days` kun (bugun ham kiradi).
 *
 * ⚠️ Kalendar oy/chorak EMAS, "oxirgi N kun": admin "1 oylik" deb bosganda
 * 3-sentabrda ham to'liq bir oylik ma'lumot ko'rishi kerak — kalendar
 * oyning 3 kuni tahlilga yaramaydi.
 */
const GRADE_ANALYSIS_PERIODS = Object.freeze({
  week: Object.freeze({ key: "week", label: "1 hafta", title: "Haftalik", days: 7 }),
  month: Object.freeze({ key: "month", label: "1 oy", title: "Oylik", days: 30 }),
  quarter: Object.freeze({ key: "quarter", label: "3 oy", title: "3 oylik", days: 91 }),
  half: Object.freeze({ key: "half", label: "6 oy", title: "Yarim yillik", days: 182 }),
  year: Object.freeze({ key: "year", label: "1 yil", title: "Yillik", days: 365 }),
});

const PERIOD_KEYS = Object.freeze(Object.keys(GRADE_ANALYSIS_PERIODS));

/* ─────────────────────────── DARAJALAR ─────────────────────────── */

/**
 * Umumiy o'rtacha bo'yicha daraja. Chegaralar 5 ballik shkalada.
 *
 * ⚠️ `insufficient` — baho `THRESHOLDS.minGradesOverall` dan kam: bitta-ikkita
 * baho bilan o'quvchiga "xavfli" yorlig'ini yopishtirish adolatsiz bo'lardi.
 */
const LEVELS = Object.freeze([
  Object.freeze({ key: "excellent", label: "A'lo", min: 4.5 }),
  Object.freeze({ key: "good", label: "Yaxshi", min: 3.9 }),
  Object.freeze({ key: "average", label: "O'rta", min: 3.3 }),
  Object.freeze({ key: "weak", label: "Past", min: 2.8 }),
  Object.freeze({ key: "critical", label: "Xavfli", min: 0 }),
]);

const INSUFFICIENT_LEVEL = Object.freeze({ key: "insufficient", label: "Ma'lumot yetarli emas" });

const LEVEL_KEYS = Object.freeze([...LEVELS.map((level) => level.key), INSUFFICIENT_LEVEL.key]);

/* ─────────────────────────── CHEGARALAR ─────────────────────────── */

/**
 * Har bir sabab/kuchli tomonni YOQADIGAN shartlar — bitta joyda.
 *
 * Qiymatlar 5 ballik shkala va maktab amaliyotidan: 0.5 ball — sinfdagi
 * ikki o'quvchi orasidagi sezilarli farq; 1.0 standart og'ish — "2 ham,
 * 5 ham oladi" darajasidagi beqarorlik.
 */
const THRESHOLDS = Object.freeze({
  // Ma'lumot yetarliligi
  minGradesOverall: 3,
  minGradesSubject: 2,
  minGradesTrend: 4,
  minGradesUnstable: 5,
  minGradesTopic: 2,
  // Fan holati
  strongAverage: 4.5,
  goodAverage: 3.9,
  weakAverage: 3.5,
  criticalAverage: 3.0,
  // Dinamika
  trendDelta: 0.5, // fan: davr boshi → oxiri
  overallDelta: 0.3, // umumiy: o'tgan davrga nisbatan
  // Sinf bilan taqqoslash
  classGap: 0.5,
  classWideAverage: 3.6, // sinf o'rtachasi shundan past — fan butun sinfga qiyin
  // Beqarorlik
  unstableStdev: 1.0,
  // Ketma-ket past baholar
  lowStreakLength: 3,
  lowStreakMax: 3,
  // Mavzu
  weakTopicAverage: 3.5,
  strongTopicAverage: 4.6,
  // Davomat
  lowAttendanceRate: 85,
  minAbsentDays: 3,
  afterAbsenceDays: 7, // qoldirilgan kundan keyingi shuncha kun ichidagi baholar
  absenceImpactGap: 0.3,
  minGradesImpact: 2,
  // Diagnostika
  diagWeakScore: 60,
  diagStrongScore: 85,
  diagPatternShare: 40, // xatolarning shuncha foizi bitta sababdan
  diagMinWrong: 3,
  // Xavf
  riskAlert: 50,
});

/* ─────────────────────────── YORDAMCHILAR ─────────────────────────── */

const round = (value, digits = 2) => {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const mean = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

const stdev = (values) => {
  if (values.length < 2) return null;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length);
};

/** O'rtacha baho matni: har doim ikki xona ("4.30") — jadvaldagi bilan bir xil. */
const fmt = (value) => (value == null ? "—" : Number(value).toFixed(2));

/** Farq matni: "+0.40" / "−0.35". */
const fmtDelta = (value) => {
  if (value == null) return "—";
  const abs = Math.abs(value).toFixed(2);
  return value > 0 ? `+${abs}` : value < 0 ? `−${abs}` : abs;
};

const emptyDistribution = () => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });

const distributionOf = (values) => {
  const out = emptyDistribution();
  for (const value of values) if (out[value] != null) out[value] += 1;
  return out;
};

/** 4 va 5 baholar ulushi, % (butun). */
const qualityRate = (values) =>
  values.length ? Math.round((values.filter((value) => value >= 4).length / values.length) * 100) : null;

/** "YYYY-MM-DD" ga kun qo'shish (taymzonasiz, sof kalendar). */
const shiftDay = (iso, days) =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);

const levelOf = (average, count) => {
  if (average == null || count < THRESHOLDS.minGradesOverall) return INSUFFICIENT_LEVEL;
  return LEVELS.find((level) => average >= level.min) ?? LEVELS[LEVELS.length - 1];
};

const levelLabel = (key) =>
  key === INSUFFICIENT_LEVEL.key
    ? INSUFFICIENT_LEVEL.label
    : LEVELS.find((level) => level.key === key)?.label ?? key;

/**
 * Fan holati — ekrandagi chip va sabab qidiruvining boshlang'ich nuqtasi.
 * @returns {"strong"|"good"|"watch"|"weak"|"critical"|"insufficient"}
 */
const subjectStatusOf = (average, count) => {
  if (average == null || count < THRESHOLDS.minGradesSubject) return "insufficient";
  if (average >= THRESHOLDS.strongAverage) return "strong";
  if (average >= THRESHOLDS.goodAverage) return "good";
  if (average >= THRESHOLDS.weakAverage) return "watch";
  if (average >= THRESHOLDS.criticalAverage) return "weak";
  return "critical";
};

/** Davr ichidagi dinamika: xronologik birinchi yarmi → ikkinchi yarmi. */
const halvesOf = (ordered) => {
  if (ordered.length < THRESHOLDS.minGradesTrend) return null;
  const middle = Math.floor(ordered.length / 2);
  const first = round(mean(ordered.slice(0, middle)));
  const second = round(mean(ordered.slice(ordered.length - middle)));
  return { first, second, change: round(second - first) };
};

/* ───────────────────────── 1. FAKTLAR ───────────────────────── */

/**
 * Bitta o'quvchining xom faktlari.
 *
 * @param {object} input
 * @param {{key: string, label: string, title: string, days: number, from: string, to: string, rangeLabel: string}} input.period
 * @param {{className?: string|null}} input.student
 * @param {Array<{subjectId: string, grade: number, dayKey: string, topicId?: string|null}>} input.grades - davr baholari
 * @param {Record<string, {sum: number, count: number}>} [input.previous] - o'tgan davr, fan bo'yicha
 * @param {Map<string, string>|Record<string, string>} input.subjectNames
 * @param {Map<string, {name: string, subjectId: string}>} [input.topics]
 * @param {Record<string, {average: number, count: number}>} [input.classBench] - o'quvchi sinfining fan o'rtachalari
 * @param {Record<string, {average: number, count: number}>} [input.classTopicBench]
 * @param {{present: number, late: number, absent: number, excused: number, absentDays: string[]}|null} [input.attendance]
 * @param {Array<{subjectName?: string|null, score?: number|null, breakdown?: any, errorPatterns?: any}>} [input.diagnostics]
 * @returns {object} faktlar
 */
function buildStudentFacts(input) {
  const {
    period,
    student = {},
    grades = [],
    previous = {},
    subjectNames,
    topics = new Map(),
    classBench = {},
    classTopicBench = {},
    attendance = null,
    diagnostics = [],
  } = input;

  const nameOf = (id) =>
    (subjectNames instanceof Map ? subjectNames.get(id) : subjectNames?.[id]) || "Noma'lum fan";

  const ordered = [...grades].sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0));
  const values = ordered.map((row) => row.grade);

  // ── Umumiy ──
  let prevSum = 0;
  let prevCount = 0;
  for (const row of Object.values(previous)) {
    prevSum += row.sum;
    prevCount += row.count;
  }

  const overallAverage = round(mean(values));
  const previousAverage = prevCount >= THRESHOLDS.minGradesOverall ? round(prevSum / prevCount) : null;
  const halves = halvesOf(values);

  const overall = {
    average: overallAverage,
    count: values.length,
    qualityRate: qualityRate(values),
    distribution: distributionOf(values),
    previousAverage,
    previousCount: prevCount,
    delta:
      overallAverage != null && previousAverage != null ? round(overallAverage - previousAverage) : null,
    firstHalf: halves?.first ?? null,
    secondHalf: halves?.second ?? null,
    change: halves?.change ?? null,
  };

  // ── Fanlar ──
  const bySubject = new Map();
  for (const row of ordered) {
    if (!bySubject.has(row.subjectId)) bySubject.set(row.subjectId, []);
    bySubject.get(row.subjectId).push(row);
  }

  const subjects = [];
  for (const [subjectId, rows] of bySubject) {
    const list = rows.map((row) => row.grade);
    const average = round(mean(list));
    const prev = previous[subjectId];
    const previousSubjectAverage =
      prev && prev.count >= THRESHOLDS.minGradesSubject ? round(prev.sum / prev.count) : null;
    const trend = halvesOf(list);
    const deviation = list.length >= THRESHOLDS.minGradesUnstable ? round(stdev(list)) : null;
    const bench = classBench[subjectId];
    const classAverage = bench && bench.count >= THRESHOLDS.minGradesSubject ? round(bench.average) : null;
    const lastGrades = list.slice(-5);
    const tail = list.slice(-THRESHOLDS.lowStreakLength);

    subjects.push({
      id: subjectId,
      name: nameOf(subjectId),
      average,
      count: list.length,
      distribution: distributionOf(list),
      qualityRate: qualityRate(list),
      min: Math.min(...list),
      max: Math.max(...list),
      previousAverage: previousSubjectAverage,
      delta:
        average != null && previousSubjectAverage != null ? round(average - previousSubjectAverage) : null,
      firstHalf: trend?.first ?? null,
      secondHalf: trend?.second ?? null,
      change: trend?.change ?? null,
      stdev: deviation,
      classAverage,
      vsClass: average != null && classAverage != null ? round(average - classAverage) : null,
      lastGrades,
      lowStreak:
        tail.length === THRESHOLDS.lowStreakLength && tail.every((grade) => grade <= THRESHOLDS.lowStreakMax),
      status: subjectStatusOf(average, list.length),
    });
  }

  // Tartib — O'RTACHA bo'yicha kamayish (alifbo emas): ekranda fanlar
  // yuqoridan pastga "kuchli → zaif" o'qiladi.
  subjects.sort((a, b) => (b.average ?? 0) - (a.average ?? 0) || a.name.localeCompare(b.name));

  // ── Mavzular (faqat mavzusi yozilgan baholar) ──
  const byTopic = new Map();
  let covered = 0;
  for (const row of ordered) {
    if (!row.topicId) continue;
    const topic = topics.get(row.topicId);
    if (!topic) continue;
    covered += 1;
    if (!byTopic.has(row.topicId)) byTopic.set(row.topicId, []);
    byTopic.get(row.topicId).push(row.grade);
  }

  const topicRows = [];
  for (const [topicId, list] of byTopic) {
    if (list.length < THRESHOLDS.minGradesTopic) continue;
    const topic = topics.get(topicId);
    const bench = classTopicBench[topicId];
    topicRows.push({
      id: topicId,
      name: topic.name,
      subjectId: topic.subjectId,
      subject: nameOf(topic.subjectId),
      average: round(mean(list)),
      count: list.length,
      classAverage: bench && bench.count >= THRESHOLDS.minGradesTopic ? round(bench.average) : null,
    });
  }

  const weakTopics = topicRows
    .filter((row) => row.average < THRESHOLDS.weakTopicAverage)
    .sort((a, b) => a.average - b.average)
    .slice(0, 6);
  const strongTopics = topicRows
    .filter((row) => row.average >= THRESHOLDS.strongTopicAverage)
    .sort((a, b) => b.average - a.average)
    .slice(0, 6);

  const topicFacts = {
    covered,
    coverage: values.length ? Math.round((covered / values.length) * 100) : 0,
    weak: weakTopics,
    strong: strongTopics,
  };

  // ── Davomat ──
  let attendanceFacts = null;
  if (attendance) {
    const marked = attendance.present + attendance.late + attendance.absent + attendance.excused;
    if (marked > 0) {
      // Qoldirilgan kundan keyingi `afterAbsenceDays` kun ichidagi baholar
      const windows = (attendance.absentDays || []).map((day) => [day, shiftDay(day, THRESHOLDS.afterAbsenceDays)]);
      const after = [];
      const regular = [];
      for (const row of ordered) {
        const hit = windows.some(([start, end]) => row.dayKey > start && row.dayKey <= end);
        (hit ? after : regular).push(row.grade);
      }

      const impactReady =
        after.length >= THRESHOLDS.minGradesImpact && regular.length >= THRESHOLDS.minGradesImpact;

      attendanceFacts = {
        marked,
        present: attendance.present,
        late: attendance.late,
        absent: attendance.absent,
        excused: attendance.excused,
        rate: Math.round(((attendance.present + attendance.late) / marked) * 100),
        afterAbsenceAverage: impactReady ? round(mean(after)) : null,
        regularAverage: impactReady ? round(mean(regular)) : null,
      };
    }
  }

  // ── Diagnostika ──
  let diagnosticFacts = null;
  const attempts = diagnostics.filter((attempt) => attempt && Number.isFinite(attempt.score));
  if (attempts.length) {
    const topicScores = new Map();
    let wrongTotal = 0;
    const patternWeighted = { rushing: 0, knowledge: 0, misread: 0 };

    for (const attempt of attempts) {
      for (const item of Array.isArray(attempt.breakdown) ? attempt.breakdown : []) {
        if (!item?.topic || !Number.isFinite(item.questions) || item.questions <= 0) continue;
        const key = `${attempt.subjectName || ""}|${item.topic}`;
        const acc = topicScores.get(key) ?? {
          topic: String(item.topic),
          subject: attempt.subjectName || null,
          questions: 0,
          correct: 0,
        };
        acc.questions += item.questions;
        acc.correct += Number.isFinite(item.correct) ? item.correct : 0;
        topicScores.set(key, acc);
      }

      // Xato sabablari foizda keladi — xatolar soni bilan tortiladi
      const patterns = attempt.errorPatterns;
      const wrong = Number(patterns?.wrongCount) || 0;
      if (wrong > 0) {
        wrongTotal += wrong;
        for (const key of Object.keys(patternWeighted)) {
          patternWeighted[key] += ((Number(patterns[key]) || 0) / 100) * wrong;
        }
      }
    }

    const topicList = [...topicScores.values()]
      .filter((row) => row.questions >= 2)
      .map((row) => ({ ...row, score: Math.round((row.correct / row.questions) * 100) }));

    diagnosticFacts = {
      attempts: attempts.length,
      averageScore: Math.round(mean(attempts.map((attempt) => attempt.score))),
      weakTopics: topicList
        .filter((row) => row.score < THRESHOLDS.diagWeakScore)
        .sort((a, b) => a.score - b.score)
        .slice(0, 5),
      strongTopics: topicList
        .filter((row) => row.score >= THRESHOLDS.diagStrongScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3),
      errorPatterns:
        wrongTotal > 0
          ? {
              wrongCount: wrongTotal,
              rushing: Math.round((patternWeighted.rushing / wrongTotal) * 100),
              knowledge: Math.round((patternWeighted.knowledge / wrongTotal) * 100),
              misread: Math.round((patternWeighted.misread / wrongTotal) * 100),
            }
          : null,
    };
  }

  // ── Ma'lumot bo'shliqlari ──
  const dataGaps = [];
  if (values.length < THRESHOLDS.minGradesOverall) {
    dataGaps.push({ key: "grades", message: "Bu davrda baholar tahlil uchun yetarli emas" });
  }
  if (previousAverage == null) {
    dataGaps.push({ key: "previous", message: "O'tgan davr bilan solishtirish uchun baholar yetarli emas" });
  }
  if (topicFacts.covered === 0) {
    dataGaps.push({ key: "topics", message: "Baholarda dars mavzusi belgilanmagan" });
  }
  if (!attendanceFacts) dataGaps.push({ key: "attendance", message: "Davomat belgilanmagan" });
  if (!diagnosticFacts) dataGaps.push({ key: "diagnostics", message: "Diagnostika testi topshirilmagan" });

  return {
    period: {
      key: period.key,
      label: period.label,
      title: period.title,
      days: period.days,
      from: period.from,
      to: period.to,
      rangeLabel: period.rangeLabel,
    },
    className: student.className || null,
    overall,
    subjects,
    topics: topicFacts,
    attendance: attendanceFacts,
    diagnostics: diagnosticFacts,
    dataGaps,
  };
}

/* ───────────────────────── 2. TOPILMALAR ───────────────────────── */

/** Topilma ohangi — ekrandagi rang va ustuvorlik shundan. */
const TONES = Object.freeze({ POSITIVE: "positive", WARNING: "warning", CRITICAL: "critical", INFO: "info" });

/**
 * Topilma kodlari — mobil ilova va admin shu kalitlar bo'yicha ikonka
 * tanlaydi. ⚠️ QAYTA NOMLANMAYDI (bazada muhrlangan hisobotlarda turadi).
 */
const FINDING_CODES = Object.freeze({
  STRONG_SUBJECT: "strong_subject",
  IMPROVING_SUBJECT: "improving_subject",
  ABOVE_CLASS: "above_class",
  OVERALL_IMPROVING: "overall_improving",
  STRONG_TOPIC: "strong_topic",
  WEAK_SUBJECT: "weak_subject",
  DECLINING_SUBJECT: "declining_subject",
  OVERALL_DECLINING: "overall_declining",
  BELOW_CLASS: "below_class",
  CLASS_WIDE_DIFFICULTY: "class_wide_difficulty",
  UNSTABLE_SUBJECT: "unstable_subject",
  LOW_STREAK: "low_streak",
  WEAK_TOPIC: "weak_topic",
  ABSENCE_IMPACT: "absence_impact",
  LOW_ATTENDANCE: "low_attendance",
  DIAG_WEAK_TOPIC: "diag_weak_topic",
  DIAG_RUSHING: "diag_rushing",
  DIAG_MISREAD: "diag_misread",
  DIAG_KNOWLEDGE: "diag_knowledge",
});

/** Sabab kodlarining yorliqlari — dashboarddagi "asosiy sabablar" kartasi uchun. */
const CAUSE_LABELS = Object.freeze({
  [FINDING_CODES.WEAK_SUBJECT]: "Past o'zlashtirilgan fan",
  [FINDING_CODES.DECLINING_SUBJECT]: "Fan bo'yicha pasayish",
  [FINDING_CODES.OVERALL_DECLINING]: "Umumiy pasayish",
  [FINDING_CODES.BELOW_CLASS]: "Sinfdan ortda qolish",
  [FINDING_CODES.CLASS_WIDE_DIFFICULTY]: "Fan butun sinfga qiyin",
  [FINDING_CODES.UNSTABLE_SUBJECT]: "Beqaror natija",
  [FINDING_CODES.LOW_STREAK]: "Ketma-ket past baholar",
  [FINDING_CODES.WEAK_TOPIC]: "Zaif mavzu",
  [FINDING_CODES.ABSENCE_IMPACT]: "Dars qoldirish ta'siri",
  [FINDING_CODES.LOW_ATTENDANCE]: "Past davomat",
  [FINDING_CODES.DIAG_WEAK_TOPIC]: "Diagnostikada zaif mavzu",
  [FINDING_CODES.DIAG_RUSHING]: "Shoshilish",
  [FINDING_CODES.DIAG_MISREAD]: "Shartni diqqatsiz o'qish",
  [FINDING_CODES.DIAG_KNOWLEDGE]: "Bilim bo'shlig'i",
});

const NEGATIVE_TONES = new Set([TONES.WARNING, TONES.CRITICAL]);

/**
 * Faktlardan topilmalar. Har birida `code`, `tone` va o'sha xulosaga asos
 * bo'lgan raqamlar (`metrics`) — matn shu raqamlardan quriladi.
 *
 * @param {object} facts - `buildStudentFacts` natijasi
 * @returns {Array<{code: string, tone: string, subjectId?: string, subject?: string, topic?: string, metrics: object}>}
 */
function detectFindings(facts) {
  const findings = [];
  const push = (code, tone, extra = {}) => findings.push({ code, tone, metrics: {}, ...extra });
  const { overall } = facts;

  if (overall.count < THRESHOLDS.minGradesOverall) return findings;

  // ── Umumiy dinamika (o'tgan davrga nisbatan) ──
  if (overall.delta != null && overall.delta >= THRESHOLDS.overallDelta) {
    push(FINDING_CODES.OVERALL_IMPROVING, TONES.POSITIVE, {
      metrics: { average: overall.average, previousAverage: overall.previousAverage, delta: overall.delta },
    });
  } else if (overall.delta != null && overall.delta <= -THRESHOLDS.overallDelta) {
    push(FINDING_CODES.OVERALL_DECLINING, TONES.WARNING, {
      metrics: { average: overall.average, previousAverage: overall.previousAverage, delta: overall.delta },
    });
  }

  // ── Fanlar ──
  for (const subject of facts.subjects) {
    if (subject.status === "insufficient") continue;
    const base = { subjectId: subject.id, subject: subject.name };

    if (subject.status === "strong") {
      push(FINDING_CODES.STRONG_SUBJECT, TONES.POSITIVE, {
        ...base,
        metrics: { average: subject.average, count: subject.count },
      });
    }

    if (subject.status === "weak" || subject.status === "critical") {
      push(FINDING_CODES.WEAK_SUBJECT, subject.status === "critical" ? TONES.CRITICAL : TONES.WARNING, {
        ...base,
        metrics: { average: subject.average, count: subject.count, classAverage: subject.classAverage },
      });
    }

    if (subject.change != null && subject.change >= THRESHOLDS.trendDelta) {
      push(FINDING_CODES.IMPROVING_SUBJECT, TONES.POSITIVE, {
        ...base,
        metrics: { firstHalf: subject.firstHalf, secondHalf: subject.secondHalf, change: subject.change },
      });
    } else if (subject.change != null && subject.change <= -THRESHOLDS.trendDelta) {
      push(FINDING_CODES.DECLINING_SUBJECT, TONES.WARNING, {
        ...base,
        metrics: { firstHalf: subject.firstHalf, secondHalf: subject.secondHalf, change: subject.change },
      });
    }

    if (subject.classAverage != null) {
      const classWide = subject.classAverage < THRESHOLDS.classWideAverage;

      if (subject.vsClass >= THRESHOLDS.classGap) {
        push(FINDING_CODES.ABOVE_CLASS, TONES.POSITIVE, {
          ...base,
          metrics: { average: subject.average, classAverage: subject.classAverage, vsClass: subject.vsClass },
        });
      } else if (subject.vsClass <= -THRESHOLDS.classGap && !classWide) {
        // ⚠️ Sinf o'zi yaxshi, o'quvchi ortda — SHAXSIY bo'shliq.
        push(FINDING_CODES.BELOW_CLASS, TONES.WARNING, {
          ...base,
          metrics: { average: subject.average, classAverage: subject.classAverage, vsClass: subject.vsClass },
        });
      }

      // ⚠️ Fan o'quvchiga ham, SINFGA ham qiyin — muammo faqat o'quvchida
      // emas. Bu sabab tavsiyani o'zgartiradi: ota-onaga "farzandingiz
      // dangasa" emas, "maktabdan qo'shimcha dars so'rang" deyiladi.
      if (classWide && subject.average < THRESHOLDS.weakAverage) {
        push(FINDING_CODES.CLASS_WIDE_DIFFICULTY, TONES.INFO, {
          ...base,
          metrics: { average: subject.average, classAverage: subject.classAverage },
        });
      }
    }

    if (subject.stdev != null && subject.stdev >= THRESHOLDS.unstableStdev) {
      push(FINDING_CODES.UNSTABLE_SUBJECT, TONES.WARNING, {
        ...base,
        metrics: { stdev: subject.stdev, min: subject.min, max: subject.max, count: subject.count },
      });
    }

    if (subject.lowStreak) {
      push(FINDING_CODES.LOW_STREAK, TONES.CRITICAL, {
        ...base,
        metrics: { lastGrades: subject.lastGrades.slice(-THRESHOLDS.lowStreakLength) },
      });
    }
  }

  // ── Mavzular ──
  for (const topic of facts.topics.weak) {
    push(FINDING_CODES.WEAK_TOPIC, TONES.WARNING, {
      subjectId: topic.subjectId,
      subject: topic.subject,
      topic: topic.name,
      metrics: { average: topic.average, count: topic.count, classAverage: topic.classAverage },
    });
  }
  for (const topic of facts.topics.strong.slice(0, 3)) {
    push(FINDING_CODES.STRONG_TOPIC, TONES.POSITIVE, {
      subjectId: topic.subjectId,
      subject: topic.subject,
      topic: topic.name,
      metrics: { average: topic.average, count: topic.count },
    });
  }

  // ── Davomat ──
  const attendance = facts.attendance;
  if (attendance) {
    const impact =
      attendance.afterAbsenceAverage != null &&
      attendance.regularAverage != null &&
      attendance.regularAverage - attendance.afterAbsenceAverage >= THRESHOLDS.absenceImpactGap;

    if (attendance.absent >= THRESHOLDS.minAbsentDays && impact) {
      push(FINDING_CODES.ABSENCE_IMPACT, TONES.WARNING, {
        metrics: {
          absent: attendance.absent,
          rate: attendance.rate,
          afterAbsenceAverage: attendance.afterAbsenceAverage,
          regularAverage: attendance.regularAverage,
        },
      });
    } else if (
      attendance.rate < THRESHOLDS.lowAttendanceRate &&
      attendance.absent >= THRESHOLDS.minAbsentDays
    ) {
      push(FINDING_CODES.LOW_ATTENDANCE, TONES.WARNING, {
        metrics: { absent: attendance.absent, rate: attendance.rate, marked: attendance.marked },
      });
    }
  }

  // ── Diagnostika ──
  const diagnostics = facts.diagnostics;
  if (diagnostics) {
    for (const topic of diagnostics.weakTopics.slice(0, 3)) {
      push(FINDING_CODES.DIAG_WEAK_TOPIC, TONES.WARNING, {
        subject: topic.subject || undefined,
        topic: topic.topic,
        metrics: { score: topic.score, questions: topic.questions },
      });
    }

    const patterns = diagnostics.errorPatterns;
    if (patterns && patterns.wrongCount >= THRESHOLDS.diagMinWrong) {
      const share = THRESHOLDS.diagPatternShare;
      if (patterns.rushing >= share) {
        push(FINDING_CODES.DIAG_RUSHING, TONES.WARNING, { metrics: { share: patterns.rushing, wrongCount: patterns.wrongCount } });
      }
      if (patterns.misread >= share) {
        push(FINDING_CODES.DIAG_MISREAD, TONES.WARNING, { metrics: { share: patterns.misread, wrongCount: patterns.wrongCount } });
      }
      if (patterns.knowledge >= share) {
        push(FINDING_CODES.DIAG_KNOWLEDGE, TONES.WARNING, { metrics: { share: patterns.knowledge, wrongCount: patterns.wrongCount } });
      }
    }
  }

  return findings;
}

/* ───────────────────────── XAVF BALLI ───────────────────────── */

/**
 * XAVF BALLI (0–100) — "kimga birinchi navbatda qarash kerak" tartibi.
 *
 * Formula ochiq va sodda (admin "nega 70?" deb so'rasa javob bor):
 *   o'rtacha 4.0 dan past bo'lsa    (4.0 − o'rtacha) × 30, ko'pi bilan 45
 *   har bir past fan                 +12, ko'pi bilan 24
 *   ketma-ket past baholar           +12
 *   umumiy pasayish                  +10
 *   davomat muammosi                 +9
 * Ma'lumot yetmasa — 0 (xavf ro'yxatiga tushmaydi, `insufficient` bo'ladi).
 */
function computeRiskScore(facts, findings) {
  const { overall } = facts;
  if (overall.count < THRESHOLDS.minGradesOverall || overall.average == null) return 0;

  const has = (code) => findings.some((finding) => finding.code === code);
  const weakSubjects = findings.filter((finding) => finding.code === FINDING_CODES.WEAK_SUBJECT).length;

  let score = Math.min(45, Math.max(0, (4 - overall.average) * 30));
  score += Math.min(24, weakSubjects * 12);
  if (has(FINDING_CODES.LOW_STREAK)) score += 12;
  if (has(FINDING_CODES.OVERALL_DECLINING)) score += 10;
  if (has(FINDING_CODES.ABSENCE_IMPACT) || has(FINDING_CODES.LOW_ATTENDANCE)) score += 9;

  return Math.min(100, Math.round(score));
}

/* ───────────────────────── 3. MATNLAR ───────────────────────── */

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

/**
 * Fan bo'yicha SABABLAR — "nega past" degan savolga javob. Har bir fan
 * uchun topilmalar bitta "e'tibor" kartasiga yig'iladi.
 */
const SUBJECT_CAUSE_TEXT = {
  [FINDING_CODES.BELOW_CLASS]: (m) =>
    `Sinf o'rtachasi ${fmt(m.classAverage)}, bu fanda natija ${fmt(m.average)} — farq sinfda emas, shaxsiy o'zlashtirishda`,
  [FINDING_CODES.CLASS_WIDE_DIFFICULTY]: (m) =>
    `Sinf o'rtachasi ham past (${fmt(m.classAverage)}) — fan butun sinfga qiyin kechmoqda`,
  [FINDING_CODES.DECLINING_SUBJECT]: (m) =>
    `Davr boshida o'rtacha ${fmt(m.firstHalf)}, oxirida ${fmt(m.secondHalf)} — pasayish yaqinda boshlangan`,
  [FINDING_CODES.UNSTABLE_SUBJECT]: (m) =>
    `Baholar ${m.min} dan ${m.max} gacha tebranadi — tayyorgarlik muntazam emas`,
  [FINDING_CODES.LOW_STREAK]: (m) => `Oxirgi baholar ketma-ket past: ${m.lastGrades.join(", ")}`,
  [FINDING_CODES.WEAK_TOPIC]: (m, f) => `«${f.topic}» mavzusi: o'rtacha ${fmt(m.average)}`,
};

/**
 * Uch auditoriya uchun tavsiyalar katalogi. Har bir yozuv topilmadan
 * `{ student, parent, staff }` qaytaradi (keraksizi `null`).
 *
 * ⚠️ Tavsiya SABABGA bog'langan: "ko'proq o'qing" kabi umumiy gap yo'q.
 * Har biri nima qilinishini, qancha va kim bilan aytadi.
 */
const RECOMMENDATIONS = {
  [FINDING_CODES.BELOW_CLASS]: (f) => ({
    priority: "medium",
    student: {
      title: `${f.subject}: sinfdoshlaringizga yetib oling`,
      detail:
        `Sinf o'rtachasi ${fmt(f.metrics.classAverage)}, sizniki ${fmt(f.metrics.average)}. Sinf mavzularni o'zlashtirgan, ` +
        "demak ayrim mavzular o'tkazib yuborilgan. Har kuni 20–30 daqiqa shu fandan mashq qiling va tushunmagan " +
        "joyingizni darsdan keyin o'qituvchidan so'rang.",
    },
    parent: {
      title: `${f.subject}: farzandingiz sinfdan ortda qolmoqda`,
      detail:
        `Sinf o'rtachasi ${fmt(f.metrics.classAverage)}, farzandingizniki ${fmt(f.metrics.average)}. Muammo sinfda emas, ` +
        `shaxsiy o'zlashtirishda. Uy vazifasini har kuni tekshiring va ${f.subject} o'qituvchisi bilan uchrashib, ` +
        "qaysi mavzularda qiynalayotganini aniqlang.",
    },
    staff: {
      title: `${f.subject}: o'quvchi bilan individual ishlash (o'quvchi ${fmt(f.metrics.average)}, sinf ${fmt(f.metrics.classAverage)})`,
      owner: `${f.subject} o'qituvchisi`,
    },
  }),

  [FINDING_CODES.CLASS_WIDE_DIFFICULTY]: (f) => ({
    priority: "medium",
    student: {
      title: `${f.subject}: fan butun sinf uchun qiyin kechmoqda`,
      detail:
        `Sinf o'rtachasi ham past (${fmt(f.metrics.classAverage)}). Qo'shimcha dars yoki konsultatsiyalarda qatnashing, ` +
        "darsda tushunmagan mavzuni o'sha kuni darslikdan qayta ishlang.",
    },
    parent: {
      title: `${f.subject}: fan butun sinfga qiyin`,
      detail:
        `Sinf o'rtachasi ham past (${fmt(f.metrics.classAverage)}) — bu faqat farzandingizga taalluqli emas. ` +
        "Maktabdan shu fan bo'yicha qo'shimcha dars bor-yo'qligini so'rang va uyda mavzularni birga takrorlang.",
    },
    staff: {
      title: `${f.subject}: sinf o'rtachasi ${fmt(f.metrics.classAverage)} — o'qitish uslubi va mavzu murakkabligini ko'rib chiqish, qo'shimcha dars`,
      owner: "O'quv bo'limi",
    },
  }),

  [FINDING_CODES.DECLINING_SUBJECT]: (f) => ({
    priority: "medium",
    student: {
      title: `${f.subject}: pasayishni to'xtating`,
      detail:
        `Davr boshida o'rtacha ${fmt(f.metrics.firstHalf)}, oxirida ${fmt(f.metrics.secondHalf)}. Pasayish yaqinda ` +
        "boshlangan — so'nggi mavzularni takrorlang va uy vazifalarini kechiktirmang.",
    },
    parent: {
      title: `${f.subject}: baholar pasaymoqda`,
      detail:
        `Davr boshida ${fmt(f.metrics.firstHalf)}, oxirida ${fmt(f.metrics.secondHalf)}. Farzandingiz bilan nima ` +
        "o'zgarganini gaplashing (yangi mavzu, charchoq, qiziqish) va so'nggi mavzularni birga takrorlang.",
    },
    staff: {
      title: `${f.subject}: pasayish sababini aniqlash (${fmt(f.metrics.firstHalf)} → ${fmt(f.metrics.secondHalf)})`,
      owner: "Sinf rahbari",
    },
  }),

  [FINDING_CODES.UNSTABLE_SUBJECT]: (f) => ({
    priority: "medium",
    student: {
      title: `${f.subject}: natijani barqarorlashtiring`,
      detail:
        `Baholaringiz ${f.metrics.min} dan ${f.metrics.max} gacha tebranadi. Bilim bor, lekin tayyorgarlik muntazam ` +
        "emas — har darsga oldindan tayyorlanishni odat qiling.",
    },
    parent: {
      title: `${f.subject}: natija beqaror`,
      detail:
        `Baholar ${f.metrics.min} dan ${f.metrics.max} gacha tebranadi — tayyorgarlik muntazam emas. Uy vazifasi uchun ` +
        "har kuni aniq vaqt belgilang va bajarilganini tekshiring.",
    },
    staff: null,
  }),

  [FINDING_CODES.LOW_STREAK]: (f) => ({
    priority: "high",
    student: {
      title: `${f.subject}: oxirgi baholar past — kechiktirmang`,
      detail:
        `Oxirgi baholar: ${f.metrics.lastGrades.join(", ")}. Shu hafta o'qituvchi bilan gaplashing va o'tkazib ` +
        "yuborilgan mavzularni to'ldiring.",
    },
    parent: {
      title: `${f.subject}: ketma-ket past baholar`,
      detail:
        `Oxirgi baholar: ${f.metrics.lastGrades.join(", ")}. Shu hafta ${f.subject} o'qituvchisi bilan bog'laning.`,
    },
    staff: {
      title: `${f.subject}: ketma-ket past baholar (${f.metrics.lastGrades.join(", ")}) — shu hafta o'quvchi bilan suhbat`,
      owner: `${f.subject} o'qituvchisi`,
    },
  }),

  [FINDING_CODES.WEAK_TOPIC]: (f) => ({
    priority: "medium",
    student: {
      title: `${f.subject} — «${f.topic}» mavzusini qayta ishlang`,
      detail: `Bu mavzu bo'yicha o'rtacha ${fmt(f.metrics.average)}. Mavzuni darslikdan qayta o'qing va shu mavzuga oid mashqlarni bajaring.`,
    },
    parent: {
      title: `${f.subject} — «${f.topic}» mavzusi`,
      detail: `Bu mavzu bo'yicha o'rtacha ${fmt(f.metrics.average)}. Mavzuni farzandingiz bilan birga takrorlang.`,
    },
    staff: {
      title: `${f.subject} — «${f.topic}» mavzusini takrorlash (o'rtacha ${fmt(f.metrics.average)})`,
      owner: `${f.subject} o'qituvchisi`,
    },
  }),

  [FINDING_CODES.ABSENCE_IMPACT]: (f) => ({
    priority: "high",
    student: {
      title: "Darslarni qoldirmang",
      detail:
        `Bu davrda ${f.metrics.absent} kun darsga kelmadingiz. Qoldirilgan kunlardan keyingi baholar o'rtachasi ` +
        `${fmt(f.metrics.afterAbsenceAverage)}, boshqa kunlarda ${fmt(f.metrics.regularAverage)}. Kelmagan kuningiz ` +
        "mavzusini o'sha hafta o'qituvchidan so'rab, daftarni to'ldiring.",
    },
    parent: {
      title: "Davomatga e'tibor bering",
      detail:
        `Farzandingiz ${f.metrics.absent} kun darsga kelmagan (davomat ${f.metrics.rate}%). Qoldirilgan kunlardan keyin ` +
        `baholar o'rtachasi ${fmt(f.metrics.afterAbsenceAverage)} ga tushgan (boshqa kunlarda ${fmt(f.metrics.regularAverage)}). ` +
        "Sababsiz qoldirishlarni nazorat qiling va o'tkazib yuborilgan mavzularni birga ko'rib chiqing.",
    },
    staff: {
      title: `Davomat: ${f.metrics.absent} kun kelmagan, qoldirishdan keyin baholar pasaygan — ota-ona bilan bog'lanish`,
      owner: "Sinf rahbari",
    },
  }),

  [FINDING_CODES.LOW_ATTENDANCE]: (f) => ({
    priority: "medium",
    student: {
      title: "Davomatni yaxshilang",
      detail:
        `Bu davrda ${f.metrics.absent} kun darsga kelmadingiz (davomat ${f.metrics.rate}%). Har bir qoldirilgan dars — ` +
        "o'tkazib yuborilgan mavzu: kelmagan kuningiz mavzusini o'qituvchidan so'rab oling.",
    },
    parent: {
      title: "Davomat past",
      detail:
        `Farzandingiz ${f.metrics.absent} kun darsga kelmagan (davomat ${f.metrics.rate}%). Sabablarini aniqlang va ` +
        "sinf rahbari bilan bog'laning.",
    },
    staff: {
      title: `Davomat ${f.metrics.rate}% (${f.metrics.absent} kun kelmagan) — ota-ona bilan bog'lanish`,
      owner: "Sinf rahbari",
    },
  }),

  [FINDING_CODES.DIAG_WEAK_TOPIC]: (f) => ({
    priority: "medium",
    student: {
      title: `${f.subject ? `${f.subject} — ` : ""}«${f.topic}»: diagnostika ${f.metrics.score}%`,
      detail: "Diagnostika testida bu mavzu bo'yicha javoblarning ko'pi noto'g'ri. Mavzuni qayta o'qib, shu mavzudan mashq testini qayta ishlang.",
    },
    parent: {
      title: `${f.subject ? `${f.subject} — ` : ""}«${f.topic}» mavzusi zaif`,
      detail: `Diagnostika testida bu mavzu bo'yicha natija ${f.metrics.score}%. Mavzuni farzandingiz bilan birga takrorlang.`,
    },
    staff: {
      title: `${f.subject ? `${f.subject} — ` : ""}«${f.topic}»: diagnostika ${f.metrics.score}% — mavzuni takrorlash`,
      owner: f.subject ? `${f.subject} o'qituvchisi` : "Fan o'qituvchisi",
    },
  }),

  [FINDING_CODES.DIAG_RUSHING]: (f) => ({
    priority: "medium",
    student: {
      title: "Shoshilmang",
      detail:
        `Diagnostika testlaridagi xatolarning ${f.metrics.share}% i shoshilish sabab — savolga odatdagidan ancha tez ` +
        "javob berilgan. Javob berishdan oldin shartni qayta o'qib, natijani tekshiring.",
    },
    parent: {
      title: "Farzandingiz test topshirishda shoshiladi",
      detail:
        `Xatolarning ${f.metrics.share}% i shoshilish sabab. Uyda mashq qilganda vaqtni emas, har bir javobni ` +
        "tekshirishni odat qildiring.",
    },
    staff: null,
  }),

  [FINDING_CODES.DIAG_MISREAD]: (f) => ({
    priority: "medium",
    student: {
      title: "Savol shartini diqqat bilan o'qing",
      detail:
        `Diagnostika xatolarining ${f.metrics.share}% i shartni noto'g'ri tushunish sabab. Savolni ikki marta o'qing, ` +
        "nima so'ralayotganini tagiga chizib oling.",
    },
    parent: {
      title: "Savolni diqqatsiz o'qish",
      detail:
        `Xatolarning ${f.metrics.share}% i savol shartini noto'g'ri tushunishdan. Matnni diqqat bilan o'qish ` +
        "(masalan, masala shartini ovoz chiqarib o'qish) mashqini qiling.",
    },
    staff: null,
  }),

  [FINDING_CODES.DIAG_KNOWLEDGE]: (f) => ({
    priority: "medium",
    student: {
      title: "Bilim bo'shliqlarini to'ldiring",
      detail:
        `Diagnostika xatolarining ${f.metrics.share}% i mavzuni bilmaslik sabab — bu shoshilish emas, o'rganilmagan ` +
        "mavzu. Zaif mavzularni ro'yxat qilib, har haftada bittasini yoping.",
    },
    parent: {
      title: "Bilim bo'shliqlari bor",
      detail:
        `Xatolarning ${f.metrics.share}% i mavzuni bilmaslik sabab. Zaif mavzular bo'yicha qo'shimcha mashg'ulotni ` +
        "o'ylab ko'ring.",
    },
    staff: null,
  }),

  [FINDING_CODES.OVERALL_DECLINING]: (f) => ({
    priority: "medium",
    student: {
      title: "Umumiy natija pasaydi",
      detail:
        `O'tgan davrda o'rtacha ${fmt(f.metrics.previousAverage)} edi, hozir ${fmt(f.metrics.average)}. Kun tartibingizni ` +
        "ko'rib chiqing: uy vazifasi va dam olish uchun aniq vaqt ajrating.",
    },
    parent: {
      title: "Umumiy natija pasaydi",
      detail:
        `O'tgan davrda o'rtacha ${fmt(f.metrics.previousAverage)}, hozir ${fmt(f.metrics.average)}. Farzandingiz bilan ` +
        "gaplashing: pasayish ko'pincha kun tartibi, charchoq yoki qiziqish yo'qolishidan boshlanadi.",
    },
    staff: {
      title: `Umumiy pasayish (${fmt(f.metrics.previousAverage)} → ${fmt(f.metrics.average)}) — o'quvchi va ota-ona bilan suhbat`,
      owner: "Sinf rahbari",
    },
  }),

  [FINDING_CODES.WEAK_SUBJECT]: (f) => ({
    priority: f.tone === TONES.CRITICAL ? "high" : "medium",
    student: {
      title: `${f.subject}: natijani ko'taring`,
      detail:
        `Bu fanda o'rtacha ${fmt(f.metrics.average)}. Har kuni shu fandan qisqa takrorlash qiling va har hafta ` +
        "o'qituvchidan tushunmagan savollaringizni so'rang.",
    },
    parent: {
      title: `${f.subject}: natija past`,
      detail:
        `Bu fanda o'rtacha ${fmt(f.metrics.average)}. ${f.subject} o'qituvchisi bilan bog'lanib, qaysi mavzular ` +
        "qiyin ekanini aniqlang va uyda shu mavzularni birga takrorlang.",
    },
    staff: {
      title: `${f.subject}: o'rtacha ${fmt(f.metrics.average)} — qo'shimcha dars va uy vazifasi nazorati`,
      owner: `${f.subject} o'qituvchisi`,
    },
  }),
};

/** Kuchli tomonlar matni (o'quvchi va ota-ona). */
const STRENGTH_TEXT = {
  [FINDING_CODES.STRONG_SUBJECT]: (f) => ({
    student: {
      title: `${f.subject}: a'lo o'zlashtirish`,
      detail: `O'rtacha ${fmt(f.metrics.average)}. Shu darajani saqlang.`,
    },
    parent: {
      title: `${f.subject}: a'lo o'zlashtirish`,
      detail: `O'rtacha ${fmt(f.metrics.average)}. Farzandingizni shu yutug'i uchun rag'batlantiring.`,
    },
  }),
  [FINDING_CODES.IMPROVING_SUBJECT]: (f) => ({
    student: {
      title: `${f.subject}: o'sish bor`,
      detail: `Davr boshida ${fmt(f.metrics.firstHalf)}, oxirida ${fmt(f.metrics.secondHalf)}. Mehnatingiz natija bermoqda.`,
    },
    parent: {
      title: `${f.subject}: o'sish bor`,
      detail: `Davr boshida ${fmt(f.metrics.firstHalf)}, oxirida ${fmt(f.metrics.secondHalf)}. Farzandingizning harakatini qo'llab-quvvatlang.`,
    },
  }),
  [FINDING_CODES.ABOVE_CLASS]: (f) => ({
    student: {
      title: `${f.subject}: sinfdan yuqori`,
      detail: `Sizniki ${fmt(f.metrics.average)}, sinf o'rtachasi ${fmt(f.metrics.classAverage)}.`,
    },
    parent: {
      title: `${f.subject}: sinfdan yuqori`,
      detail: `Farzandingizniki ${fmt(f.metrics.average)}, sinf o'rtachasi ${fmt(f.metrics.classAverage)}.`,
    },
  }),
  [FINDING_CODES.OVERALL_IMPROVING]: (f) => ({
    student: {
      title: "Umumiy natija oshdi",
      detail: `O'tgan davrda ${fmt(f.metrics.previousAverage)}, hozir ${fmt(f.metrics.average)}.`,
    },
    parent: {
      title: "Umumiy natija oshdi",
      detail: `O'tgan davrda ${fmt(f.metrics.previousAverage)}, hozir ${fmt(f.metrics.average)}. Bu — izchil mehnat natijasi.`,
    },
  }),
  [FINDING_CODES.STRONG_TOPIC]: (f) => ({
    student: {
      title: `${f.subject} — «${f.topic}»`,
      detail: `Bu mavzu yaxshi o'zlashtirilgan (o'rtacha ${fmt(f.metrics.average)}).`,
    },
    parent: {
      title: `${f.subject} — «${f.topic}»`,
      detail: `Bu mavzu yaxshi o'zlashtirilgan (o'rtacha ${fmt(f.metrics.average)}).`,
    },
  }),
};

/** Sarlavha — daraja bo'yicha. */
const HEADLINE = {
  excellent: (avg) => `A'lo natija: umumiy o'rtacha ${fmt(avg)}`,
  good: (avg) => `Yaxshi natija: umumiy o'rtacha ${fmt(avg)}`,
  average: (avg) => `O'rtacha natija: umumiy o'rtacha ${fmt(avg)} — o'sish imkoniyati bor`,
  weak: (avg) => `E'tibor kerak: umumiy o'rtacha ${fmt(avg)}`,
  critical: (avg) => `Jiddiy e'tibor kerak: umumiy o'rtacha ${fmt(avg)}`,
};

/** Fan uchun ANIQ sabablar — ular bor bo'lsa "past fan" umumiy tavsiyasi chiqmaydi. */
const SPECIFIC_SUBJECT_CAUSES = new Set([
  FINDING_CODES.BELOW_CLASS,
  FINDING_CODES.CLASS_WIDE_DIFFICULTY,
  FINDING_CODES.DECLINING_SUBJECT,
  FINDING_CODES.UNSTABLE_SUBJECT,
  FINDING_CODES.LOW_STREAK,
]);

const MAX_RECOMMENDATIONS = 6;
const MAX_STRENGTHS = 4;
const MAX_STAFF_ACTIONS = 5;

/** Topilmalar tartibi: avval eng jiddiysi (ohang), keyin ustuvorlik. */
const TONE_RANK = { critical: 0, warning: 1, info: 2, positive: 3 };

/**
 * Umumiy xulosa jumlalari. `voice` — "student" ("siz") yoki "parent".
 */
const summaryFor = (facts, findings, voice) => {
  const { overall, period } = facts;
  const parts = [];
  const who = voice === "parent" ? "Farzandingiz" : "Siz";
  const verb = voice === "parent" ? "oldi" : "oldingiz";

  parts.push(
    `${who} ${period.title.toLowerCase()} davrda (${period.rangeLabel}) ${overall.count} ta baho ${verb}, umumiy o'rtacha ${fmt(overall.average)}.`,
  );

  if (overall.delta != null && Math.abs(overall.delta) >= 0.05) {
    parts.push(
      `O'tgan davrga nisbatan o'rtacha ${fmt(Math.abs(overall.delta))} ballga ${overall.delta > 0 ? "oshgan" : "pasaygan"}.`,
    );
  }

  const strong = facts.subjects.filter((subject) => subject.status === "strong").slice(0, 3);
  if (strong.length) {
    parts.push(`Eng kuchli fanlar: ${strong.map((subject) => `${subject.name} (${fmt(subject.average)})`).join(", ")}.`);
  }

  const weak = facts.subjects.filter((subject) => subject.status === "weak" || subject.status === "critical");
  if (weak.length) {
    parts.push(`E'tibor talab qiladigan fanlar: ${weak.map((subject) => `${subject.name} (${fmt(subject.average)})`).join(", ")}.`);
  } else if (findings.some((finding) => NEGATIVE_TONES.has(finding.tone))) {
    parts.push("Past fan yo'q, lekin quyidagi kuzatuvlarga e'tibor bering.");
  } else {
    parts.push(voice === "parent" ? "Jiddiy muammo kuzatilmadi." : "Jiddiy muammo kuzatilmadi — shu sur'atda davom eting.");
  }

  return parts.join(" ");
};

/**
 * Fan bo'yicha "E'TIBOR" kartalari — past/pasayayotgan fan va uning SABABLARI.
 */
const focusFor = (facts, findings) => {
  const bySubject = new Map();

  for (const finding of findings) {
    const relevant = NEGATIVE_TONES.has(finding.tone) || finding.tone === TONES.INFO;
    if (!finding.subjectId || !relevant) continue;
    if (!bySubject.has(finding.subjectId)) bySubject.set(finding.subjectId, []);
    bySubject.get(finding.subjectId).push(finding);
  }

  const items = [];
  for (const [subjectId, list] of bySubject) {
    const subject = facts.subjects.find((row) => row.id === subjectId);
    const causes = list
      .map((finding) => SUBJECT_CAUSE_TEXT[finding.code]?.(finding.metrics, finding))
      .filter(Boolean);

    // Fan o'zi yaxshi-yu, faqat bitta mavzu zaif bo'lsa ham karta chiqadi
    const worst = list.reduce((acc, finding) => (TONE_RANK[finding.tone] < TONE_RANK[acc.tone] ? finding : acc));

    items.push({
      subjectId,
      subject: subject?.name ?? list[0].subject,
      average: subject?.average ?? null,
      classAverage: subject?.classAverage ?? null,
      tone: worst.tone === TONES.INFO ? TONES.WARNING : worst.tone,
      causes,
    });
  }

  return items.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || (a.average ?? 5) - (b.average ?? 5));
};

/**
 * Uch auditoriya uchun matn — QOIDALAR versiyasi. AI ishlamasa aynan shu
 * ko'rsatiladi; AI ishlasa `headline`/`summary`/`recommendations` o'rnini
 * model matni oladi, qolgan qismlar (kuchli tomonlar, e'tibor kartalari)
 * shu yerdan qoladi.
 *
 * @returns {{studentView: object, parentView: object, staffView: object}}
 */
function buildViews(facts, findings, { level, riskScore, className } = {}) {
  const levelKey = level?.key ?? levelOf(facts.overall.average, facts.overall.count).key;

  if (levelKey === INSUFFICIENT_LEVEL.key) {
    const message =
      facts.overall.count === 0
        ? "Bu davrda birorta ham baho qo'yilmagan."
        : `Bu davrda atigi ${facts.overall.count} ta baho qo'yilgan — xulosa chiqarish uchun yetarli emas.`;
    const empty = { headline: "Tahlil uchun baholar yetarli emas", summary: message, strengths: [], focus: [], recommendations: [] };
    return {
      studentView: empty,
      parentView: { ...empty },
      staffView: { summary: message, actions: [] },
    };
  }

  const sorted = [...findings].sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);

  // ── Tavsiyalar: sababga bog'langan, takrorlanmaydi ──
  const recs = [];
  const seen = new Set();
  for (const finding of sorted) {
    const build = RECOMMENDATIONS[finding.code];
    if (!build) continue;

    const key = `${finding.code}|${finding.subjectId ?? ""}|${finding.topic ?? ""}`;
    if (seen.has(key)) continue;

    // "Past fan" — UMUMIY tavsiya. Shu fan uchun aniqroq sabab (sinfdan
    // ortda, butun sinfga qiyin, pasayish, beqarorlik, ketma-ket past)
    // topilgan bo'lsa, umumiysi qo'shilmaydi: aks holda bitta fanga ikki
    // xil gap chiqib, aniq sabab umumiy gap orasida yo'qolardi.
    if (
      finding.code === FINDING_CODES.WEAK_SUBJECT &&
      sorted.some(
        (other) =>
          other !== finding &&
          other.subjectId === finding.subjectId &&
          SPECIFIC_SUBJECT_CAUSES.has(other.code),
      )
    ) {
      continue;
    }

    seen.add(key);
    recs.push({ ...build(finding), subject: finding.subject ?? null, code: finding.code });
  }

  recs.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  const top = recs.slice(0, MAX_RECOMMENDATIONS);

  // Hamma narsa yaxshi — baribir bitta ANIQ yo'nalish beriladi
  if (top.length === 0) {
    const best = facts.subjects.find((subject) => subject.status === "strong");
    top.push({
      priority: "low",
      subject: best?.name ?? null,
      code: "keep_going",
      student: {
        title: "Natijani saqlang",
        detail: best
          ? `${best.name} fanidagi natijangiz (${fmt(best.average)}) — olimpiada yoki chuqurlashtirilgan mashg'ulotlar uchun yaxshi asos.`
          : "Uy vazifalarini o'z vaqtida bajarishda davom eting va har hafta o'tilgan mavzularni qisqa takrorlang.",
      },
      parent: {
        title: "Natija barqaror",
        detail: best
          ? `${best.name} fanidagi natija (${fmt(best.average)}) — farzandingizni olimpiada yoki to'garakka yo'naltirish uchun yaxshi asos.`
          : "Farzandingizning kun tartibini saqlang va yutuqlarini rag'batlantiring.",
      },
      staff: null,
    });
  }

  const strengths = sorted
    .filter((finding) => finding.tone === TONES.POSITIVE && STRENGTH_TEXT[finding.code])
    .slice(0, MAX_STRENGTHS)
    .map((finding) => ({ code: finding.code, subject: finding.subject ?? null, ...STRENGTH_TEXT[finding.code](finding) }));

  const focus = focusFor(facts, findings);
  const headline = HEADLINE[levelKey](facts.overall.average);

  const toView = (voice) => ({
    headline,
    summary: summaryFor(facts, findings, voice),
    strengths: strengths.map((item) => ({ code: item.code, subject: item.subject, ...item[voice] })),
    focus,
    recommendations: top.map((item) => ({
      code: item.code,
      subject: item.subject,
      priority: item.priority,
      ...item[voice],
    })),
  });

  const staffActions = recs
    .filter((item) => item.staff)
    .slice(0, MAX_STAFF_ACTIONS)
    .map((item) => ({ code: item.code, priority: item.priority, ...item.staff }));

  const negatives = findings.filter((finding) => NEGATIVE_TONES.has(finding.tone)).length;
  const staffSummary =
    `${className ? `${className} sinfi. ` : ""}Umumiy o'rtacha ${fmt(facts.overall.average)} (${levelLabel(levelKey)}), ` +
    `xavf balli ${riskScore ?? 0}. ` +
    (negatives ? `${negatives} ta muammo belgisi aniqlandi.` : "Muammo belgisi aniqlanmadi.");

  return {
    studentView: toView("student"),
    parentView: toView("parent"),
    staffView: { summary: staffSummary, actions: staffActions },
  };
}

/**
 * Bitta o'quvchi — to'liq tahlil (faktlar → topilmalar → daraja → matn).
 * @returns {{facts, findings, level, riskScore, views}}
 */
function analyzeStudent(input) {
  const facts = buildStudentFacts(input);
  const findings = detectFindings(facts);
  const level = levelOf(facts.overall.average, facts.overall.count);
  const riskScore = computeRiskScore(facts, findings);
  const views = buildViews(facts, findings, { level, riskScore, className: input.student?.className });
  return { facts, findings, level, riskScore, views };
}

/* ───────────────────────── 4. YIG'MA (QAMROV) ───────────────────────── */

/**
 * Xom baholarni yig'ish uchun akkumulyator — servis baholarni bo'laklab
 * o'qiydi va shu bilan qamrov kesimlarini bir o'tishda to'playdi.
 */
function createScopeAccumulator() {
  return {
    total: { sum: 0, count: 0, dist: emptyDistribution() },
    subjects: new Map(), // subjectId → { sum, count, dist, students:Set }
    classSubject: new Map(), // `${classId}|${subjectId}` → { sum, count }
    classes: new Map(), // classId → { sum, count }
    topics: new Map(), // topicId → { sum, count, students:Set, classes:Set }
    withTopic: 0,
  };
}

/**
 * Bitta bahoni akkumulyatorga qo'shadi.
 * @param {ReturnType<typeof createScopeAccumulator>} acc
 * @param {{studentId: string, subjectId: string, classId: string, grade: number, topicId?: string|null}} row
 */
function accumulateGrade(acc, row) {
  const add = (target) => {
    target.sum += row.grade;
    target.count += 1;
  };

  add(acc.total);
  if (acc.total.dist[row.grade] != null) acc.total.dist[row.grade] += 1;

  let subject = acc.subjects.get(row.subjectId);
  if (!subject) {
    subject = { sum: 0, count: 0, dist: emptyDistribution(), students: new Set() };
    acc.subjects.set(row.subjectId, subject);
  }
  add(subject);
  if (subject.dist[row.grade] != null) subject.dist[row.grade] += 1;
  subject.students.add(row.studentId);

  const cs = `${row.classId}|${row.subjectId}`;
  if (!acc.classSubject.has(cs)) acc.classSubject.set(cs, { sum: 0, count: 0 });
  add(acc.classSubject.get(cs));

  if (!acc.classes.has(row.classId)) acc.classes.set(row.classId, { sum: 0, count: 0 });
  add(acc.classes.get(row.classId));

  if (row.topicId) {
    acc.withTopic += 1;
    let topic = acc.topics.get(row.topicId);
    if (!topic) {
      topic = { sum: 0, count: 0, students: new Set(), classes: new Set() };
      acc.topics.set(row.topicId, topic);
    }
    add(topic);
    topic.students.add(row.studentId);
    topic.classes.add(row.classId);
  }
}

/**
 * YIG'ILGAN qatorni (`groupBy` natijasi: summa + soni) qo'shadi — o'tgan
 * davr uchun. U yerda faqat o'rtachalar kerak (taqsimot va o'quvchilar
 * to'plami emas), shuning uchun har bir bahoni o'qib o'tirilmaydi.
 * @param {ReturnType<typeof createScopeAccumulator>} acc
 * @param {{subjectId: string, classId: string, sum: number, count: number}} row
 */
function accumulateAggregate(acc, row) {
  if (!row.count) return;
  const add = (target) => {
    target.sum += row.sum;
    target.count += row.count;
  };

  add(acc.total);

  let subject = acc.subjects.get(row.subjectId);
  if (!subject) {
    subject = { sum: 0, count: 0, dist: emptyDistribution(), students: new Set() };
    acc.subjects.set(row.subjectId, subject);
  }
  add(subject);

  if (!acc.classes.has(row.classId)) acc.classes.set(row.classId, { sum: 0, count: 0 });
  add(acc.classes.get(row.classId));
}

const avgOf = (row) => (row && row.count ? round(row.sum / row.count) : null);

/**
 * Qamrov yig'masi — admin dashboardi shundan chiziladi.
 *
 * ⚠️ Fan/sinf o'rtachalari XOM BAHOLARDAN (akkumulyator), o'quvchi
 * o'rtachalarining o'rtachasidan EMAS: ikkinchisi 2 ta baho olgan
 * o'quvchini 40 ta baho olgan bilan teng tortib, raqamni buzardi. Ta'lim
 * dashboardidagi "o'rtacha baho" ham aynan shunday hisoblanadi.
 *
 * @param {object} input
 * @param {ReturnType<typeof createScopeAccumulator>} input.current
 * @param {ReturnType<typeof createScopeAccumulator>} input.previous
 * @param {Array<{studentId, name, className, classId, level, riskScore, average, previousAverage, gradeCount, findings, topFinding}>} input.students
 * @param {Map<string,string>} input.subjectNames
 * @param {Map<string,string>} input.classNames
 * @param {Map<string,{name: string, subjectId: string}>} input.topics
 * @param {{marked: number, attended: number, absent: number}} input.attendance
 * @param {{attempts: number, scoreSum: number, wrong: number, rushing: number, knowledge: number, misread: number}} input.diagnostics
 */
function buildOverview(input) {
  const { current, previous, students, subjectNames, classNames, topics, attendance, diagnostics } = input;

  const average = avgOf(current.total);
  const previousAverage = previous.total.count >= THRESHOLDS.minGradesOverall ? avgOf(previous.total) : null;

  const levels = Object.fromEntries(LEVEL_KEYS.map((key) => [key, 0]));
  let improving = 0;
  let declining = 0;
  for (const student of students) {
    levels[student.level] = (levels[student.level] ?? 0) + 1;
    if (student.average != null && student.previousAverage != null) {
      const delta = student.average - student.previousAverage;
      if (delta >= THRESHOLDS.overallDelta) improving += 1;
      else if (delta <= -THRESHOLDS.overallDelta) declining += 1;
    }
  }
  const analyzed = students.filter((student) => student.level !== INSUFFICIENT_LEVEL.key);

  // ── Fanlar ──
  const weakBySubject = new Map();
  for (const student of students) {
    for (const finding of student.findings) {
      if (finding.code === FINDING_CODES.WEAK_SUBJECT && finding.subjectId) {
        weakBySubject.set(finding.subjectId, (weakBySubject.get(finding.subjectId) ?? 0) + 1);
      }
    }
  }

  const subjectRows = [...current.subjects.entries()]
    .map(([subjectId, row]) => {
      const avg = avgOf(row);
      const prev = previous.subjects.get(subjectId);
      const prevAvg = prev && prev.count >= THRESHOLDS.minGradesSubject ? avgOf(prev) : null;
      return {
        subjectId,
        name: subjectNames.get(subjectId) || "Noma'lum fan",
        average: avg,
        previousAverage: prevAvg,
        delta: avg != null && prevAvg != null ? round(avg - prevAvg) : null,
        count: row.count,
        students: row.students.size,
        weakStudents: weakBySubject.get(subjectId) ?? 0,
        qualityRate: Math.round(((row.dist[4] + row.dist[5]) / row.count) * 100),
        distribution: row.dist,
      };
    })
    .sort((a, b) => (b.average ?? 0) - (a.average ?? 0));

  // ── Sinflar va sinf × fan xaritasi ──
  const riskByClass = new Map();
  const studentsByClass = new Map();
  for (const student of students) {
    const key = student.classId || "";
    studentsByClass.set(key, (studentsByClass.get(key) ?? 0) + 1);
    if (student.riskScore >= THRESHOLDS.riskAlert) riskByClass.set(key, (riskByClass.get(key) ?? 0) + 1);
  }

  // Sinfsiz o'quvchi (bo'sh kalit) sinf kesimiga kirmaydi — "—" nomli
  // soxta sinf qatori bo'lib chiqardi; uning baholari umumiy raqamda bor.
  const classRows = [...current.classes.entries()]
    .filter(([classId]) => classId)
    .map(([classId, row]) => {
      const prev = previous.classes.get(classId);
      const avg = avgOf(row);
      const prevAvg = prev && prev.count >= THRESHOLDS.minGradesOverall ? avgOf(prev) : null;
      return {
        classId,
        name: classNames.get(classId) || "—",
        average: avg,
        previousAverage: prevAvg,
        delta: avg != null && prevAvg != null ? round(avg - prevAvg) : null,
        count: row.count,
        students: studentsByClass.get(classId) ?? 0,
        atRisk: riskByClass.get(classId) ?? 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "uz", { numeric: true }));

  const heatmapSubjects = subjectRows.map((row) => ({ subjectId: row.subjectId, name: row.name }));
  const heatmap = classRows.map((cls) => ({
    classId: cls.classId,
    name: cls.name,
    cells: heatmapSubjects.map(({ subjectId }) => {
      const cell = current.classSubject.get(`${cls.classId}|${subjectId}`);
      return { subjectId, average: cell ? avgOf(cell) : null, count: cell?.count ?? 0 };
    }),
  }));

  // ── Mavzular ──
  const topicRows = [...current.topics.entries()]
    .filter(([, row]) => row.count >= THRESHOLDS.minGradesTopic * 2)
    .map(([topicId, row]) => {
      const topic = topics.get(topicId);
      return {
        topicId,
        name: topic?.name ?? "—",
        subject: topic ? subjectNames.get(topic.subjectId) || "—" : "—",
        average: avgOf(row),
        count: row.count,
        students: row.students.size,
        classes: [...row.classes].map((id) => classNames.get(id)).filter(Boolean).sort(),
      };
    })
    .filter((row) => row.name !== "—");

  const topicSection = {
    coverage: current.total.count ? Math.round((current.withTopic / current.total.count) * 100) : 0,
    weak: topicRows
      .filter((row) => row.average < THRESHOLDS.weakTopicAverage)
      .sort((a, b) => a.average - b.average)
      .slice(0, 10),
    strong: topicRows
      .filter((row) => row.average >= THRESHOLDS.strongTopicAverage)
      .sort((a, b) => b.average - a.average)
      .slice(0, 6),
  };

  // ── Sabablar (o'quvchilar soni bo'yicha) ──
  const causeCounts = new Map();
  for (const student of students) {
    const codes = new Set(
      student.findings.filter((finding) => NEGATIVE_TONES.has(finding.tone) || finding.tone === TONES.INFO).map((finding) => finding.code),
    );
    for (const code of codes) causeCounts.set(code, (causeCounts.get(code) ?? 0) + 1);
  }
  const causes = [...causeCounts.entries()]
    .filter(([code]) => CAUSE_LABELS[code])
    .map(([code, count]) => ({ code, label: CAUSE_LABELS[code], students: count }))
    .sort((a, b) => b.students - a.students);

  // ── O'quvchi ro'yxatlari ──
  const brief = (student) => ({
    studentId: student.studentId,
    reportId: student.reportId,
    name: student.name,
    className: student.className,
    average: student.average,
    previousAverage: student.previousAverage,
    delta:
      student.average != null && student.previousAverage != null
        ? round(student.average - student.previousAverage)
        : null,
    level: student.level,
    riskScore: student.riskScore,
    topFinding: student.topFinding ?? null,
  });

  const withDelta = analyzed
    .filter((student) => student.average != null && student.previousAverage != null)
    .map(brief);

  const overview = {
    students: { total: students.length, analyzed: analyzed.length, insufficient: levels.insufficient },
    average,
    previousAverage,
    delta: average != null && previousAverage != null ? round(average - previousAverage) : null,
    gradeCount: current.total.count,
    qualityRate: current.total.count
      ? Math.round(((current.total.dist[4] + current.total.dist[5]) / current.total.count) * 100)
      : null,
    distribution: current.total.dist,
    levels,
    trend: { improving, declining, stable: Math.max(0, withDelta.length - improving - declining) },
    atRisk: analyzed.filter((student) => student.riskScore >= THRESHOLDS.riskAlert).length,
    subjects: subjectRows,
    classes: classRows,
    heatmap: { subjects: heatmapSubjects, rows: heatmap },
    topics: topicSection,
    causes,
    attendance:
      attendance && attendance.marked > 0
        ? {
            marked: attendance.marked,
            absent: attendance.absent,
            rate: Math.round((attendance.attended / attendance.marked) * 100),
          }
        : null,
    diagnostics:
      diagnostics && diagnostics.attempts > 0
        ? {
            attempts: diagnostics.attempts,
            averageScore: Math.round(diagnostics.scoreSum / diagnostics.attempts),
            errorPatterns:
              diagnostics.wrong > 0
                ? {
                    rushing: Math.round((diagnostics.rushing / diagnostics.wrong) * 100),
                    knowledge: Math.round((diagnostics.knowledge / diagnostics.wrong) * 100),
                    misread: Math.round((diagnostics.misread / diagnostics.wrong) * 100),
                  }
                : null,
          }
        : null,
    topStudents: [...analyzed]
      .sort((a, b) => (b.average ?? 0) - (a.average ?? 0) || b.gradeCount - a.gradeCount)
      .slice(0, 8)
      .map(brief),
    improvers: withDelta.filter((row) => row.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 6),
    decliners: withDelta.filter((row) => row.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 6),
    riskStudents: [...analyzed]
      .filter((student) => student.riskScore >= THRESHOLDS.riskAlert)
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 12)
      .map(brief),
  };

  return overview;
}

/**
 * Rahbariyat uchun QOIDALAR xulosasi (AI ishlamasa ko'rsatiladi).
 * @returns {{summary: string, highlights: Array<{tone, text}>, priorities: Array<{title, owner, priority}>}}
 */
function buildOverviewNarrative(overview, { scopeLabel, periodLabel } = {}) {
  const highlights = [];
  const priorities = [];

  const lines = [
    `${scopeLabel ?? "Qamrov"} bo'yicha ${periodLabel ?? "davr"}: ${overview.students.analyzed} o'quvchi tahlil qilindi, ` +
      `umumiy o'rtacha ${fmt(overview.average)}.`,
  ];
  if (overview.delta != null && Math.abs(overview.delta) >= 0.05) {
    lines.push(`O'tgan davrga nisbatan ${fmt(Math.abs(overview.delta))} ballga ${overview.delta > 0 ? "oshgan" : "pasaygan"}.`);
  }
  if (overview.atRisk) lines.push(`${overview.atRisk} o'quvchi xavf guruhida.`);

  const best = overview.subjects[0];
  const worst = overview.subjects.length > 1 ? overview.subjects[overview.subjects.length - 1] : null;

  if (best?.average != null) {
    highlights.push({ tone: "positive", text: `Eng yaxshi o'zlashtirilgan fan — ${best.name} (${fmt(best.average)}).` });
  }
  if (worst?.average != null && worst.average < THRESHOLDS.goodAverage) {
    highlights.push({
      tone: "warning",
      text: `Eng past fan — ${worst.name} (${fmt(worst.average)}), ${worst.weakStudents} o'quvchida past natija.`,
    });
    priorities.push({
      title: `${worst.name}: past natijali ${worst.weakStudents} o'quvchi uchun qo'shimcha dars tashkil etish`,
      owner: `${worst.name} o'qituvchilari`,
      priority: worst.average < THRESHOLDS.weakAverage ? "high" : "medium",
    });
  }

  const falling = overview.subjects.filter((row) => row.delta != null && row.delta <= -0.2).slice(0, 2);
  for (const row of falling) {
    highlights.push({
      tone: "warning",
      text: `${row.name} bo'yicha o'rtacha ${fmt(row.previousAverage)} dan ${fmt(row.average)} ga tushgan.`,
    });
  }

  const weakTopic = overview.topics.weak[0];
  if (weakTopic) {
    highlights.push({
      tone: "info",
      text: `Eng qiyin mavzu — ${weakTopic.subject}: «${weakTopic.name}» (${fmt(weakTopic.average)}).`,
    });
    priorities.push({
      title: `${weakTopic.subject}: «${weakTopic.name}» mavzusini takrorlash darsi`,
      owner: `${weakTopic.subject} o'qituvchilari`,
      priority: "medium",
    });
  }

  const topCause = overview.causes[0];
  if (topCause) {
    highlights.push({ tone: "info", text: `Eng ko'p uchragan sabab — ${topCause.label.toLowerCase()} (${topCause.students} o'quvchi).` });
  }

  if (overview.atRisk) {
    priorities.unshift({
      title: `Xavf guruhidagi ${overview.atRisk} o'quvchi ota-onasi bilan suhbat`,
      owner: "Sinf rahbarlari",
      priority: "high",
    });
  }

  const weakClass = [...overview.classes]
    .filter((row) => row.average != null && row.average < THRESHOLDS.weakAverage)
    .sort((a, b) => a.average - b.average)[0];
  if (weakClass) {
    priorities.push({
      title: `${weakClass.name} sinfi (o'rtacha ${fmt(weakClass.average)}): sinf rahbari va fan o'qituvchilari bilan yig'ilish`,
      owner: "O'quv bo'limi",
      priority: "medium",
    });
  }

  return { summary: lines.join(" "), highlights: highlights.slice(0, 6), priorities: priorities.slice(0, 5) };
}

module.exports = {
  GRADE_ANALYSIS_PERIODS,
  PERIOD_KEYS,
  LEVELS,
  LEVEL_KEYS,
  INSUFFICIENT_LEVEL,
  THRESHOLDS,
  FINDING_CODES,
  CAUSE_LABELS,
  TONES,
  levelOf,
  levelLabel,
  buildStudentFacts,
  detectFindings,
  computeRiskScore,
  buildViews,
  analyzeStudent,
  createScopeAccumulator,
  accumulateGrade,
  accumulateAggregate,
  buildOverview,
  buildOverviewNarrative,
  // Sinov va AI qatlami uchun
  fmt,
  fmtDelta,
  shiftDay,
};
