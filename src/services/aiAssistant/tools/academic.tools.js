/**
 * AI yordamchi — TA'LIM bo'limi o'qish vositalari.
 *
 * Har bir vosita mavjud servisni HTTP controller qanday chaqirsa aynan
 * shunday chaqiradi va natijani modelga yarasha IXCHAM shaklga keltiradi.
 * Hisob-kitob (foiz, KPI, xavf guruhi) servislarda qoladi — bu yerda faqat
 * tanlash, qisqartirish va yorliq qo'shish.
 *
 * ⚠️ OY/YIL: davomat hisobotlari `month` (1-12) va `year` ni ALOHIDA oladi,
 * controllerlar esa standartni HOST vaqti bilan (`new Date().getMonth()`)
 * hisoblaydi. Bu yerda ular har doim Toshkent oyidan (`monthArg`) olinadi —
 * UTC konteynerda 1-sanadagi tungi soatlarda o'tgan oy ochilib qolmasligi uchun.
 *
 * ⚠️ MAXFIYLIK: davomat ro'yxatlari servisdan telefon raqamlari bilan keladi,
 * reyting va diagnostika esa `username` bilan. Modelga faqat id, ism, sinf
 * va sonlar boradi.
 */

const prisma = require("../../../config/prisma");
const {
  defineTool,
  AiToolError,
  idSchema,
  monthSchema,
  daySchema,
  limitSchema,
  requireId,
  monthArg,
  dayArg,
  reqLike,
  monthLabel,
  sliceList,
  personName,
} = require("../assistant.toolkit");
const { ROLES, DAYS_UZ } = require("../../../utils/constants");
const {
  formatDateUz,
  formatDateTimeUz,
  formatDateRangeUz,
} = require("../../../helpers/date.helpers");
const {
  parseDayDate,
  monthInstantRange,
} = require("../../../helpers/month.helpers");
const { ACADEMIC_METRICS, METRIC_MAX, getMetric } = require("../../../helpers/academicMetrics");
const { buildFacts } = require("../../../helpers/academicFacts");

const academicDashboardService = require("../../../services/academicDashboard.service");
const academicInsightService = require("../../../services/academicInsight.service");
const academicTargetService = require("../../../services/academicTarget.service");
const gradeService = require("../../../services/grade.service");
const statisticsService = require("../../../services/statistics.service");
const attendanceReportService = require("../../../services/attendanceReport.service");
const studentAttendanceService = require("../../../services/studentAttendance.service");
const attendanceService = require("../../../services/attendance.service");
const achievementService = require("../../../services/achievement.service");
const clubService = require("../../../services/club.service");
const teacherWorkloadService = require("../../../services/teacherWorkload.service");
const testSeasonService = require("../../../services/testSeason.service");
const seasonRewardService = require("../../../services/seasonReward.service");
const diagnosticAnalyticsService = require("../../../services/diagnosticAnalytics.service");

const TOOLSET = "academic";

/** O'quvchi davomati holatlari — foydalanuvchi matni. */
const STUDENT_STATUS_LABELS = Object.freeze({
  present: "Keldi",
  late: "Kechikdi",
  absent: "Kelmadi",
  excused: "Sababli",
});

const SEASON_STATUS_LABELS = Object.freeze({
  draft: "Qoralama",
  active: "Faol",
  closed: "Yakunlangan",
});

const EXCUSE_TYPE_LABELS = Object.freeze({
  advance: "Oldindan",
  after: "Keyin",
});

/**
 * Jarima joblari "baho qo'ymaslik" jarimasini shu prefiks bilan yozadi
 * (`jobs/gradePenalty.job.js`). Tarixiy baholash intizomining yagona
 * kaliti — alohida ustun yo'q.
 */
const GRADE_PENALTY_TITLE_PREFIX = "Baho qo'ymaslik:";

/** Diagnostika oralig'i qabul qiladigan eng uzun davr (kun). Servisda cheklov yo'q — og'ir so'rovdan himoya. */
const MAX_DIAGNOSTIC_RANGE_DAYS = 366;

/** Modelga ketadigan erkin matn (izoh, sabab) — ma'lumot, buyruq emas; uzun matn kesiladi. */
const clip = (value, max = 200) => {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** YYYYMM → servislar kutadigan alohida oy va yil. */
const splitMonthKey = (key) => ({ month: key % 100, year: Math.trunc(key / 100) });

/** "YYYY-MM-DD" → "21-may, 2025" (kalendar kuni, taymzonasiz). */
const dayLabel = (iso) => formatDateUz(parseDayDate(iso), { utc: true });

/** Foiz: `part / whole` 1 xona aniqlikda; maxraj 0 bo'lsa `null` ("ma'lumot yo'q", 0% emas). */
const percentOf = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/**
 * Diagnostika oralig'i: ixtiyoriy chegaralarni tekshiradi (servis standarti — oxirgi 30 kun).
 *
 * ⚠️ Uzunlik FAQAT `from` berilganda ham tekshiriladi: servis `to` ni bugunga
 * qo'yadi, ya'ni `from: "2020-01-01"` yolg'iz kelsa ham butun tarix o'qilardi.
 */
function diagnosticRangeQuery(args, ctx) {
  const query = {};
  if (args.from) query.from = dayArg(args.from, "Boshlanish sanasi");
  if (args.to) query.to = dayArg(args.to, "Tugash sanasi");
  if (query.from) {
    const days = (parseDayDate(query.to ?? ctx.today) - parseDayDate(query.from)) / 86400000;
    if (days < 0) throw new AiToolError("Boshlanish sanasi tugash sanasidan keyin bo'lishi mumkin emas");
    if (days > MAX_DIAGNOSTIC_RANGE_DAYS) {
      throw new AiToolError(`Diagnostika oralig'i ${MAX_DIAGNOSTIC_RANGE_DAYS} kundan oshmasin`);
    }
  }
  return query;
}

/**
 * `getNowInUzbekistan()` dan yasalgan sana (`statistics.helpers` hafta
 * chegaralari) — Toshkent devor-soati HOST lokal getterlarida yotadi.
 * Instant sifatida formatlansa UTC konteynerda kun bittaga siljiydi
 * ("23:59:59" → ertangi kun), shuning uchun kalendar kuni lokal
 * getterlardan olinadi va UTC yarim tuni sifatida formatlanadi.
 */
const wallDayLabel = (date) =>
  formatDateUz(new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())), { utc: true });

/** Servis qaytargan `range` (Toshkent kuni chegaralaridagi instantlar) → yorliq. */
const rangeLabel = (range) => (range ? formatDateRangeUz(range.from, range.to) : "—");

