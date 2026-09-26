/**
 * BAHOLAR TAHLILI — ishga tushirish, ishlash, nashr va o'qish.
 *
 * Qatlamlar:
 *   `helpers/gradeAnalysis.js`          — RAQAM va SABAB (sof funksiyalar)
 *   `services/gradeAnalysisAi.service`  — faqat MATN (har soni tekshiriladi)
 *   shu fayl                            — baza, navbat, nashr, API shakli
 *
 * HAYOT SIKLI:
 *   createRun  → `queued` (HTTP darhol qaytadi, ish fonda)
 *   processRun → `running`: o'quvchilar BO'LAKLAB (`CHUNK_SIZE`) o'qiladi,
 *                har biriga hisobot yoziladi, har bo'lakdan keyin progress
 *                va "yurak urishi" (`heartbeatAt`) yangilanadi
 *              → `completed`: qamrov yig'masi + rahbariyat xulosasi;
 *                `notify` bo'lsa hisobotlar o'quvchi/ota-onaga ochiladi
 *
 * ⚠️ TIKLANISH. Jarayon o'rtada o'lsa (deploy, xato) tahlil `running` da
 * osilib qolardi. `recoverStaleRuns` (cron) yurak urishi to'xtaganini
 * qayta navbatga qo'yadi va `processRun` qayta boshlaydi: `(runId,
 * studentId)` yagona, ya'ni yozilgan hisobot QAYTA YOZILMAYDI (AI ham
 * qayta chaqirilmaydi), faqat qolganlari ishlanadi. Yig'ma esa oxirida
 * BAZADAGI hisobotlardan quriladi — xotiradagi holatga tayanmaydi.
 *
 * ⚠️ BIR FILIALDA BIR VAQTDA BITTA TAHLIL. Butun maktab tahlili minglab
 * so'rov va model chaqiruvi; ikkitasi parallel ketsa bazani ham, AI
 * limitini ham ikki barobar yeydi. Yangi so'rov 409 bilan qaytadi.
 *
 * ⚠️ HISOBOT MUHRLANGAN. Baho keyin tahrirlansa ham o'tgan hisobot
 * o'zgarmaydi — ota-ona ko'rgan raqam ertaga boshqacha bo'lmasin.
 *
 * ⚠️ ARXIVLANGAN O'QUVCHI TAHLILGA KIRMAYDI (`education.md` §4), sinf
 * o'rtachalari (taqqoslash bazasi) ham ularsiz hisoblanadi.
 */

const prisma = require("../config/prisma");
const { getBranch } = require("../config/branchContext");
const logger = require("../utils/logger");
const { ROLES } = require("../utils/constants");
const {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} = require("../utils/errors");
const { getTashkentDateUtc, formatDateRangeUz } = require("../helpers/date.helpers");
const { tashkentDayKey } = require("../helpers/lessonHours");
const {
  GRADE_ANALYSIS_PERIODS,
  PERIOD_KEYS,
  LEVELS,
  INSUFFICIENT_LEVEL,
  THRESHOLDS,
  FINDING_CODES,
  CAUSE_LABELS,
  TONES,
  levelLabel,
  analyzeStudent,
  createScopeAccumulator,
  accumulateGrade,
  accumulateAggregate,
  buildOverview,
  buildOverviewNarrative,
  shiftDay,
} = require("../helpers/gradeAnalysis");
const ai = require("./gradeAnalysisAi.service");
const { sendToUsers } = require("./push.service");
const { buildGradeAnalysisPush } = require("../helpers/gradeAnalysisPush.helpers");
const { getGradeAnalysisSettings } = require("./settings.service");
const { loadArchivedStudentScope } = require("./archivedStudentScope.service");

/* ─────────────────────────── DOIMIYLAR ─────────────────────────── */

const SCOPES = Object.freeze({ SCHOOL: "school", CLASSES: "classes", STUDENT: "student" });
const SCOPE_KEYS = Object.freeze(Object.values(SCOPES));
const TRIGGERS = Object.freeze({ MANUAL: "manual", WEEKLY: "weekly" });
const STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});
const ACTIVE_STATUSES = [STATUS.QUEUED, STATUS.RUNNING];

/** Bir bo'lakda nechta o'quvchi — baholar so'rovi `studentId IN (...)` bilan. */
const CHUNK_SIZE = 40;

/** Bir vaqtda nechta model chaqiruvi (bo'lak ichida). */
const AI_CONCURRENCY = 4;

/**
 * Yurak urishi shundan eski bo'lsa tahlil "to'xtab qolgan" hisoblanadi.
 * ⚠️ Bitta bo'lak (40 o'quvchi × model) bir necha daqiqa olishi mumkin —
 * chegara undan ancha katta, aks holda tirik tahlil ikkinchi marta
 * boshlanib ketardi.
 */
const STALE_AFTER_MS = 15 * 60 * 1000;

/** Nashr qilinadigan hisobot — ma'lumoti yetarli bo'lgani. */
const PUBLISHABLE = { level: { not: INSUFFICIENT_LEVEL.key } };

/** Ro'yxatda ko'p bo'lsa ham qidiruv tez qolsin. */
const SEARCH_LIMIT = 20;

const AUDIENCES = Object.freeze({ STUDENT: "student", PARENT: "parent" });

/* ─────────────────────────── YORDAMCHILAR ─────────────────────────── */

const toIsoDay = (date) => (date ? new Date(date).toISOString().slice(0, 10) : null);
const dayToDate = (iso) => new Date(`${iso}T00:00:00Z`);

/**
 * Toshkent kunlari oralig'i → baho instantlari oralig'i (UTC).
 * `[from 00:00 +05, (to+1) 00:00 +05)` — Toshkentda DST yo'q.
 */
const instantRange = (fromIso, toIso) => ({
  gte: new Date(dayToDate(fromIso).getTime() - 5 * 3600000),
  lt: new Date(dayToDate(shiftDay(toIso, 1)).getTime() - 5 * 3600000),
});