const diagnosticSlice = (row) => ({
  averageScore: row.averageScore,
  previousScore: row.previousScore,
  growthPoints: row.growth,
  attempts: row.attempts,
  students: row.students,
  goodPercent: row.good?.percent ?? null,
  mediumPercent: row.medium?.percent ?? null,
  badPercent: row.bad?.percent ?? null,
});

/** O'quvchi borligini va o'quvchi ekanini tekshiradi (servislar buni har doim tekshirmaydi). */
async function loadStudent(studentId) {
  const student = await prisma.user.findUnique({
    where: { id: requireId(studentId, "studentId") },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      role: true,
      isActive: true,
      isArchived: true,
      classes: { select: { class: { select: { id: true, name: true } } } },
    },
  });
  if (!student || student.role !== ROLES.STUDENT) throw new AiToolError("O'quvchi topilmadi");
  return {
    id: student.id,
    name: personName(student),
    classNames: student.classes.map((row) => row.class.name),
    isActive: student.isActive,
    isArchived: student.isArchived,
  };
}

async function loadClass(classId) {
  const row = await prisma.class.findUnique({
    where: { id: requireId(classId, "classId") },
    select: { id: true, name: true, isActive: true },
  });
  if (!row) throw new AiToolError("Sinf topilmadi");
  return row;
}

// ─────────────────────────────────────────────────────────────────────────
// Ta'lim dashboardi
// ─────────────────────────────────────────────────────────────────────────

const academicOverview = defineTool({
  name: "academic_overview",
  toolset: TOOLSET,
  label: "Ta'lim ko'rsatkichlari o'qilmoqda",
  description:
    "School-wide academic dashboard for one month (the single source of truth for education analysis): KPIs with previous month and plan " +
    "(students, averageGrade on 5-point scale, qualityRate % of grades 4-5, attendanceRate %, taskCompletion %, achievements count), " +
    "subjects (top 8 by grade count) with weakest class level, class levels (1-4, 5-6, 7-8, 9-11), student grade distribution, " +
    "lowest attendance days, top students per subject, TOP 10 teachers by KPI score (not all teachers), achievements, club coverage, " +
    "rule-based insights, weak subject×level cells, level gaps, task discipline and dataGaps (sections with too little data — never draw " +
    "conclusions about them). Values null mean no data (not zero). Use first for any question about academic performance.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema(),
      compareMonth: monthSchema("Month to compare with, YYYYMM, must be before month. Omit for the previous month."),
    },
  },
  async handler(args) {
    const month = monthArg(args.month);
    const query = { month };
    if (args.compareMonth !== undefined) query.compareMonth = monthArg(args.compareMonth, "Taqqoslash oyi");

    const overview = await academicDashboardService.getOverview(query);
    const facts = buildFacts(overview);

    const markedDays = overview.attendanceTrend.filter((day) => day.total > 0);

    return {
      month: overview.month,
      monthLabel: overview.monthLabel,
      compareMonthLabel: overview.compareMonthLabel,
      kpi: Object.values(overview.kpi).map((row) => ({
        key: row.key,
        label: getMetric(row.key)?.label ?? row.key,
        unit: row.unit,
        value: row.value,
        previous: row.previous,
        change: row.change,
        changeUnit: row.changeUnit,
        plan: row.plan,
        planRatePercent: row.planRate,
        note: row.sub,
      })),
      totals: overview.totals,
      levels: overview.levels,
      subjects: overview.subjects.map((row) => ({
        subjectId: row.subjectId,
        name: row.name,
        average: row.average,
        previousAverage: row.previousAverage,
        gradeCount: row.gradeCount,
        weakestLevel: row.weakestLevel
          ? { label: row.weakestLevel.label, average: row.weakestLevel.average, gradeCount: row.weakestLevel.gradeCount }
          : null,
      })),
      studentDistributionByAverage: overview.distribution.map((row) => ({
        grade: row.grade,
        label: row.label,
        students: row.count,
        share: row.share,
      })),
      attendanceDays: {
        markedDays: markedDays.length,
        lowestDays: [...markedDays]
          .sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101))
          .slice(0, 5)
          .map((day) => ({ dayLabel: day.dayLabel, rate: day.rate, present: day.present, total: day.total })),
      },
      topStudents: overview.topStudents.map((row) => ({
        studentId: row.studentId,
        studentName: row.studentName,
        className: row.className,
        subjectName: row.subjectName,
        average: row.average,
        gradeCount: row.gradeCount,
      })),
      teachersTop10ByScore: overview.teachers.map((row) => ({
        teacherId: row.teacherId,
        name: row.name,
        isArchived: row.isArchived,
        subjects: row.subjectNames,
        gradeCount: row.gradeCount,
        averageGrade: row.averageGrade,
        attendanceRate: row.attendanceRate,
        taskRate: row.taskRate,
        score: row.score,
      })),
      achievements: {
        total: overview.achievements.total,
        previousTotal: overview.achievements.previousTotal,
        change: overview.achievements.change,
        levels: overview.achievements.levels.map((row) => ({ label: row.label, count: row.count, previousCount: row.previousCount })),
        places: overview.achievements.places.map((row) => ({ label: row.label, count: row.count })),
        recent: overview.achievements.recent.slice(0, 5).map((row) => ({
          title: row.title,
          levelLabel: row.levelLabel,
          placeLabel: row.placeLabel,
          dateLabel: formatDateUz(row.date, { utc: true }),
          studentName: row.studentName,
          className: row.className,
        })),
      },
      clubs: facts.clubCoverage,
      insights: overview.insights.map((row) => ({ tone: row.tone, text: row.text })),
      weakCells: facts.weakCells,
      levelGaps: facts.levelGaps,
      taskDiscipline: facts.taskDiscipline,
      dataGaps: facts.dataGaps.map((gap) => ({ key: gap.key, message: gap.message })),
    };
  },
});

const academicWeeklyInsight = defineTool({
  name: "academic_weekly_insight",
  toolset: TOOLSET,
  label: "Haftalik ta'lim tahlili o'qilmoqda",
  description:
    "The current week's education analysis shown on the education dashboard: summary, insights and up to 5 recommended weekly actions " +
    "(title, owner, due, priority). source 'ai' = generated by the model and saved, 'rules' = rule-based fallback; isSaved false means " +
    "it was computed live and never saved. Also tells whether a manual refresh is allowed now (10-minute cooldown). Read-only.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async handler() {
    const insight = await academicInsightService.getWeeklyInsight();
    return {
      weekStartLabel: insight.weekStartLabel,
      monthLabel: insight.monthLabel,
      source: insight.source,
      sourceLabel: insight.source === "ai" ? "AI tahlili" : "Qoidalar asosidagi tahlil",
      isSaved: insight.isSaved,
      generatedAtLabel: insight.generatedAt ? formatDateTimeUz(insight.generatedAt) : null,
      summary: insight.summary,
      insights: insight.insights.map((row) => ({ tone: row.tone, text: row.text })),
      actions: insight.actions.map((row) => ({
        title: row.title,
        owner: row.owner,
        dueLabel: row.dueLabel,
        priority: row.priority,
      })),
      aiEnabled: insight.aiEnabled,
      canRefresh: insight.canRefresh,
      nextRefreshAtLabel: insight.nextRefreshAt ? formatDateTimeUz(insight.nextRefreshAt) : null,
    };
  },
});