const fullName = (user) => [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() || "—";

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/** Cheklangan parallellik — natija tartibi kirish tartibida. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Davr oynasi. `toIso` berilmasa — bugun (Toshkent). Haftalik cron
 * kechagi kunni beradi: dushanba ertalab "o'tgan hafta" to'liq yakshanba
 * bilan tugaydi.
 */
function periodWindow(periodKey, toIso) {
  const period = GRADE_ANALYSIS_PERIODS[periodKey];
  const to = toIso || toIsoDay(getTashkentDateUtc(0));
  const from = shiftDay(to, -(period.days - 1));
  return {
    ...period,
    from,
    to,
    previousFrom: shiftDay(from, -period.days),
    previousTo: shiftDay(from, -1),
    rangeLabel: formatDateRangeUz(dayToDate(from), dayToDate(to), { utc: true }),
  };
}

const isInFlightKey = (runId) => `${getBranch()?.schemaName ?? "?"}:${runId}`;
/** Shu jarayonda hozir ishlanayotgan tahlillar (ikki marta boshlanmasin). */
const inFlight = new Set();

/* ─────────────────────────── O'QUVCHILAR QAMROVI ─────────────────────────── */

/**
 * Qamrovdagi o'quvchilar va har birining SINFI.
 *
 * ⚠️ O'quvchi bir nechta sinfda bo'lishi mumkin (`UserClass` — M2M). Sinf
 * tahlili bo'lsa — tanlangan sinflardan biri, aks holda nom bo'yicha
 * birinchisi: taqqoslash bazasi (sinf o'rtachasi) aynan shu sinfdan.
 */
async function resolveStudents(run) {
  const where = { role: ROLES.STUDENT, isArchived: false };
  if (run.scope === SCOPES.STUDENT) where.id = run.studentId;
  if (run.scope === SCOPES.CLASSES) where.classes = { some: { classId: { in: run.classIds } } };

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      classes: { select: { class: { select: { id: true, name: true } } } },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  const wanted = run.scope === SCOPES.CLASSES ? new Set(run.classIds) : null;

  return users.map((user) => {
    const classes = user.classes
      .map((row) => row.class)
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, "uz", { numeric: true }));
    const cls = (wanted && classes.find((row) => wanted.has(row.id))) || classes[0] || null;
    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName || "",
      classId: cls?.id ?? null,
      className: cls?.name ?? null,
    };
  });
}

/* ─────────────────────────── TAQQOSLASH BAZASI ─────────────────────────── */

/**
 * Sinf × fan va sinf × mavzu o'rtachalari — o'quvchini SINFI bilan
 * taqqoslash uchun. Butun sinf baholaridan (qamrov bitta o'quvchi bo'lsa
 * ham), arxivlanganlarsiz.
 */
async function loadClassBenchmarks(classIds, window, archivedScope) {
  if (classIds.length === 0) return { subject: new Map(), topic: new Map() };

  const where = { classId: { in: classIds }, date: instantRange(window.from, window.to), ...archivedScope };
  const [bySubject, byTopic] = await Promise.all([
    prisma.grade.groupBy({ by: ["classId", "subjectId"], where, _sum: { grade: true }, _count: { _all: true } }),
    prisma.grade.groupBy({
      by: ["classId", "topicId"],
      where: { ...where, topicId: { not: null } },
      _sum: { grade: true },
      _count: { _all: true },
    }),
  ]);

  const subject = new Map();
  for (const row of bySubject) {
    if (!subject.has(row.classId)) subject.set(row.classId, {});
    subject.get(row.classId)[row.subjectId] = {
      average: row._sum.grade / row._count._all,
      count: row._count._all,
    };
  }
  const topic = new Map();
  for (const row of byTopic) {
    if (!topic.has(row.classId)) topic.set(row.classId, {});
    topic.get(row.classId)[row.topicId] = { average: row._sum.grade / row._count._all, count: row._count._all };
  }
  return { subject, topic };
}

/* ─────────────────────────── BO'LAK MA'LUMOTI ─────────────────────────── */

/**
 * Bitta bo'lak o'quvchilari uchun hamma xom ma'lumot — to'rt so'rov.
 */
async function loadChunkData(studentIds, window) {
  const [grades, previous, attendance, attempts] = await Promise.all([
    prisma.grade.findMany({
      where: { studentId: { in: studentIds }, date: instantRange(window.from, window.to) },
      select: { studentId: true, subjectId: true, classId: true, grade: true, date: true, topicId: true },
      orderBy: [{ date: "asc" }, { lessonOrder: "asc" }],
    }),
    prisma.grade.groupBy({
      by: ["studentId", "subjectId", "classId"],
      where: { studentId: { in: studentIds }, date: instantRange(window.previousFrom, window.previousTo) },
      _sum: { grade: true },
      _count: { _all: true },
    }),
    // `StudentAttendance.date` — Toshkent kunining UTC yarim tuni
    prisma.studentAttendance.findMany({
      where: {
        studentId: { in: studentIds },
        date: { gte: dayToDate(window.from), lte: dayToDate(window.to) },
      },
      select: { studentId: true, date: true, status: true },
    }),
    prisma.diagnosticAttempt.findMany({
      where: {
        studentId: { in: studentIds },
        status: { in: ["submitted", "evaluated"] },
        submittedAt: instantRange(window.from, window.to),
        score: { not: null },
      },
      select: { studentId: true, subjectId: true, score: true, breakdown: true, errorPatterns: true },
    }),
  ]);

  const group = (rows) => {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.studentId)) map.set(row.studentId, []);
      map.get(row.studentId).push(row);
    }
    return map;
  };

  return {
    grades: group(grades),
    previous: group(previous),
    attendance: group(attendance),
    attempts: group(attempts),
  };
}

/** Davomat qatorlari → faktlar kirishi. */
function attendanceInput(rows) {
  if (!rows?.length) return null;
  const out = { present: 0, late: 0, absent: 0, excused: 0, absentDays: [] };
  for (const row of rows) {
    if (out[row.status] == null) continue;
    out[row.status] += 1;
    if (row.status === "absent") out.absentDays.push(toIsoDay(row.date));
  }
  return out;
}

/** Eng jiddiy salbiy topilma — ro'yxatdagi qisqa "asosiy sabab". */
function topFindingOf(findings) {
  const rank = { critical: 0, warning: 1, info: 2 };
  const negative = (findings || [])
    .filter((finding) => rank[finding.tone] != null)
    .sort((a, b) => rank[a.tone] - rank[b.tone]);
  const top = negative[0];
  if (!top) return null;
  return {
    code: top.code,
    tone: top.tone,
    label: CAUSE_LABELS[top.code] ?? top.code,
    subject: top.subject ?? null,
    topic: top.topic ?? null,
  };
}

/* ─────────────────────────── ISHLASH ─────────────────────────── */

/**
 * Bitta o'quvchining hisoboti (AI bilan yoki qoidalar matni bilan).
 * @returns {Promise<{row: object, usedAi: boolean}>}
 */
async function buildReport({ run, window, student, data, refs, bench }) {
  const grades = (data.grades.get(student.id) || []).map((row) => ({
    subjectId: row.subjectId,
    grade: row.grade,
    dayKey: tashkentDayKey(row.date),
    topicId: row.topicId,
  }));

  const previous = {};
  for (const row of data.previous.get(student.id) || []) {
    const acc = previous[row.subjectId] ?? { sum: 0, count: 0 };
    acc.sum += row._sum.grade;
    acc.count += row._count._all;
    previous[row.subjectId] = acc;
  }

  const diagnostics = (data.attempts.get(student.id) || []).map((attempt) => ({
    subjectName: attempt.subjectId ? refs.subjectNames.get(attempt.subjectId) ?? null : null,
    score: attempt.score,
    breakdown: attempt.breakdown,
    errorPatterns: attempt.errorPatterns,
  }));

  const analysis = analyzeStudent({
    period: window,
    student: { className: student.className },
    grades,
    previous,
    subjectNames: refs.subjectNames,
    topics: refs.topics,
    classBench: (student.classId && bench.subject.get(student.classId)) || {},
    classTopicBench: (student.classId && bench.topic.get(student.classId)) || {},
    attendance: attendanceInput(data.attendance.get(student.id)),
    diagnostics,
  });

  let { studentView, parentView } = analysis.views;
  let source = "rules";
  let model = "";

  if (run.useAi && analysis.level.key !== INSUFFICIENT_LEVEL.key) {
    const written = await ai.writeStudentNarrative(analysis.facts, analysis.findings, analysis.views);
    if (written) {
      // Kuchli tomonlar va "e'tibor" kartalari qoidalardan qoladi —
      // model faqat sarlavha, xulosa va tavsiyalarni qayta yozadi.
      studentView = { ...studentView, ...written.student };
      parentView = { ...parentView, ...written.parent };
      source = "ai";
      model = written.model;
    }
  }

  return {
    usedAi: source === "ai",
    row: {
      runId: run.id,
      studentId: student.id,
      studentSnapshot: { firstName: student.firstName, lastName: student.lastName, className: student.className },
      classId: student.classId,
      period: run.period,
      fromDate: run.fromDate,
      toDate: run.toDate,
      level: analysis.level.key,
      average: analysis.facts.overall.average,
      previousAverage: analysis.facts.overall.previousAverage,
      gradeCount: analysis.facts.overall.count,
      riskScore: analysis.riskScore,
      facts: analysis.facts,
      findings: analysis.findings,
      studentView,
      parentView,
      staffView: analysis.views.staffView,
      source,
      model,
    },
  };
}

/** Faqat HOLATI kutilgandek bo'lsa yozadi (CAS). @returns {Promise<boolean>} */
async function transition(runId, from, data) {
  const { count } = await prisma.gradeAnalysisRun.updateMany({
    where: { id: runId, status: { in: [].concat(from) } },
    data,
  });
  return count === 1;
}

/**
 * Tahlilni boshidan oxirigacha ishlaydi. Xato TASHLAMAYDI — tahlil
 * `failed` bo'lib, sababi `error` ga yoziladi.
 */
async function processRun(runId) {
  const key = isInFlightKey(runId);
  if (inFlight.has(key)) return;
  inFlight.add(key);

  try {
    const claimed = await transition(runId, STATUS.QUEUED, {
      status: STATUS.RUNNING,
      startedAt: new Date(),
      heartbeatAt: new Date(),
      error: null,
    });
    if (!claimed) return;

    const run = await prisma.gradeAnalysisRun.findUnique({ where: { id: runId } });
    await executeRun(run);
  } catch (error) {
    logger.error(`[GradeAnalysis] ${runId}: xato — ${error.stack || error.message}`);
    await transition(runId, [STATUS.RUNNING, STATUS.QUEUED], {
      status: STATUS.FAILED,
      error: String(error.message).slice(0, 2000),
      finishedAt: new Date(),
    }).catch(() => {});
  } finally {
    inFlight.delete(key);
  }
}