const academicTargets = defineTool({
  name: "academic_targets",
  toolset: TOOLSET,
  label: "Ta'lim rejasi o'qilmoqda",
  description:
    "Monthly academic plan values (targets) for all 6 education metrics: students (count), averageGrade (0-5), qualityRate (%), " +
    "attendanceRate (%), taskCompletion (%), achievements (count). planValue null = no plan set. Use before proposing plan changes; " +
    "actual values are in academic_overview.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { month: monthSchema() },
  },
  async handler(args) {
    const data = await academicTargetService.getTargets({ month: monthArg(args.month) });
    return {
      month: data.month,
      monthLabel: data.monthLabel,
      items: data.items.map((row) => ({
        metric: row.metric,
        label: row.label,
        kind: row.kind,
        maxValue: METRIC_MAX[row.kind] ?? null,
        hint: row.hint,
        planValue: row.planValue,
        updatedAtLabel: row.updatedAt ? formatDateTimeUz(row.updatedAt) : null,
      })),
      planSetCount: data.items.filter((row) => row.planValue !== null).length,
      metricCount: ACADEMIC_METRICS.length,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Baholar
// ─────────────────────────────────────────────────────────────────────────

const gradesMissingToday = defineTool({
  name: "grades_missing_today",
  toolset: TOOLSET,
  label: "Bugun qo'yilmagan baholar tekshirilmoqda",
  description:
    "Grading discipline TODAY only: finished lessons (end time passed) where some students got no grade, grouped by the teacher who " +
    "actually taught the lesson (substitutions applied). Returns per lesson class, subject, lesson order, time, class size and number of " +
    "students without a grade. On Sunday or a holiday returns a message instead. For past days there is no per-lesson history.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async handler(args, ctx) {
    const data = await gradeService.getMissingGradesToday();

    if (data.isSunday || data.isHoliday) {
      return { empty: true, reason: data.message, dateLabel: dayLabel(ctx.today) };
    }

    const teachers = data.byTeacher
      .map((row) => ({
        teacherId: row.teacher.id,
        teacherName: personName(row.teacher),
        lessons: row.lessons.map((lesson) => ({
          className: lesson.class.name,
          classId: lesson.class.id,
          subjectName: lesson.subject.name ?? null,
          lessonOrder: lesson.lessonOrder,
          time: lesson.startTime && lesson.endTime ? `${lesson.startTime}–${lesson.endTime}` : null,
          totalStudents: lesson.totalStudents,
          studentsWithoutGrade: lesson.missingStudents.length,
        })),
      }))
      .sort((a, b) => b.lessons.length - a.lessons.length);

    const list = sliceList(teachers, 40);

    return {
      dateLabel: dayLabel(ctx.today),
      dayName: data.dayName,
      summary: data.summary,
      teachers: list.items,
      totalTeachers: list.total,
      truncated: list.truncated,
      ...(list.total === 0 ? { note: "Tugagan darslarning barchasida baholar qo'yilgan yoki bugun tugagan dars yo'q" } : {}),
    };
  },
});

const gradesStudent = defineTool({
  name: "grades_student",
  toolset: TOOLSET,
  label: "O'quvchi baholari o'qilmoqda",
  description:
    "Grades of one student in a day range (Asia/Tashkent days, inclusive): per-subject average (string, 2 decimals), count and " +
    "distribution of 5/4/3/2/1, overall average, and the most recent grades (date, subject, grade, lesson order, teacher, comment). " +
    "Defaults: from = first day of the current month, to = today. Resolve the student id with search_people first.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId"],
    properties: {
      studentId: idSchema("Student user id."),
      from: daySchema("Start day YYYY-MM-DD (inclusive). Default: first day of the current month."),
      to: daySchema("End day YYYY-MM-DD (inclusive). Default: today."),
      limit: limitSchema(50, "How many most recent grades to list."),
    },
  },
  async handler(args, ctx) {
    const student = await loadStudent(args.studentId);
    const from = args.from ? dayArg(args.from, "Boshlanish sanasi") : `${ctx.today.slice(0, 8)}01`;
    const to = args.to ? dayArg(args.to, "Tugash sanasi") : ctx.today;
    if (from > to) throw new AiToolError("Boshlanish sanasi tugash sanasidan keyin bo'lishi mumkin emas");

    const data = await gradeService.getStudentGrades(student.id, { from, to });

    const subjects = Object.values(data.statistics)
      .map((row) => {
        const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
        for (const value of row.grades) if (distribution[value] !== undefined) distribution[value] += 1;
        return {
          subjectId: row.subject.id,
          subjectName: row.subject.name,
          average: row.average,
          count: row.count,
          distribution,
        };
      })
      .sort((a, b) => Number(a.average) - Number(b.average));

    const total = data.grades.length;
    const sum = data.grades.reduce((acc, row) => acc + row.grade, 0);
    const recent = sliceList(data.grades, args.limit ?? 20);

    return {
      student,
      periodLabel: `${dayLabel(from)} — ${dayLabel(to)}`,
      ...(total === 0 ? { empty: true, reason: "Bu davrda baho qo'yilmagan" } : {}),
      totalGrades: total,
      overallAverage: total ? (sum / total).toFixed(2) : null,
      subjects,
      recentGrades: recent.items.map((row) => ({
        dateLabel: formatDateUz(row.date),
        subjectName: row.subject?.name ?? null,
        grade: row.grade,
        lessonOrder: row.lessonOrder,
        className: row.class?.name ?? null,
        teacherName: row.teacher ? personName(row.teacher) : null,
        comment: clip(row.comment),
        isEdited: row.isEdited,
      })),
      recentTruncated: recent.truncated,
    };
  },
});