async function executeRun(run) {
  const startedAt = Date.now();
  const window = periodWindow(run.period, toIsoDay(run.toDate));
  const students = await resolveStudents(run);

  await prisma.gradeAnalysisRun.update({
    where: { id: run.id },
    data: { total: students.length, heartbeatAt: new Date() },
  });

  const archivedScope = await loadArchivedStudentScope();
  const classIds = [...new Set(students.map((student) => student.classId).filter(Boolean))];

  const [subjects, classes, bench] = await Promise.all([
    prisma.subject.findMany({ select: { id: true, name: true } }),
    prisma.class.findMany({ select: { id: true, name: true } }),
    loadClassBenchmarks(classIds, window, archivedScope),
  ]);

  const refs = {
    subjectNames: new Map(subjects.map((row) => [row.id, row.name])),
    classNames: new Map(classes.map((row) => [row.id, row.name])),
    topics: new Map(),
  };

  // Tiklangan tahlil: yozilgan hisobot qayta yozilmaydi (AI ham chaqirilmaydi)
  const done = new Set(
    (
      await prisma.gradeAnalysisReport.findMany({ where: { runId: run.id }, select: { studentId: true } })
    ).map((row) => row.studentId),
  );

  const current = createScopeAccumulator();
  const previousAcc = createScopeAccumulator();
  const attendanceTotal = { marked: 0, attended: 0, absent: 0 };
  const diagnosticsTotal = { attempts: 0, scoreSum: 0, wrong: 0, rushing: 0, knowledge: 0, misread: 0 };

  let processed = done.size;
  let aiCount = 0;

  for (const part of chunk(students, CHUNK_SIZE)) {
    // Admin to'xtatgan bo'lsa — shu yerda chiqiladi
    const state = await prisma.gradeAnalysisRun.findUnique({ where: { id: run.id }, select: { status: true } });
    if (state?.status !== STATUS.RUNNING) {
      logger.info(`[GradeAnalysis] ${run.id}: to'xtatildi (${state?.status})`);
      return;
    }

    const data = await loadChunkData(
      part.map((student) => student.id),
      window,
    );

    // Mavzu nomlari — faqat shu bo'lakda uchragani (butun katalog emas)
    const missingTopics = new Set();
    for (const rows of data.grades.values()) {
      for (const row of rows) if (row.topicId && !refs.topics.has(row.topicId)) missingTopics.add(row.topicId);
    }
    if (missingTopics.size) {
      const topics = await prisma.topic.findMany({
        where: { id: { in: [...missingTopics] } },
        select: { id: true, name: true, subjectId: true },
      });
      for (const topic of topics) refs.topics.set(topic.id, { name: topic.name, subjectId: topic.subjectId });
    }

    // ── Qamrov yig'masi (hamma o'quvchi, tiklanganda ham — xotira holati) ──
    for (const student of part) {
      const classKey = student.classId || "";
      for (const row of data.grades.get(student.id) || []) {
        accumulateGrade(current, { ...row, classId: classKey });
      }
      for (const row of data.previous.get(student.id) || []) {
        accumulateAggregate(previousAcc, {
          subjectId: row.subjectId,
          classId: classKey,
          sum: row._sum.grade,
          count: row._count._all,
        });
      }
      for (const row of data.attendance.get(student.id) || []) {
        attendanceTotal.marked += 1;
        if (row.status === "present" || row.status === "late") attendanceTotal.attended += 1;
        if (row.status === "absent") attendanceTotal.absent += 1;
      }
      for (const attempt of data.attempts.get(student.id) || []) {
        diagnosticsTotal.attempts += 1;
        diagnosticsTotal.scoreSum += attempt.score;
        const wrong = Number(attempt.errorPatterns?.wrongCount) || 0;
        if (wrong > 0) {
          diagnosticsTotal.wrong += wrong;
          for (const k of ["rushing", "knowledge", "misread"]) {
            diagnosticsTotal[k] += ((Number(attempt.errorPatterns[k]) || 0) / 100) * wrong;
          }
        }
      }
    }

    // ── O'quvchi hisobotlari ──
    const pending = part.filter((student) => !done.has(student.id));
    const built = await mapPool(pending, AI_CONCURRENCY, (student) =>
      buildReport({ run, window, student, data, refs, bench }),
    );

    if (built.length) {
      // ⚠️ `skipDuplicates` — ikkinchi jarayon (yoki tiklanish) o'sha
      // o'quvchini allaqachon yozgan bo'lsa, xato emas: yozilgani qoladi.
      await prisma.gradeAnalysisReport.createMany({ data: built.map((item) => item.row), skipDuplicates: true });
    }

    processed += pending.length;
    aiCount += built.filter((item) => item.usedAi).length;
    await prisma.gradeAnalysisRun.update({
      where: { id: run.id },
      data: { processed, aiCount: { increment: built.filter((item) => item.usedAi).length }, heartbeatAt: new Date() },
    });
  }

  // ── Yig'ma — BAZADAGI hisobotlardan (tiklangan tahlilda ham to'liq) ──
  const reports = await prisma.gradeAnalysisReport.findMany({
    where: { runId: run.id },
    select: {
      id: true,
      studentId: true,
      studentSnapshot: true,
      classId: true,
      level: true,
      riskScore: true,
      average: true,
      previousAverage: true,
      gradeCount: true,
      findings: true,
    },
  });

  const overview = buildOverview({
    current,
    previous: previousAcc,
    students: reports.map((report) => ({
      studentId: report.studentId,
      reportId: report.id,
      name: fullName(report.studentSnapshot),
      className: report.studentSnapshot?.className ?? null,
      classId: report.classId,
      level: report.level,
      riskScore: report.riskScore,
      average: report.average,
      previousAverage: report.previousAverage,
      gradeCount: report.gradeCount,
      findings: Array.isArray(report.findings) ? report.findings : [],
      topFinding: topFindingOf(report.findings),
    })),
    subjectNames: refs.subjectNames,
    classNames: refs.classNames,
    topics: refs.topics,
    attendance: attendanceTotal,
    diagnostics: diagnosticsTotal,
  });

  const labels = await describeScope(run);
  const periodLabel = `${window.title.toLowerCase()} davr`;
  const context = { scopeLabel: labels.scopeLabel, periodLabel, rangeLabel: window.rangeLabel };

  let narrative = { ...buildOverviewNarrative(overview, context), source: "rules", model: "" };

  // ⚠️ BITTA O'QUVCHI TAHLILIDA yig'ma AI CHAQIRILMAYDI: qamrov yorlig'i —
  // o'quvchining ISMI, u modelga ketmasligi kerak (`gradeAnalysisAi`
  // doktrinasi). Ustiga bitta o'quvchi uchun "rahbariyat xulosasi"
  // ma'nosiz ("1 nafar o'quvchi zaif") — mazmun hisobotning o'zida.
  if (run.useAi && run.scope !== SCOPES.STUDENT && overview.students.analyzed > 0) {
    const written = await ai.writeOverviewNarrative(overview, context);
    if (written) narrative = { ...written, source: "ai" };
  }

  const finished = await transition(run.id, STATUS.RUNNING, {
    status: STATUS.COMPLETED,
    overview,
    narrative,
    processed: students.length,
    finishedAt: new Date(),
    heartbeatAt: new Date(),
  });
  if (!finished) return;

  logger.info(
    `[GradeAnalysis] ${run.id}: tayyor — ${students.length} o'quvchi, AI ${aiCount} ta, ` +
      `${Math.round((Date.now() - startedAt) / 1000)}s`,
  );

  if (run.notify) {
    await publishRun(run.id, { actorId: run.createdBy || "" }).catch((error) =>
      logger.error(`[GradeAnalysis] ${run.id}: nashrda xato — ${error.message}`),
    );
  }
}

/** HTTP javobini kutdirmasdan fonda boshlaydi (kontekst `setImmediate` bilan o'tadi). */
function processInBackground(runId) {
  setImmediate(() => {
    processRun(runId).catch((error) => logger.error(`[GradeAnalysis] Kutilmagan xato: ${error.message}`));
  });
}

/* ─────────────────────────── ISHGA TUSHIRISH ─────────────────────────── */

/**
 * Yangi tahlil.
 * @param {object} input - { period, scope, classIds?, studentId?, useAi?, notify? }
 * @param {{actorId?: string, trigger?: string, toDate?: string}} [options]
 */
async function createRun(input = {}, { actorId = "", trigger = TRIGGERS.MANUAL, toDate } = {}) {
  const period = String(input.period || "");
  if (!PERIOD_KEYS.includes(period)) {
    throw new BadRequestError(`Davr noto'g'ri. Mumkin: ${PERIOD_KEYS.join(", ")}`);
  }

  const scope = String(input.scope || "");
  if (!SCOPE_KEYS.includes(scope)) throw new BadRequestError("Qamrov noto'g'ri: maktab, sinflar yoki o'quvchi");

  let classIds = [];
  let studentId = null;

  if (scope === SCOPES.CLASSES) {
    classIds = [...new Set((Array.isArray(input.classIds) ? input.classIds : []).map(String))];
    if (classIds.length === 0) throw new BadRequestError("Kamida bitta sinf tanlang");
    const found = await prisma.class.count({ where: { id: { in: classIds } } });
    if (found !== classIds.length) throw new BadRequestError("Tanlangan sinflardan biri topilmadi");
  }

  if (scope === SCOPES.STUDENT) {
    studentId = String(input.studentId || "");
    const student = await prisma.user.findFirst({
      where: { id: studentId, role: ROLES.STUDENT },
      select: { id: true, isArchived: true },
    });
    if (!student) throw new BadRequestError("O'quvchi topilmadi");
    if (student.isArchived) throw new BadRequestError("Arxivlangan o'quvchi tahlil qilinmaydi");
  }

  const settings = await getGradeAnalysisSettings();
  const window = periodWindow(period, toDate);

  const active = await prisma.gradeAnalysisRun.findFirst({
    where: { status: { in: ACTIVE_STATUSES } },
    select: { id: true },
  });
  if (active) {
    throw new ConflictError("Boshqa tahlil ishlanmoqda — u tugagach qayta urinib ko'ring", {
      reason: "run_active",
      runId: active.id,
    });
  }

  const run = await prisma.gradeAnalysisRun.create({
    data: {
      period,
      fromDate: dayToDate(window.from),
      toDate: dayToDate(window.to),
      scope,
      classIds,
      studentId,
      trigger,
      // AI — sozlamada o'chirilgan bo'lsa so'rov uni yoqa olmaydi
      useAi: settings.useAi && input.useAi !== false,
      notify: input.notify !== false,
      createdBy: actorId || "",
    },
  });

  processInBackground(run.id);
  return formatRun(run);
}