const gradesRankings = defineTool({
  name: "grades_rankings",
  toolset: TOOLSET,
  label: "Haftalik baho reytingi o'qilmoqda",
  description:
    "Current-week student ranking by SUM of grades (not average) for the whole school or one class. Returns rank, student, classes, " +
    "totalSum and totalGrades. Current week only (Monday–today, Asia/Tashkent).",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      classId: idSchema("Class id to rank inside one class. Omit for the whole school."),
      limit: limitSchema(100, "How many top positions to return."),
    },
  },
  async handler(args) {
    const limit = args.limit ?? 20;
    const result = args.classId
      ? await statisticsService.getClassRankings(requireId(args.classId, "classId"), { page: 1, limit })
      : await statisticsService.getSchoolRankings({ page: 1, limit });

    const { data } = result;
    const scope = data.class ? `Sinf: ${data.class.name}` : "Butun maktab";
    const weekLabel = `${wallDayLabel(data.weekStart)} — ${wallDayLabel(data.weekEnd)}`;

    // Servis baho olmagan o'quvchilarni ham 0 ball bilan "1-o'rin" deb
    // qaytaradi — bunday ro'yxat reyting emas, modelni chalg'itadi.
    if (data.rankings.every((row) => row.totalGrades === 0)) {
      return {
        scope,
        weekLabel,
        weekNumber: data.weekNumber,
        totalStudents: data.totalStudents,
        empty: true,
        reason: "Bu hafta hali baho qo'yilmagan — reyting yo'q",
      };
    }

    return {
      scope,
      weekLabel,
      weekNumber: data.weekNumber,
      totalStudents: data.totalStudents,
      rankings: data.rankings.map((row) => ({
        rank: row.rank,
        studentId: row.student.id,
        studentName: personName(row.student),
        classNames: row.classes ? row.classes.map((c) => c.name) : undefined,
        totalSum: row.totalSum,
        totalGrades: row.totalGrades,
      })),
      truncated: data.totalStudents > data.rankings.length,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Davomat
// ─────────────────────────────────────────────────────────────────────────

const countsRow = (row) => ({
  percent: row.percent,
  came: row.came,
  expected: row.expected,
  present: row.present,
  late: row.late,
  absent: row.absent,
  excused: row.excused,
  unmarked: row.unmarked,
});

const attendanceStudentsReport = defineTool({
  name: "attendance_students_report",
  toolset: TOOLSET,
  label: "O'quvchilar davomati hisoboti o'qilmoqda",
  description:
    "Student attendance report for a month. percent = came (present + late) / EXPECTED student-days (from the timetable); unmarked " +
    "expected students count as not came. Returns the selected day card, monthly totals, per-class rates (sorted best first), " +
    "per school day rates, weekday missed %, the AT-RISK group (3+ consecutive missed recorded days or 5+ missed days in the month) " +
    "with names, best students and absence reason categories. Use for 'low attendance', 'who misses school', class comparisons.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema(),
      day: daySchema("Day YYYY-MM-DD for the daily card. Default: today."),
      riskLimit: limitSchema(40, "How many at-risk students to list."),
    },
  },
  async handler(args, ctx) {
    const key = monthArg(args.month);
    const { month, year } = splitMonthKey(key);
    const day = dayArg(args.day ?? ctx.today);

    const report = await attendanceReportService.getStudentReport(month, year, { day });
    const risk = sliceList(report.riskGroup, args.riskLimit ?? 30);

    return {
      monthLabel: monthLabel(key),
      totalActiveStudents: report.totalStudents,
      daily: { dateLabel: report.overall.daily.dateLabel, ...countsRow(report.overall.daily) },
      monthly: countsRow(report.overall.monthly),
      ...(report.byDay.length === 0 ? { empty: true, reason: "Bu oyda davomat belgilanmagan" } : {}),
      byClass: report.byClass.map((row) => ({ classId: row.classId, className: row.className, ...countsRow(row) })),
      byDay: report.byDay.map((row) => ({ dateLabel: dayLabel(row.date), percent: row.percent, came: row.came, expected: row.expected })),
      weekdayMissed: report.weekdayTrend.map((row) => ({
        day: DAYS_UZ[row.dayOfWeek],
        missed: row.missed,
        expected: row.total,
        missedPercent: row.percent,
      })),
      riskGroup: risk.items.map((row) => ({
        studentId: row.studentId,
        name: row.name,
        className: row.className,
        missedTotal: row.missedTotal,
        maxConsecutiveMissed: row.maxStreak,
        currentStreak: row.streak,
        ...countsRow(row),
      })),
      riskGroupTotal: risk.total,
      riskGroupTruncated: risk.truncated,
      topStudents: report.topStudents.slice(0, 5).map((row) => ({
        studentId: row.studentId,
        name: row.name,
        className: row.className,
        percent: row.percent,
        came: row.came,
        expected: row.expected,
      })),
      reasons: report.reasons,
      thresholds: report.thresholds,
    };
  },
});

const attendanceStaffReport = defineTool({
  name: "attendance_staff_report",
  toolset: TOOLSET,
  label: "Xodimlar davomati hisoboti o'qilmoqda",
  description:
    "Staff attendance HR report for a month: today's balance (present/late/absent/excused/not marked), staff excused today with reason, " +
    "punctuality (top 20 by late count with total and average late minutes), timesheet (days with check-in and check-out, hours worked) " +
    "and the 10 best staff by attendance percent. Staff = users who are not students or the owner.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema(),
      timesheetLimit: limitSchema(60, "How many timesheet rows to list (sorted by total hours desc)."),
    },
  },
  async handler(args) {
    const key = monthArg(args.month);
    const { month, year } = splitMonthKey(key);
    const report = await attendanceReportService.getStaffReport(month, year);
    const timesheet = sliceList(report.timesheet, args.timesheetLimit ?? 30);

    return {
      monthLabel: monthLabel(key),
      todayBalance: report.todayBalance,
      todayExcused: report.todayExcused.map((row) => ({
        userId: row.userId,
        name: row.name,
        role: row.role,
        reasonTitle: row.reasonTitle,
        note: clip(row.note),
      })),
      punctuality: report.punctuality,
      timesheet: timesheet.items.map((row) => ({
        userId: row.userId,
        name: row.name,
        role: row.role,
        days: row.days,
        totalHours: Math.round(row.totalMinutes / 6) / 10,
        avgHoursPerDay: Math.round(row.avgMinutesPerDay / 6) / 10,
      })),
      timesheetTotal: timesheet.total,
      timesheetTruncated: timesheet.truncated,
      topStaff: report.topStaff.map((row) => ({
        userId: row.userId,
        name: row.name,
        role: row.role,
        percent: row.percent,
        present: row.present,
        late: row.late,
        absent: row.absent,
        excused: row.excused,
        total: row.total,
      })),
      ...(report.timesheet.length === 0 && report.topStaff.length === 0
        ? { empty: true, reason: "Bu oyda xodimlar davomati qayd etilmagan" }
        : {}),
    };
  },
});

const attendanceToday = defineTool({
  name: "attendance_today",
  toolset: TOOLSET,
  label: "Kunlik o'quvchilar davomati o'qilmoqda",
  description:
    "School-wide student attendance for one day (default today): totals over all active students (came = present + late, notCame " +
    "includes unmarked) and per-class rows sorted by the lowest came rate, plus classes with nobody marked. Not timetable-based " +
    "(every active student counts). Use for 'how is attendance today' and to find classes that did not mark attendance.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      date: daySchema("Day YYYY-MM-DD. Default: today."),
      limit: limitSchema(60, "How many classes to list."),
    },
  },
  async handler(args, ctx) {
    const date = dayArg(args.date ?? ctx.today);
    const data = await studentAttendanceService.getMarkList({ date, status: null, search: null, classId: null });

    const classIds = new Set();
    const byClass = new Map();
    for (const row of data.students) {
      const classId = row.classId ?? "none";
      classIds.add(classId);
      const bucket = byClass.get(classId) ?? { total: 0, present: 0, late: 0, absent: 0, excused: 0, unmarked: 0 };
      bucket.total += 1;
      if (row.attendance) bucket[row.attendance.status] += 1;
      else bucket.unmarked += 1;
      byClass.set(classId, bucket);
    }

    const classNames = new Map(
      (
        await prisma.class.findMany({
          where: { id: { in: [...classIds].filter((id) => id !== "none") } },
          select: { id: true, name: true },
        })
      ).map((row) => [row.id, row.name]),
    );

    const rows = [...byClass.entries()].map(([classId, bucket]) => ({
      classId: classId === "none" ? null : classId,
      className: classId === "none" ? "Sinfsiz" : classNames.get(classId) ?? "—",
      ...bucket,
      came: bucket.present + bucket.late,
      cameRate: percentOf(bucket.present + bucket.late, bucket.total),
    }));

    const unmarkedClasses = rows.filter((row) => row.unmarked === row.total).map((row) => row.className);
    const ranked = rows
      .filter((row) => row.unmarked < row.total)
      .sort((a, b) => a.cameRate - b.cameRate || b.total - a.total);
    const list = sliceList(ranked, args.limit ?? 20);

    const { summary } = data;
    return {
      dateLabel: dayLabel(date),
      summary: {
        ...summary,
        cameRate: summary.unmarked === summary.total ? null : percentOf(summary.came, summary.total),
      },
      ...(summary.total > 0 && summary.unmarked === summary.total
        ? { empty: true, reason: "Bu kun uchun davomat umuman belgilanmagan" }
        : {}),
      classesLowestFirst: list.items,
      classesTotal: list.total,
      classesTruncated: list.truncated,
      classesWithNothingMarked: unmarkedClasses,
    };
  },
});

const attendanceClassMonth = defineTool({
  name: "attendance_class_month",
  toolset: TOOLSET,
  label: "Sinf davomati o'qilmoqda",
  description:
    "One class's student attendance records for a month, aggregated per student: present, late, absent, excused counts and the " +
    "dates missed (absent/excused), sorted by most missed first, plus class totals. Counts only recorded marks (unmarked days are " +
    "not included — use attendance_students_report for expected-based percentages).",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["classId"],
    properties: {
      classId: idSchema("Class id."),
      month: monthSchema(),
      limit: limitSchema(100, "How many students to list."),
    },
  },
  async handler(args) {
    const key = monthArg(args.month);
    const { month, year } = splitMonthKey(key);
    const cls = await loadClass(args.classId);
    const data = await studentAttendanceService.getClassMonthRecords(cls.id, month, year);

    const perStudent = new Map();
    for (const record of data.records) {
      const row = perStudent.get(record.studentId) ?? {
        studentId: record.studentId,
        name: record.student ? personName(record.student) : "—",
        present: 0,
        late: 0,
        absent: 0,
        excused: 0,
        missedDates: [],
      };
      row[record.status] += 1;
      if (record.status === "absent" || record.status === "excused") row.missedDates.push(record.date);
      perStudent.set(record.studentId, row);
    }

    const students = [...perStudent.values()]
      .map((row) => {
        const missed = row.absent + row.excused;
        return {
          studentId: row.studentId,
          name: row.name,
          present: row.present,
          late: row.late,
          absent: row.absent,
          excused: row.excused,
          missed,
          missedDates: row.missedDates
            .sort((a, b) => a - b)
            .slice(0, 12)
            .map((date) => formatDateUz(date, { utc: true })),
        };
      })
      .sort((a, b) => b.missed - a.missed || b.late - a.late);
    const list = sliceList(students, args.limit ?? 40);

    return {
      class: { id: cls.id, name: cls.name, isActive: cls.isActive },
      monthLabel: monthLabel(key),
      ...(data.records.length === 0 ? { empty: true, reason: "Bu oyda sinf uchun davomat yozuvi yo'q" } : {}),
      summary: { ...data.summary, records: data.records.length },
      students: list.items,
      studentsTotal: list.total,
      truncated: list.truncated,
    };
  },
});

const attendanceStudentMonth = defineTool({
  name: "attendance_student_month",
  toolset: TOOLSET,
  label: "O'quvchi davomati o'qilmoqda",
  description:
    "One student's attendance marks for a month, day by day: date, status (present/late/absent/excused), class, note, reason category, " +
    "whether auto-marked by the nightly job, plus counts. Use before correcting a student's attendance.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["studentId"],
    properties: {
      studentId: idSchema("Student user id."),
      month: monthSchema(),
    },
  },
  async handler(args) {
    const key = monthArg(args.month);
    const { month, year } = splitMonthKey(key);
    const student = await loadStudent(args.studentId);
    const data = await studentAttendanceService.getStudentMonthRecords(student.id, month, year);

    return {
      student,
      monthLabel: monthLabel(key),
      ...(data.records.length === 0 ? { empty: true, reason: "Bu oyda davomat yozuvi yo'q" } : {}),
      summary: data.summary,
      records: data.records.map((row) => ({
        recordId: row.id,
        date: row.date.toISOString().slice(0, 10),
        dateLabel: formatDateUz(row.date, { utc: true }),
        status: row.status,
        statusLabel: STUDENT_STATUS_LABELS[row.status] ?? row.status,
        className: row.class?.name ?? null,
        note: clip(row.excuseReason),
        reasonTitle: row.absenceReason?.title ?? null,
        autoMarked: row.autoMarked,
      })),
    };
  },
});