/**
 * HAFTALIK AVTOMAT TAHLIL (dushanba cron'i): o'tgan hafta, butun maktab.
 * Takror yozilmaydi: shu hafta uchun haftalik tahlil bo'lsa — o'tkaziladi.
 * @returns {Promise<{skipped?: string, runId?: string}>}
 */
async function runWeekly() {
  const settings = await getGradeAnalysisSettings();
  if (!settings.weeklyEnabled) return { skipped: "disabled" };

  const toDate = toIsoDay(getTashkentDateUtc(-1));
  const exists = await prisma.gradeAnalysisRun.findFirst({
    where: {
      trigger: TRIGGERS.WEEKLY,
      toDate: dayToDate(toDate),
      status: { in: [...ACTIVE_STATUSES, STATUS.COMPLETED] },
    },
    select: { id: true },
  });
  if (exists) return { skipped: "exists", runId: exists.id };

  const active = await prisma.gradeAnalysisRun.findFirst({ where: { status: { in: ACTIVE_STATUSES } }, select: { id: true } });
  if (active) return { skipped: "busy", runId: active.id };

  const run = await createRun(
    { period: "week", scope: SCOPES.SCHOOL, useAi: settings.useAi, notify: settings.weeklyNotify },
    { trigger: TRIGGERS.WEEKLY, toDate },
  );
  return { runId: run.id };
}

/**
 * To'xtab qolgan tahlillarni tiklaydi va navbatdagilarni ishlaydi (cron).
 * @returns {Promise<{requeued: number, started: number}>}
 */
async function recoverStaleRuns() {
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
  const stale = await prisma.gradeAnalysisRun.findMany({
    where: { status: STATUS.RUNNING, OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }] },
    select: { id: true, heartbeatAt: true },
  });

  let requeued = 0;
  for (const run of stale) {
    if (inFlight.has(isInFlightKey(run.id))) continue;
    // CAS: shu orada boshqa jarayon yurak urishini yangilagan bo'lsa tegilmaydi
    const { count } = await prisma.gradeAnalysisRun.updateMany({
      where: { id: run.id, status: STATUS.RUNNING, heartbeatAt: run.heartbeatAt },
      data: { status: STATUS.QUEUED },
    });
    requeued += count;
  }

  const queued = await prisma.gradeAnalysisRun.findFirst({
    where: { status: STATUS.QUEUED },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true },
  });

  let started = 0;
  // Yangi yaratilgani fonda allaqachon boshlanayotgan bo'lishi mumkin
  if (queued && !inFlight.has(isInFlightKey(queued.id)) && Date.now() - queued.createdAt.getTime() > 60 * 1000) {
    await processRun(queued.id);
    started = 1;
  }

  return { requeued, started };
}

/* ─────────────────────────── BOSHQARUV ─────────────────────────── */

async function getRunOrThrow(id) {
  const run = await prisma.gradeAnalysisRun.findUnique({ where: { id } });
  if (!run) throw new NotFoundError("Tahlil topilmadi");
  return run;
}

async function cancelRun(id) {
  await getRunOrThrow(id);
  const ok = await transition(id, ACTIVE_STATUSES, { status: STATUS.CANCELLED, finishedAt: new Date() });
  if (!ok) throw new ConflictError("Faqat navbatdagi yoki ishlanayotgan tahlilni to'xtatish mumkin");
  return getRun(id);
}

/**
 * Hisobotlarni o'quvchi va ota-onaga OCHADI va push yuboradi.
 * ⚠️ Faqat ma'lumoti yetarli hisobotlar: "baho yetarli emas" degan
 * hisobot o'quvchining avvalgi mazmunli tahlilini "oxirgi" o'rnidan
 * surib chiqarardi.
 */
async function publishRun(id, { actorId = "" } = {}) {
  const run = await getRunOrThrow(id);
  if (run.status !== STATUS.COMPLETED) throw new ConflictError("Faqat tayyor tahlil yuboriladi");

  const now = new Date();
  const targets = await prisma.gradeAnalysisReport.findMany({
    where: { runId: id, isPublished: false, ...PUBLISHABLE },
    select: { studentId: true },
  });

  await prisma.gradeAnalysisReport.updateMany({
    where: { runId: id, isPublished: false, ...PUBLISHABLE },
    data: { isPublished: true, publishedAt: now },
  });

  let sent = 0;
  if (targets.length) {
    const period = GRADE_ANALYSIS_PERIODS[run.period];
    const result = await sendToUsers(
      targets.map((row) => row.studentId),
      buildGradeAnalysisPush({ runId: id, period: run.period, periodTitle: period.title, branchId: getBranch()?.id }),
    );
    sent = result.sent;
  }

  await prisma.gradeAnalysisRun.update({
    where: { id },
    data: { publishedAt: run.publishedAt ?? now, publishedBy: actorId || run.publishedBy, pushSent: { increment: sent } },
  });

  return { ...(await getRun(id)), published: targets.length, pushSent: sent };
}

/** Nashrni qaytarib oladi — hisobotlar mobil ilovadan yo'qoladi (o'chirilmaydi). */
async function unpublishRun(id) {
  await getRunOrThrow(id);
  const { count } = await prisma.gradeAnalysisReport.updateMany({
    where: { runId: id, isPublished: true },
    data: { isPublished: false, publishedAt: null },
  });
  await prisma.gradeAnalysisRun.update({ where: { id }, data: { publishedAt: null } });
  return { ...(await getRun(id)), unpublished: count };
}

/**
 * ⚠️ Nashr qilingan tahlil O'CHIRILMAYDI: ota-ona ko'rgan hisobot
 * izsiz yo'qolmasin. Avval nashrni qaytarib olish kerak.
 */
async function deleteRun(id) {
  const run = await getRunOrThrow(id);
  if (ACTIVE_STATUSES.includes(run.status)) throw new ConflictError("Ishlanayotgan tahlilni avval to'xtating");
  const published = await prisma.gradeAnalysisReport.count({ where: { runId: id, isPublished: true } });
  if (published) {
    throw new ConflictError("Tahlil o'quvchi va ota-onalarga yuborilgan — avval yuborishni bekor qiling");
  }
  await prisma.gradeAnalysisRun.delete({ where: { id } });
  return { id };
}