const attendancePendingExcuses = defineTool({
  name: "attendance_pending_excuses",
  toolset: TOOLSET,
  label: "Kutilayotgan uzrli so'rovlar o'qilmoqda",
  description:
    "Staff excuse (absence justification) requests waiting for review, newest first: excuse id, staff member, day, reason category, " +
    "free-text reason, type (before/after the day), attachments count and submission time. Use the excuse id with " +
    "propose_review_excuse.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { limit: limitSchema(25, "How many requests to list.") },
  },
  async handler(args, ctx) {
    const result = await attendanceService.getAllExcuses(
      reqLike(ctx, { status: "pending", page: 1, limit: args.limit ?? 20 }),
    );

    if (result.pagination.total === 0) {
      return { empty: true, reason: "Ko'rib chiqilishi kutilayotgan uzrli so'rov yo'q", pendingTotal: 0 };
    }

    return {
      pendingTotal: result.pagination.total,
      truncated: result.pagination.total > result.data.length,
      items: result.data.map((row) => ({
        excuseId: row.id,
        userId: row.userId,
        name: row.user ? personName({ firstName: row.user.firstName, lastName: row.user.lastName }) : "—",
        role: row.user?.role ?? null,
        dateLabel: formatDateUz(row.date, { utc: true }),
        reasonTitle: row.absenceReason?.title ?? null,
        reason: clip(row.reason, 300),
        typeLabel: EXCUSE_TYPE_LABELS[row.type] ?? row.type,
        attachments: Array.isArray(row.attachments) ? row.attachments.length : 0,
        submittedAtLabel: formatDateTimeUz(row.createdAt),
      })),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Yutuqlar va to'garaklar
// ─────────────────────────────────────────────────────────────────────────

const LEVEL_KEYS = Object.keys(achievementService.ACHIEVEMENT_LEVEL_LABELS);
const PLACE_KEYS = Object.keys(achievementService.ACHIEVEMENT_PLACE_LABELS);

const academicAchievements = defineTool({
  name: "academic_achievements",
  toolset: TOOLSET,
  label: "Olimpiada yutuqlari o'qilmoqda",
  description:
    "Olympiad and competition achievements of students, newest first: title, level (school…international), place (1st/2nd/3rd/" +
    "participant), date, subject, student and class, note. Filter by month, student, level, place or a search text (title or student " +
    "name). Returns total and truncated.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema("Month YYYYMM to filter by achievement date. Omit for all time."),
      studentId: idSchema("Only this student's achievements."),
      level: { type: "string", enum: LEVEL_KEYS, description: "Competition level filter." },
      place: { type: "string", enum: PLACE_KEYS, description: "Place filter." },
      search: { type: "string", maxLength: 80, description: "Text contained in the title or the student's first/last name." },
      limit: limitSchema(40, "How many achievements to list."),
    },
  },
  async handler(args) {
    const query = { page: 1, limit: args.limit ?? 20 };
    if (args.month !== undefined) query.month = monthArg(args.month);
    if (args.studentId) query.studentId = requireId(args.studentId, "studentId");
    if (args.level) query.level = args.level;
    if (args.place) query.place = args.place;
    if (args.search) query.search = args.search;

    const result = await achievementService.getAchievements(query);

    if (result.pagination.total === 0) {
      return { empty: true, reason: "Shartga mos yutuq topilmadi", total: 0 };
    }

    return {
      ...(query.month ? { monthLabel: monthLabel(query.month) } : {}),
      total: result.pagination.total,
      truncated: result.pagination.total > result.data.length,
      items: result.data.map((row) => ({
        id: row.id,
        title: row.title,
        level: row.level,
        levelLabel: row.levelLabel,
        place: row.place,
        placeLabel: row.placeLabel,
        dateLabel: formatDateUz(row.date, { utc: true }),
        subjectName: row.subject?.name ?? null,
        student: row.student
          ? {
              id: row.student.id,
              name: personName(row.student),
              className: row.student.className,
              isArchived: row.student.isArchived,
            }
          : null,
        note: clip(row.note),
      })),
    };
  },
});

const clubsList = defineTool({
  name: "clubs_list",
  toolset: TOOLSET,
  label: "To'garaklar o'qilmoqda",
  description:
    "Clubs (extracurricular groups). Without clubId: list with leader, subject, weekly hours, active flag and member rows count " +
    "(including closed memberships). With clubId: one club with its memberships (memberId, student, class, start/end day, isActive) — " +
    "use memberId/studentId with propose_close_club_member.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      clubId: idSchema("Club id to get details and members."),
      search: { type: "string", maxLength: 80, description: "Club name contains (list mode)." },
      isActive: { type: "boolean", description: "Only active (true) or inactive (false) clubs (list mode)." },
      onlyActiveMembers: { type: "boolean", description: "Detail mode: list only current memberships. Default true." },
      limit: limitSchema(60, "How many clubs or members to list."),
    },
  },
  async handler(args) {
    const limit = args.limit ?? 20;

    if (args.clubId) {
      const club = await clubService.getClub(requireId(args.clubId, "clubId"));
      const onlyActive = args.onlyActiveMembers !== false;
      const members = club.members.filter((row) => !onlyActive || row.isActive);
      const list = sliceList(members, limit);

      return {
        club: {
          id: club.id,
          name: club.name,
          description: clip(club.description),
          isActive: club.isActive,
          weeklyHours: club.weeklyHours,
          leaderName: club.teacher ? personName(club.teacher) : null,
          subjectName: club.subject?.name ?? null,
          membershipRows: club.memberCount,
          activeMembers: club.members.filter((row) => row.isActive).length,
        },
        members: list.items.map((row) => ({
          memberId: row.id,
          studentId: row.studentId,
          name: row.student ? personName(row.student) : "—",
          className: row.student?.className ?? null,
          isArchived: row.student?.isArchived ?? null,
          startDateLabel: formatDateUz(row.startDate, { utc: true }),
          endDateLabel: row.endDate ? formatDateUz(row.endDate, { utc: true }) : null,
          isActive: row.isActive,
        })),
        membersTotal: list.total,
        truncated: list.truncated,
      };
    }

    const query = { page: 1, limit };
    if (args.search) query.search = args.search;
    if (args.isActive !== undefined) query.isActive = String(args.isActive);

    const result = await clubService.getClubs(query);
    if (result.pagination.total === 0) return { empty: true, reason: "To'garak topilmadi", total: 0 };

    return {
      total: result.pagination.total,
      truncated: result.pagination.total > result.data.length,
      items: result.data.map((row) => ({
        id: row.id,
        name: row.name,
        isActive: row.isActive,
        weeklyHours: row.weeklyHours,
        leaderId: row.teacherId,
        leaderName: row.teacher ? personName(row.teacher) : null,
        subjectName: row.subject?.name ?? null,
        membershipRows: row.memberCount,
      })),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// O'qituvchi KPI
// ─────────────────────────────────────────────────────────────────────────

const academicTeacherKpi = defineTool({
  name: "academic_teacher_kpi",
  toolset: TOOLSET,
  label: "O'qituvchi ko'rsatkichlari o'qilmoqda",
  description:
    "One teacher's academic profile: weekly timetable load (lessons per week, classes, subjects, active days, busiest day), the " +
    "teacher's monthly KPI row from the education dashboard (average grade in their lessons, own attendance, task completion, score) " +
    "when the teacher is in the dashboard's top 10, and the number of 'missing grades' penalties in that month. Whether a salary rule " +
    "exists is shown; exact pay amounts come from the payroll toolset.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["teacherId"],
    properties: {
      teacherId: idSchema("Teacher (staff) user id."),
      month: monthSchema("Month YYYYMM for the KPI row and penalties. Omit for the current month."),
    },
  },
  async handler(args) {
    const teacherId = requireId(args.teacherId, "teacherId");
    const month = monthArg(args.month);
    const { from, to } = monthInstantRange(month);

    const [workload, overview, penalties] = await Promise.all([
      teacherWorkloadService.getTeacherWorkload(teacherId, { withSalary: true }),
      academicDashboardService.getOverview({ month }),
      prisma.penalty.findMany({
        where: {
          userId: teacherId,
          status: "approved",
          title: { startsWith: GRADE_PENALTY_TITLE_PREFIX },
          createdAt: { gte: from, lte: to },
        },
        select: { points: true },
      }),
    ]);

    const kpiIndex = overview.teachers.findIndex((row) => row.teacherId === teacherId);
    const kpi = kpiIndex >= 0 ? overview.teachers[kpiIndex] : null;

    return {
      teacher: {
        id: workload.teacher.id,
        name: personName(workload.teacher),
        role: workload.teacher.role,
      },
      workload: {
        lessonsPerWeek: workload.totals.weeklyHours,
        classCount: workload.totals.classCount,
        subjectCount: workload.totals.subjectCount,
        activeDays: workload.totals.activeDays,
        busiestDay: workload.totals.busiestDay,
        ...(workload.totals.weeklyHours === 0 ? { note: "Amaldagi dars jadvalida bu xodimga dars biriktirilmagan" } : {}),
        days: workload.days.map((row) => ({ day: row.day, lessons: row.hours })),
        classes: workload.classes.map((row) => ({
          classId: row.id,
          className: row.name,
          lessonsPerWeek: row.hours,
          subjects: row.subjects.map((subject) => `${subject.name} (${subject.hours})`),
        })),
      },
      monthLabel: monthLabel(month),
      dashboardKpi: kpi
        ? {
            positionInTop10: kpiIndex + 1,
            subjects: kpi.subjectNames,
            gradeCount: kpi.gradeCount,
            averageGrade: kpi.averageGrade,
            ownAttendanceRate: kpi.attendanceRate,
            taskRate: kpi.taskRate,
            score: kpi.score,
          }
        : null,
      ...(kpi ? {} : { dashboardKpiNote: "O'qituvchi shu oy ta'lim dashboardidagi eng yaxshi 10 talik ro'yxatda yo'q" }),
      missingGradePenalties: {
        count: penalties.length,
        points: penalties.reduce((sum, row) => sum + row.points, 0),
      },
      salaryRule: {
        monthLabel: workload.salary.monthLabel,
        exists: workload.salary.periodLabel !== null,
        periodLabel: workload.salary.periodLabel,
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Testlar (mavsumlar)
// ─────────────────────────────────────────────────────────────────────────

const testsSeasons = defineTool({
  name: "tests_seasons",
  toolset: TOOLSET,
  label: "Test mavsumlari o'qilmoqda",
  description:
    "Test seasons (school test campaigns), newest first: id, name, status (draft/active/closed), active flag, start and end, whether " +
    "coins were distributed and whether the season was finalized, number of reward tiers. Use the season id with tests_season_stats.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["draft", "active", "closed"], description: "Status filter. Omit for all." },
      limit: limitSchema(30, "How many seasons to list."),
    },
  },
  async handler(args, ctx) {
    const result = await testSeasonService.listSeasons(
      reqLike(ctx, { status: args.status ?? "all", page: 1, limit: args.limit ?? 20 }),
    );

    if (result.pagination.total === 0) return { empty: true, reason: "Test mavsumi topilmadi", total: 0 };

    return {
      total: result.pagination.total,
      truncated: result.pagination.total > result.data.length,
      items: result.data.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        statusLabel: SEASON_STATUS_LABELS[row.status] ?? row.status,
        isActive: row.isActive,
        periodLabel: formatDateRangeUz(row.startDate, row.endDate),
        schoolTiers: Array.isArray(row.schoolTiers) ? row.schoolTiers.length : 0,
        classTiers: Array.isArray(row.classTiers) ? row.classTiers.length : 0,
        distributedAtLabel: row.distributedAt ? formatDateTimeUz(row.distributedAt) : null,
        finalizedAtLabel: row.finalizedAt ? formatDateTimeUz(row.finalizedAt) : null,
        createdByName: row.createdBy ? personName(row.createdBy) : null,
      })),
    };
  },
});

const testsSeasonStats = defineTool({
  name: "tests_season_stats",
  toolset: TOOLSET,
  label: "Test mavsumi natijalari o'qilmoqda",
  description:
    "Results of one test season per student: rank, average score (sum of final scores / assigned ready tests; unsubmitted tests count " +
    "as 0), total score, submitted results and assigned tests. Optional class or subject filter. Returns the top positions and the " +
    "bottom 5, plus how many assigned students submitted nothing.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["seasonId"],
    properties: {
      seasonId: idSchema("Test season id."),
      classId: idSchema("Only students of this class."),
      subjectId: idSchema("Only tests of this subject."),
      limit: limitSchema(60, "How many top positions to list."),
    },
  },
  async handler(args) {
    const seasonId = requireId(args.seasonId, "seasonId");
    const filter = {};
    if (args.classId) filter.classId = requireId(args.classId, "classId");
    if (args.subjectId) filter.subjectId = requireId(args.subjectId, "subjectId");

    const [season, rows] = await Promise.all([
      testSeasonService.getSeasonById(seasonId),
      seasonRewardService.getSeasonStats(seasonId, filter),
    ]);

    const shape = (row) => ({
      rank: row.rank,
      studentId: row.student.id,
      name: personName(row.student),
      classNames: row.student.classes.map((c) => c.name),
      averageScore: Math.round(row.averageScore * 100) / 100,
      totalScore: Math.round(row.totalScore * 100) / 100,
      results: row.resultCount,
      assignedTests: row.assignedCount,
    });

    const limit = args.limit ?? 20;
    const top = rows.slice(0, limit);

    return {
      season: {
        id: season.id,
        name: season.name,
        statusLabel: SEASON_STATUS_LABELS[season.status] ?? season.status,
        periodLabel: formatDateRangeUz(season.startDate, season.endDate),
      },
      ...(rows.length === 0 ? { empty: true, reason: "Bu mavsumda biriktirilgan test yoki natija yo'q" } : {}),
      totalStudents: rows.length,
      studentsWithoutResults: rows.filter((row) => row.resultCount === 0 && row.assignedCount > 0).length,
      top: top.map(shape),
      // Pastki 5 talik yuqoridagi ro'yxat bilan kesishmaydi (22 qator, limit 20 → faqat 21–22)
      bottom: rows.slice(Math.max(limit, rows.length - 5)).map(shape),
      truncated: rows.length > limit,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Diagnostika
// ─────────────────────────────────────────────────────────────────────────

const diagnosticsSummary = defineTool({
  name: "diagnostics_summary",
  toolset: TOOLSET,
  label: "Diagnostika tahlili o'qilmoqda",
  description:
    "Diagnostic testing analytics for a day range (default: last 30 days), each compared with the previous period of equal length: " +
    "attempts, tested students and coverage %, average score (0-100) with growth in points, good/medium/bad distribution and " +
    "thresholds, error patterns (rushing/knowledge/misread %), per subject and per class slices, the weakest topics, students needing " +
    "attention (low average or falling by 10+ points) and participation (students with no attempt).",
  timeoutMs: 45000,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: daySchema("Start day YYYY-MM-DD. Default: 29 days before 'to'. The range may not exceed 366 days."),
      to: daySchema("End day YYYY-MM-DD (inclusive). Default: today."),
    },
  },
  async handler(args, ctx) {
    const query = diagnosticRangeQuery(args, ctx);

    const [summary, subjects, classes, topics, students, participation] = await Promise.all([
      diagnosticAnalyticsService.getSummary(query),
      diagnosticAnalyticsService.getBySubject(query),
      diagnosticAnalyticsService.getByClass(query),
      diagnosticAnalyticsService.getByTopic(query),
      diagnosticAnalyticsService.getByStudent(query),
      diagnosticAnalyticsService.getParticipation(query),
    ]);

    return {
      periodLabel: rangeLabel(summary.range),
      previousPeriodLabel: rangeLabel(summary.previousRange),
      ...(summary.kpis.attempts.value === 0 ? { empty: true, reason: "Bu davrda yakunlangan diagnostika urinishi yo'q" } : {}),
      kpis: {
        attempts: summary.kpis.attempts,
        students: summary.kpis.students,
        averageScore: summary.kpis.averageScore,
        averageTimeMinutes: Math.round(summary.kpis.averageTime.value / 6) / 10,
        // ⚠️ Servis bu yerda maktabdagi JAMI sinflar sonini beradi (sana filtrisiz), test ishlaganlarni emas
        totalClassesInSchool: summary.kpis.classes.value,
        approvedQuestionsInBank: summary.kpis.bank.approvedQuestions,
      },
      distribution: summary.distribution,
      errorPatterns: {
        wrongAnswers: summary.errorPatterns.wrongCount,
        causesPercentOfWrong: {
          rushing: summary.errorPatterns.rushing,
          knowledgeGap: summary.errorPatterns.knowledge,
          misread: summary.errorPatterns.misread,
        },
      },
      subjects: subjects.data.map((row) => ({ subjectId: row.subjectId, name: row.label, ...diagnosticSlice(row) })),
      classes: classes.data.map((row) => ({
        classId: row.classId,
        name: row.label,
        studentCount: row.studentCount,
        tone: row.tone,
        ...diagnosticSlice(row),
      })),
      weakestTopics: topics.weakest.map((row) => ({
        topic: row.label,
        subjectName: row.subjectName,
        averageScore: row.averageScore,
        growthPoints: row.growth,
        questions: row.questions,
        students: row.students,
      })),
      studentsNeedingAttention: students.attention.map((row) => ({
        studentId: row.studentId,
        name: row.label,
        className: row.className,
        averageScore: row.averageScore,
        growthPoints: row.growth,
        attempts: row.attempts,
      })),
      participation: {
        totalStudents: participation.total,
        tested: participation.tested,
        percent: participation.percent,
        notTestedSample: participation.missing.slice(0, 15).map((row) => ({
          studentId: row.id,
          name: personName(row),
          className: row.className,
        })),
        notTestedTotal: participation.missing.length,
      },
    };
  },
});

const diagnosticsClass = defineTool({
  name: "diagnostics_class",
  toolset: TOOLSET,
  label: "Sinf diagnostikasi o'qilmoqda",
  description:
    "Diagnostic results of one class for a day range (default: last 30 days): summary (students, tests, attempts, tested students, " +
    "average score 0-100, grade), tests assigned to the class with completion, and students with attempts, average score and grade " +
    "(students without attempts have attempts 0). Current class membership.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["classId"],
    properties: {
      classId: idSchema("Class id."),
      from: daySchema("Start day YYYY-MM-DD. Default: 29 days before 'to'. The range may not exceed 366 days."),
      to: daySchema("End day YYYY-MM-DD (inclusive). Default: today."),
      limit: limitSchema(100, "How many students to list (lowest average first)."),
    },
  },
  async handler(args, ctx) {
    const classId = requireId(args.classId, "classId");
    const query = diagnosticRangeQuery(args, ctx);
    const data = await diagnosticAnalyticsService.getClassDetail(classId, query);
    if (!data) throw new AiToolError("Sinf topilmadi");

    const students = [...data.students].sort(
      (a, b) => (a.averageScore ?? Number.POSITIVE_INFINITY) - (b.averageScore ?? Number.POSITIVE_INFINITY),
    );
    const list = sliceList(students, args.limit ?? 40);

    return {
      class: data.class,
      periodLabel: rangeLabel(data.range),
      summary: data.summary,
      tests: data.tests.slice(0, 20).map((row) => ({
        testId: row.id,
        title: row.title,
        subjectName: row.subjectName,
        mode: row.mode,
        status: row.status,
        questionCount: row.questionCount,
        averageScore: row.averageScore,
        completed: row.completed,
        total: row.total,
      })),
      students: list.items.map((row) => ({
        studentId: row.id,
        name: personName(row),
        attempts: row.attempts,
        averageScore: row.averageScore,
        grade: row.grade,
        lastAttemptLabel: row.lastAt ? formatDateTimeUz(row.lastAt) : null,
      })),
      studentsTotal: list.total,
      truncated: list.truncated,
    };
  },
});

module.exports = [
  academicOverview,
  academicWeeklyInsight,
  academicTargets,
  gradesMissingToday,
  gradesStudent,
  gradesRankings,
  attendanceStudentsReport,
  attendanceStaffReport,
  attendanceToday,
  attendanceClassMonth,
  attendanceStudentMonth,
  attendancePendingExcuses,
  academicAchievements,
  clubsList,
  academicTeacherKpi,
  testsSeasons,
  testsSeasonStats,
  diagnosticsSummary,
  diagnosticsClass,
];