async function updateSettings(input = {}, actorId) {
  await getGradeAnalysisSettings();
  const data = { updatedBy: actorId };
  for (const key of ["weeklyEnabled", "weeklyNotify", "useAi"]) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean") throw new BadRequestError(`${key} — true yoki false bo'lishi kerak`);
      data[key] = input[key];
    }
  }
  const settings = await prisma.gradeAnalysisSettings.update({ where: { id: "singleton" }, data });
  return formatSettings(settings);
}

/* ─────────────────────────── API SHAKLI ─────────────────────────── */

const formatSettings = (settings) => ({
  weeklyEnabled: settings.weeklyEnabled,
  weeklyNotify: settings.weeklyNotify,
  useAi: settings.useAi,
  aiAvailable: ai.isEnabled(),
  updatedAt: settings.updatedAt,
});

/** Qamrov yorlig'i: "Butun maktab" / "7-A, 8-B" / o'quvchi ismi. */
async function describeScope(run, cache = {}) {
  if (run.scope === SCOPES.SCHOOL) return { scopeLabel: "Butun maktab", classes: [], student: null };

  if (run.scope === SCOPES.CLASSES) {
    const classes = cache.classes
      ? run.classIds.map((id) => cache.classes.get(id)).filter(Boolean)
      : await prisma.class.findMany({ where: { id: { in: run.classIds } }, select: { id: true, name: true } });
    const sorted = [...classes].sort((a, b) => a.name.localeCompare(b.name, "uz", { numeric: true }));
    return {
      scopeLabel: sorted.length ? sorted.map((row) => row.name).join(", ") : "Sinflar",
      classes: sorted,
      student: null,
    };
  }

  const user =
    cache.students?.get(run.studentId) ??
    (await prisma.user.findUnique({
      where: { id: run.studentId },
      select: { id: true, firstName: true, lastName: true, classes: { select: { class: { select: { name: true } } } } },
    }));
  const className = user?.classes?.[0]?.class?.name ?? null;
  return {
    scopeLabel: user ? fullName(user) : "O'quvchi",
    classes: [],
    student: user ? { id: user.id, name: fullName(user), className } : null,
  };
}

function formatRun(run, labels) {
  const period = GRADE_ANALYSIS_PERIODS[run.period];
  const base = {
    id: run.id,
    period: run.period,
    periodLabel: period?.label ?? run.period,
    periodTitle: period?.title ?? run.period,
    fromDate: toIsoDay(run.fromDate),
    toDate: toIsoDay(run.toDate),
    rangeLabel: formatDateRangeUz(run.fromDate, run.toDate, { utc: true }),
    scope: run.scope,
    classIds: run.classIds,
    studentId: run.studentId,
    trigger: run.trigger,
    useAi: run.useAi,
    notify: run.notify,
    status: run.status,
    total: run.total,
    processed: run.processed,
    progress: run.total ? Math.min(100, Math.round((run.processed / run.total) * 100)) : run.status === STATUS.COMPLETED ? 100 : 0,
    aiCount: run.aiCount,
    error: run.error,
    publishedAt: run.publishedAt,
    pushSent: run.pushSent,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
  };
  return labels ? { ...base, ...labels } : base;
}

/** Tahlil + yig'ma + xulosa (dashboard). */
async function getRun(id) {
  const run = await getRunOrThrow(id);
  const [labels, publishedCount, publishable] = await Promise.all([
    describeScope(run),
    prisma.gradeAnalysisReport.count({ where: { runId: id, isPublished: true } }),
    prisma.gradeAnalysisReport.count({ where: { runId: id, ...PUBLISHABLE } }),
  ]);
  return {
    ...formatRun(run, labels),
    overview: run.overview,
    narrative: run.narrative,
    publishedCount,
    publishableCount: publishable,
  };
}

/** Tahlillar tarixi (yig'masiz — ro'yxat yengil qolsin). */
async function listRuns({ page = 1, limit = 12, status, trigger } = {}) {
  const where = {};
  if (status && Object.values(STATUS).includes(status)) where.status = status;
  if (trigger && Object.values(TRIGGERS).includes(trigger)) where.trigger = trigger;

  const take = Math.min(50, Math.max(1, Number(limit) || 12));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;

  const [rows, total] = await Promise.all([
    prisma.gradeAnalysisRun.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      omit: { overview: true, narrative: true },
    }),
    prisma.gradeAnalysisRun.count({ where }),
  ]);

  // Yorliqlar uchun — bitta so'rovda
  const classIds = [...new Set(rows.flatMap((row) => row.classIds))];
  const studentIds = [...new Set(rows.map((row) => row.studentId).filter(Boolean))];
  const [classes, students, summaries] = await Promise.all([
    classIds.length ? prisma.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } }) : [],
    studentIds.length
      ? prisma.user.findMany({
          where: { id: { in: studentIds } },
          select: { id: true, firstName: true, lastName: true, classes: { select: { class: { select: { name: true } } } } },
        })
      : [],
    rows.length
      ? prisma.gradeAnalysisRun.findMany({
          where: { id: { in: rows.map((row) => row.id) } },
          select: { id: true, overview: true },
        })
      : [],
  ]);

  const cache = {
    classes: new Map(classes.map((row) => [row.id, row])),
    students: new Map(students.map((row) => [row.id, row])),
  };
  // Ro'yxat kartasi uchun faqat 4 ta raqam — butun yig'ma emas
  const brief = new Map(
    summaries.map((row) => [
      row.id,
      row.overview
        ? {
            average: row.overview.average,
            delta: row.overview.delta,
            analyzed: row.overview.students?.analyzed ?? 0,
            atRisk: row.overview.atRisk ?? 0,
          }
        : null,
    ]),
  );

  const data = await Promise.all(
    rows.map(async (row) => ({ ...formatRun(row, await describeScope(row, cache)), summary: brief.get(row.id) ?? null })),
  );

  return {
    data,
    pagination: { page: Math.max(1, Number(page) || 1), limit: take, total, totalPages: Math.ceil(total / take) },
  };
}

const REPORT_SORTS = {
  risk: [{ riskScore: "desc" }, { average: "asc" }],
  average: [{ average: { sort: "desc", nulls: "last" } }],
  lowest: [{ average: { sort: "asc", nulls: "last" } }],
};

function reportBrief(report) {
  const snapshot = report.studentSnapshot || {};
  return {
    id: report.id,
    studentId: report.studentId,
    name: fullName(snapshot),
    className: snapshot.className ?? null,
    classId: report.classId,
    level: report.level,
    levelLabel: levelLabel(report.level),
    average: report.average,
    previousAverage: report.previousAverage,
    delta:
      report.average != null && report.previousAverage != null
        ? Math.round((report.average - report.previousAverage) * 100) / 100
        : null,
    gradeCount: report.gradeCount,
    riskScore: report.riskScore,
    topFinding: topFindingOf(report.findings),
    source: report.source,
    isPublished: report.isPublished,
    studentSeen: Boolean(report.studentSeenAt),
    parentSeen: Boolean(report.parentSeenAt),
  };
}

/** Tahlildagi o'quvchilar ro'yxati — filtr, qidiruv, saralash. */
async function listRunReports(runId, { page = 1, limit = 25, level, classId, q, sort = "risk", risk } = {}) {
  await getRunOrThrow(runId);
  const where = { runId };
  if (level && [...LEVELS.map((row) => row.key), INSUFFICIENT_LEVEL.key].includes(level)) where.level = level;
  if (classId) where.classId = String(classId);
  if (risk === "1" || risk === true) where.riskScore = { gte: THRESHOLDS.riskAlert };

  const search = String(q || "").trim();
  if (search) {
    // Ism surati JSON'da — `path` bo'yicha qidiruv (katta-kichik harfsiz)
    where.OR = [
      { studentSnapshot: { path: ["firstName"], string_contains: search, mode: "insensitive" } },
      { studentSnapshot: { path: ["lastName"], string_contains: search, mode: "insensitive" } },
    ];
  }

  const take = Math.min(100, Math.max(1, Number(limit) || 25));
  const currentPage = Math.max(1, Number(page) || 1);

  const [rows, total] = await Promise.all([
    prisma.gradeAnalysisReport.findMany({
      where,
      orderBy: [...(REPORT_SORTS[sort] ?? REPORT_SORTS.risk), { id: "asc" }],
      skip: (currentPage - 1) * take,
      take,
      select: {
        id: true,
        studentId: true,
        studentSnapshot: true,
        classId: true,
        level: true,
        average: true,
        previousAverage: true,
        gradeCount: true,
        riskScore: true,
        findings: true,
        source: true,
        isPublished: true,
        studentSeenAt: true,
        parentSeenAt: true,
      },
    }),
    prisma.gradeAnalysisReport.count({ where }),
  ]);

  return {
    data: rows.map(reportBrief),
    pagination: { page: currentPage, limit: take, total, totalPages: Math.ceil(total / take) },
  };
}

function formatReport(report, { audience } = {}) {
  const base = {
    ...reportBrief(report),
    runId: report.runId,
    period: report.period,
    periodLabel: GRADE_ANALYSIS_PERIODS[report.period]?.label ?? report.period,
    periodTitle: GRADE_ANALYSIS_PERIODS[report.period]?.title ?? report.period,
    fromDate: toIsoDay(report.fromDate),
    toDate: toIsoDay(report.toDate),
    rangeLabel: formatDateRangeUz(report.fromDate, report.toDate, { utc: true }),
    facts: report.facts,
    findings: report.findings,
    model: report.model,
    publishedAt: report.publishedAt,
    createdAt: report.createdAt,
  };

  if (!audience) {
    return { ...base, studentView: report.studentView, parentView: report.parentView, staffView: report.staffView };
  }

  // ⚠️ MOBIL — ALOHIDA SHAKL. Chiqmaydi: xodim matni (`staffView`), boshqa
  // auditoriya matni, xavf balli va ichki belgilar (manba, model, kim
  // ko'rgani). Xavf balli — xodim uchun navbat tartibi, ota-onaga "70
  // ball xavf" yorlig'i tushuntirishsiz tashxis bo'lib o'qilardi.
  return {
    id: base.id,
    period: base.period,
    periodLabel: base.periodLabel,
    periodTitle: base.periodTitle,
    fromDate: base.fromDate,
    toDate: base.toDate,
    rangeLabel: base.rangeLabel,
    className: base.className,
    level: base.level,
    levelLabel: base.levelLabel,
    average: base.average,
    previousAverage: base.previousAverage,
    delta: base.delta,
    gradeCount: base.gradeCount,
    facts: report.facts,
    findings: (Array.isArray(report.findings) ? report.findings : []).map(({ code, tone, subject, topic, metrics }) => ({
      code,
      tone,
      subject: subject ?? null,
      topic: topic ?? null,
      metrics,
    })),
    publishedAt: report.publishedAt,
    audience,
    view: audience === AUDIENCES.PARENT ? report.parentView : report.studentView,
  };
}

async function getReport(id) {
  const report = await prisma.gradeAnalysisReport.findUnique({ where: { id } });
  if (!report) throw new NotFoundError("Hisobot topilmadi");
  return formatReport(report);
}

/** Bitta o'quvchining barcha tahlillari (dinamika grafigi uchun). */
async function getStudentHistory(studentId, { limit = 24 } = {}) {
  const rows = await prisma.gradeAnalysisReport.findMany({
    where: { studentId, run: { status: STATUS.COMPLETED } },
    orderBy: { toDate: "desc" },
    take: Math.min(60, Math.max(1, Number(limit) || 24)),
    select: {
      id: true,
      runId: true,
      period: true,
      fromDate: true,
      toDate: true,
      level: true,
      average: true,
      previousAverage: true,
      gradeCount: true,
      riskScore: true,
      isPublished: true,
      createdAt: true,
    },
  });
  return rows.map((row) => ({
    ...row,
    levelLabel: levelLabel(row.level),
    periodLabel: GRADE_ANALYSIS_PERIODS[row.period]?.label ?? row.period,
    fromDate: toIsoDay(row.fromDate),
    toDate: toIsoDay(row.toDate),
    rangeLabel: formatDateRangeUz(row.fromDate, row.toDate, { utc: true }),
  }));
}

/** Tahlil oynasi uchun: davrlar, sinflar, sozlamalar, faol tahlil. */
async function getOptions() {
  const [settings, classes, counts, active] = await Promise.all([
    getGradeAnalysisSettings(),
    prisma.class.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    prisma.userClass.groupBy({
      by: ["classId"],
      where: { user: { role: ROLES.STUDENT, isArchived: false } },
      _count: { _all: true },
    }),
    prisma.gradeAnalysisRun.findFirst({
      where: { status: { in: ACTIVE_STATUSES } },
      orderBy: { createdAt: "desc" },
      omit: { overview: true, narrative: true },
    }),
  ]);

  const countBy = new Map(counts.map((row) => [row.classId, row._count._all]));
  const totalStudents = await prisma.user.count({ where: { role: ROLES.STUDENT, isArchived: false } });

  return {
    periods: PERIOD_KEYS.map((key) => {
      const window = periodWindow(key);
      return { key, label: GRADE_ANALYSIS_PERIODS[key].label, title: GRADE_ANALYSIS_PERIODS[key].title, days: window.days, rangeLabel: window.rangeLabel };
    }),
    scopes: [
      { key: SCOPES.SCHOOL, label: "Butun maktab" },
      { key: SCOPES.CLASSES, label: "Sinflar" },
      { key: SCOPES.STUDENT, label: "Bitta o'quvchi" },
    ],
    classes: classes
      .map((row) => ({ id: row.id, name: row.name, students: countBy.get(row.id) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, "uz", { numeric: true })),
    totalStudents,
    levels: [...LEVELS.map(({ key, label, min }) => ({ key, label, min })), { key: INSUFFICIENT_LEVEL.key, label: INSUFFICIENT_LEVEL.label }],
    causeLabels: CAUSE_LABELS,
    thresholds: { riskAlert: THRESHOLDS.riskAlert },
    settings: formatSettings(settings),
    activeRun: active ? formatRun(active, await describeScope(active)) : null,
  };
}

/** Bitta o'quvchini tanlash uchun qidiruv (ism, familiya, login). */
async function searchStudents({ q, classId } = {}) {
  const search = String(q || "").trim();
  const where = { role: ROLES.STUDENT, isArchived: false };
  if (classId) where.classes = { some: { classId: String(classId) } };

  if (search) {
    const words = search.split(/\s+/).filter(Boolean).slice(0, 3);
    where.AND = words.map((word) => ({
      OR: [
        { firstName: { contains: word, mode: "insensitive" } },
        { lastName: { contains: word, mode: "insensitive" } },
        { username: { contains: word, mode: "insensitive" } },
      ],
    }));
  } else if (!classId) {
    return [];
  }

  const users = await prisma.user.findMany({
    where,
    take: SEARCH_LIMIT,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      username: true,
      classes: { select: { class: { select: { id: true, name: true } } } },
    },
  });

  return users.map((user) => ({
    id: user.id,
    name: fullName(user),
    username: user.username,
    className: user.classes.map((row) => row.class?.name).filter(Boolean).sort().join(", ") || null,
  }));
}

/* ─────────────────────────── MOBIL (o'quvchi / ota-ona) ─────────────────────────── */

/**
 * Auditoriya — mobil ilova qaysi rejimda kirganini o'zi aytadi.
 * ⚠️ Ota-ona ham FARZANDINING loginidan kiradi: server ularni ajrata
 * olmaydi, faqat qaysi matnni qaytarishni `audience` hal qiladi.
 */
function resolveAudience(value) {
  if (value == null || value === "") return AUDIENCES.STUDENT;
  if (!Object.values(AUDIENCES).includes(value)) throw new BadRequestError("audience: student yoki parent");
  return value;
}

function assertStudent(user) {
  if (user?.role !== ROLES.STUDENT) throw new ForbiddenError("Bu bo'lim faqat o'quvchi va ota-ona uchun");
}

/** Faqat NASHR QILINGAN va tahlili tugagan hisobotlar. */
const myWhere = (studentId) => ({ studentId, isPublished: true, run: { status: STATUS.COMPLETED } });

async function listMyReports(user, { audience, page = 1, limit = 10 } = {}) {
  assertStudent(user);
  const who = resolveAudience(audience);
  const take = Math.min(30, Math.max(1, Number(limit) || 10));
  const currentPage = Math.max(1, Number(page) || 1);
  const seenField = who === AUDIENCES.PARENT ? "parentSeenAt" : "studentSeenAt";

  const [rows, total, unseen] = await Promise.all([
    prisma.gradeAnalysisReport.findMany({
      where: myWhere(user.id),
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      skip: (currentPage - 1) * take,
      take,
      select: {
        id: true,
        period: true,
        fromDate: true,
        toDate: true,
        level: true,
        average: true,
        previousAverage: true,
        gradeCount: true,
        publishedAt: true,
        studentSeenAt: true,
        parentSeenAt: true,
        studentView: who === AUDIENCES.STUDENT,
        parentView: who === AUDIENCES.PARENT,
      },
    }),
    prisma.gradeAnalysisReport.count({ where: myWhere(user.id) }),
    prisma.gradeAnalysisReport.count({ where: { ...myWhere(user.id), [seenField]: null } }),
  ]);

  return {
    data: rows.map((row) => {
      const view = who === AUDIENCES.PARENT ? row.parentView : row.studentView;
      return {
        id: row.id,
        period: row.period,
        periodLabel: GRADE_ANALYSIS_PERIODS[row.period]?.label ?? row.period,
        periodTitle: GRADE_ANALYSIS_PERIODS[row.period]?.title ?? row.period,
        fromDate: toIsoDay(row.fromDate),
        toDate: toIsoDay(row.toDate),
        rangeLabel: formatDateRangeUz(row.fromDate, row.toDate, { utc: true }),
        level: row.level,
        levelLabel: levelLabel(row.level),
        average: row.average,
        previousAverage: row.previousAverage,
        delta:
          row.average != null && row.previousAverage != null
            ? Math.round((row.average - row.previousAverage) * 100) / 100
            : null,
        gradeCount: row.gradeCount,
        headline: view?.headline ?? null,
        publishedAt: row.publishedAt,
        isNew: !row[seenField],
      };
    }),
    unseen,
    pagination: { page: currentPage, limit: take, total, totalPages: Math.ceil(total / take) },
  };
}

/**
 * Bitta hisobot (mobil). Ochilganda o'sha auditoriya uchun "ko'rildi".
 * ⚠️ Boshqa o'quvchining hisoboti — 404 (mavjudligi ham oshkor qilinmaydi).
 */
async function getMyReport(user, id, { audience } = {}) {
  assertStudent(user);
  const who = resolveAudience(audience);

  const report = await prisma.gradeAnalysisReport.findFirst({ where: { id, ...myWhere(user.id) } });
  if (!report) throw new NotFoundError("Hisobot topilmadi");

  const seenField = who === AUDIENCES.PARENT ? "parentSeenAt" : "studentSeenAt";
  if (!report[seenField]) {
    await prisma.gradeAnalysisReport.updateMany({ where: { id, [seenField]: null }, data: { [seenField]: new Date() } });
  }

  return formatReport(report, { audience: who });
}

async function getMyLatestReport(user, { audience } = {}) {
  assertStudent(user);
  const latest = await prisma.gradeAnalysisReport.findFirst({
    where: myWhere(user.id),
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (!latest) return null;
  return getMyReport(user, latest.id, { audience });
}

module.exports = {
  SCOPES,
  STATUS,
  TRIGGERS,
  AUDIENCES,
  FINDING_CODES,
  TONES,
  // Admin
  getOptions,
  searchStudents,
  createRun,
  listRuns,
  getRun,
  listRunReports,
  getReport,
  getStudentHistory,
  cancelRun,
  publishRun,
  unpublishRun,
  deleteRun,
  getSettings: async () => formatSettings(await getGradeAnalysisSettings()),
  updateSettings,
  // Fon / cron
  processRun,
  runWeekly,
  recoverStaleRuns,
  // Mobil
  listMyReports,
  getMyReport,
  getMyLatestReport,
  // Sinov uchun
  periodWindow,
};
