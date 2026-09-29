/**
 * KUNNI YOPISH — "MEN KETDIM" DARVOZASI.
 *
 * O'qituvchi "Men ketdim" ni faqat bugungi ishi TUGAGACH bosadi:
 *   1. BAHO — bugungi har bir darsiga (o'rinbosarlik hisobga olingan holda)
 *      KAMIDA BITTA baho qo'yilgan;
 *   2. TOPSHIRIQ — muddati bugun yoki undan oldin bo'lgan topshiriqlari
 *      topshirilgan (tekshiruvga yuborilgan yoki yakunlangan).
 *
 * Tugamagan bo'lsa ikki yo'l bor: ishni tugatish yoki RAHBARIYATDAN RUXSAT
 * so'rash (`CheckoutRequest`). Kutilmagan holat — kasallik, oilaviy sabab,
 * hali boshlanmagan dars — "ishni tugatmay ketish" ning o'zi, shuning uchun
 * u qoidani yumshatish bilan emas, RASMIY QAROR bilan hal qilinadi: kim,
 * qachon, nima sababdan ruxsat bergani iz bo'lib qoladi.
 *
 * ⚠️ NIMA UCHUN QAT'IY TO'SIQ, OGOHLANTIRISH EMAS: "Men ketdim" dan keyin
 * bugungi darsga baho qo'yib bo'lmaydi (`gradingPresence.service.js` —
 * "Siz maktabda emassiz"). Ogohlantirish bosib o'tilsa, baho abadiy
 * qo'yilmay qolardi: dars o'tilmagan hisoblanib oylikdan chiqardi
 * (`finance.md` §10) va kechqurun jarima tushardi.
 *
 * ⚠️ BAHO TALABI — KAMIDA BITTA BAHO (biznes qarori, 2026-09-29): oylikdagi
 * "dars o'tildimi" qoidasi bilan AYNI (`helpers/lessonHours.js` →
 * `judgeLesson`, `finance.md` §10) — ketishga ruxsat bergan dars oylikda ham
 * o'tilgan hisoblanadi. Kechki jarimaning foiz chegarasi
 * (`GradePenaltySettings.missingThresholdPercent`) bu yerda ISHLATILMAYDI —
 * u alohida intizom qoidasi. Jarimadan ozod o'qituvchi darvozadan ham ozod.
 *
 * ⚠️ BOSHLANMAGAN DARS BAHOSI BO'LSA HAM TO'SADI: undan oldin ketish — darsni
 * tashlab ketish. (Vaqt tekshiruvi yoqilgan bo'lsa unga baho qo'yib ham
 * bo'lmaydi — `date.helpers.js` → `checkGradingTimeWindow`.)
 *
 * ⚠️ KIMGA: `teacher` roli (asosiy yoki qo'shimcha) bor xodimga — baho faqat
 * o'qituvchining ishi, topshiriq qismi ham shu doirada (biznes talabi
 * "o'qituvchilar"). Owner'da davomat yo'q. Admin qo'lda belgilagan ketish
 * (`markStaff`, `updateTimes`) darvozadan o'tmaydi — u rahbariyat qarorining
 * o'zi.
 *
 * ⚠️ TASDIQLANGAN SO'ROV FAQAT O'SHA KUNI amal qiladi va ERTA KETISH
 * JARIMASINI ham olib tashlaydi (rahbar ruxsat bergan ketish — intizom
 * buzilishi emas). Baho jarimasi va oylikka ta'siri esa O'ZGARMAYDI: baho
 * qo'yilmagan dars baribir o'tilmagan — ruxsat ketishga, bahosiz darsga emas.
 */

const prisma = require("../config/prisma");
const config = require("../config/env.config");
const { getBranch } = require("../config/branchContext");
const { ROLES } = require("../utils/constants");
const { hasRole, PERMISSIONS } = require("../utils/permissions");
const {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} = require("../utils/errors");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const logger = require("../utils/logger");
const { currentDayDate, monthKeyOfDate, parseDayDate } = require("../helpers/month.helpers");
const { formatDateUz, formatDateTimeUz, formatTimeUz } = require("../helpers/date.helpers");
const { dayKey } = require("../helpers/lessonHours");
const {
  scheduleDayOf,
  getSubstitutionCells,
  effectiveTeacherOf,
} = require("../helpers/teacherAccess");
const { escapeHtml } = require("../helpers/changelogMessage.helpers");
const { buildHolidaySet } = require("./holiday.service");
const { getVacationSet } = require("./vacationMonth.service");
const {
  getAttendanceSettings,
  getGradePenaltySettings,
  getScheduleSettings,
  getTaskSettings,
} = require("./settings.service");
const { tashkentMinutesOf } = require("./lessonAbsence.service");
const { WORKING_STATUSES } = require("./task.service");
const telegramService = require("./telegram.service");

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const REASON_MIN = 5;
const REASON_MAX = 1000;
const NOTE_MAX = 1000;

/** Bir kunda bittadan ortiq bo'lmaydigan holatlar. */
const ACTIVE_REQUEST_STATUSES = ["pending", "approved"];

const REQUEST_STATUS_LABELS = {
  pending: "Kutilmoqda",
  approved: "Tasdiqlangan",
  rejected: "Rad etilgan",
  cancelled: "Bekor qilingan",
};

const LESSON_STATE_LABELS = {
  done: "Baho qo'yilgan",
  pending: "Baho qo'yilmagan",
  notStarted: "Hali boshlanmagan",
};

const fullName = (u) =>
  u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || "Noma'lum" : null;

const minutesOfTime = (value) => {
  if (!TIME_RE.test(String(value ?? ""))) return null;
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
};

/** Darvoza shu odamga tegishlimi (sozlamadan tashqari). */
const isGatedUser = (user) =>
  Boolean(user) && user.role !== ROLES.OWNER && hasRole(user, ROLES.TEACHER);

// ─────────────────────────────────────────────
// BUGUNGI DARSLAR
// ─────────────────────────────────────────────

/**
 * O'qituvchining berilgan kundagi darslari — AMALDAGI o'qituvchi bo'yicha
 * (o'rinbosar bo'lsa u, darsini bergan egasi emas) va har biriga baho holati.
 *
 * @param {string} userId
 * @param {Date} day - Toshkent kuni, UTC yarim tuni
 * @param {object} opts
 * @param {number|null} opts.nowMin - bugun uchun Toshkent daqiqasi
 * @returns {Promise<{closed: string|null, lessons: Array}>}
 */
async function loadTeacherLessons(userId, day, { nowMin }) {
  const dayName = scheduleDayOf(day);
  if (!dayName) return { closed: "sunday", lessons: [] };

  const [holidaySet, vacationSet] = await Promise.all([
    buildHolidaySet(day, day),
    getVacationSet(),
  ]);
  if (holidaySet.has(dayKey(day))) return { closed: "holiday", lessons: [] };
  if (vacationSet.has(monthKeyOfDate(day))) return { closed: "vacation", lessons: [] };

  const cells = await getSubstitutionCells(day);

  // O'rinbosar sifatida kiradigan sinflar — o'z darsi bo'lmagan joyda ham.
  // Katak kaliti `classId|day|order` (`teacherAccess.cellKey`).
  const extraClassIds = [
    ...new Set(
      [...cells]
        .filter(([, cell]) => cell.substituteTeacherId === userId)
        .map(([key]) => key.split("|")[0]),
    ),
  ];

  const [schedules, settings] = await Promise.all([
    prisma.schedule.findMany({
      where: {
        day: dayName,
        OR: [
          { lessons: { some: { teacherId: userId } } },
          ...(extraClassIds.length ? [{ classId: { in: extraClassIds } }] : []),
        ],
      },
      include: { lessons: true },
    }),
    getScheduleSettings(),
  ]);

  const periods = new Map(
    (Array.isArray(settings.periods) ? settings.periods : []).map((p) => [Number(p.order), p]),
  );

  // Amaldagi o'qituvchisi SHU odam bo'lgan darslar
  const mine = [];
  for (const schedule of schedules) {
    for (const lesson of schedule.lessons) {
      if (!lesson.teacherId) continue;
      const effective = effectiveTeacherOf(
        { classId: schedule.classId, day: dayName, order: lesson.order, teacherId: lesson.teacherId },
        cells,
      );
      if (effective.teacherId !== userId) continue;

      const period = periods.get(lesson.order);
      const startTime = TIME_RE.test(lesson.startTime ?? "") ? lesson.startTime : period?.startTime ?? null;
      const endTime = TIME_RE.test(lesson.endTime ?? "") ? lesson.endTime : period?.endTime ?? null;

      mine.push({
        classId: schedule.classId,
        subjectId: lesson.subjectId,
        lessonOrder: lesson.order,
        startTime,
        endTime,
        substituted: effective.substituted,
      });
    }
  }

  if (mine.length === 0) return { closed: null, lessons: [] };

  const classIds = [...new Set(mine.map((l) => l.classId))];
  const subjectIds = [...new Set(mine.map((l) => l.subjectId))];

  // ⚠️ Kun oralig'i TOSHKENT kuni bo'yicha (`Grade.date` — instant):
  // host taymzonasiga bog'liq `setHours` ishlatilmaydi.
  const from = new Date(day.getTime() - 5 * HOUR_MS);
  const to = new Date(from.getTime() + DAY_MS);

  const [classes, subjects, members, grades] = await Promise.all([
    prisma.class.findMany({
      where: { id: { in: classIds } },
      select: { id: true, name: true, isActive: true },
    }),
    prisma.subject.findMany({
      where: { id: { in: subjectIds } },
      select: { id: true, name: true },
    }),
    // Kechki jarima bilan AYNI o'quvchilar to'plami (`gradePenalty.job.js`)
    prisma.userClass.findMany({
      where: { classId: { in: classIds }, user: { role: ROLES.STUDENT, isActive: true } },
      select: { classId: true, userId: true },
    }),
    prisma.grade.findMany({
      where: { classId: { in: classIds }, date: { gte: from, lt: to } },
      select: { classId: true, subjectId: true, lessonOrder: true, studentId: true },
    }),
  ]);

  const classMap = new Map(classes.map((c) => [c.id, c]));
  const subjectMap = new Map(subjects.map((s) => [s.id, s.name]));

  const studentsByClass = new Map();
  for (const m of members) {
    if (!studentsByClass.has(m.classId)) studentsByClass.set(m.classId, new Set());
    studentsByClass.get(m.classId).add(m.userId);
  }

  const gradedByLesson = new Map();
  for (const g of grades) {
    const key = `${g.classId}|${g.subjectId}|${g.lessonOrder}`;
    if (!gradedByLesson.has(key)) gradedByLesson.set(key, new Set());
    gradedByLesson.get(key).add(g.studentId);
  }

  const lessons = [];
  for (const lesson of mine) {
    const klass = classMap.get(lesson.classId);
    // Faol bo'lmagan sinf — jarima ham, hisobot ham uni o'tkazib yuboradi
    if (!klass?.isActive) continue;

    const students = studentsByClass.get(lesson.classId) ?? new Set();
    const graded = gradedByLesson.get(`${lesson.classId}|${lesson.subjectId}|${lesson.lessonOrder}`) ?? new Set();
    // Ekranda ko'rsatish uchun — sinfdagi o'quvchilar kesimida
    const gradedStudents = [...graded].filter((id) => students.has(id)).length;

    const startMin = minutesOfTime(lesson.startTime);
    const endMin = minutesOfTime(lesson.endTime);
    const notStarted = nowMin != null && startMin != null && startMin > nowMin;

    // Oylik bilan AYNI: darsga bitta baho bo'lsa — o'tilgan. O'quvchisi yo'q
    // sinfga baho qo'yib bo'lmaydi — u ketishni to'smaydi.
    const hasGrade = graded.size > 0 || students.size === 0;
    const state = notStarted ? "notStarted" : hasGrade ? "done" : "pending";

    lessons.push({
      classId: lesson.classId,
      className: klass.name,
      subjectId: lesson.subjectId,
      subjectName: subjectMap.get(lesson.subjectId) ?? "Noma'lum",
      lessonOrder: lesson.lessonOrder,
      startTime: lesson.startTime,
      endTime: lesson.endTime,
      substituted: lesson.substituted,
      ongoing:
        nowMin != null &&
        startMin != null &&
        startMin <= nowMin &&
        (endMin == null || nowMin < endMin),
      totalStudents: students.size,
      gradedStudents,
      state,
      stateLabel: LESSON_STATE_LABELS[state],
    });
  }

  lessons.sort(
    (a, b) =>
      (a.startTime ?? "99:99").localeCompare(b.startTime ?? "99:99") ||
      a.lessonOrder - b.lessonOrder ||
      a.className.localeCompare(b.className),
  );

  return { closed: null, lessons };
}

/**
 * Muddati bugun yoki undan oldin bo'lgan, hali TOPSHIRILMAGAN topshiriqlar.
 *
 * ⚠️ `pending_review` (tekshiruvga yuborilgan) — o'qituvchi tomonidan
 * TUGAGAN: qaror endi rahbarda. U ketishni to'smaydi.
 * ⚠️ Kech topshirish taqiqlangan bo'lsa (`TaskSettings.allowLateSubmission`),
 * muddati o'tgan topshiriqni o'qituvchi YOPA OLMAYDI — muddatni rahbar
 * uzaytiradi. U ro'yxatda turadi (`locked`), lekin ketishni TO'SMAYDI:
 * aks holda o'qituvchi o'z qo'lida bo'lmagan ish uchun har kuni ruxsat
 * so'rab yurardi.
 */
async function loadOpenTasks(userId, day, now) {
  const dayEnd = new Date(day.getTime() - 5 * HOUR_MS + DAY_MS);

  const [rows, taskSettings] = await Promise.all([
    prisma.task.findMany({
      where: {
        assignee: userId,
        status: { in: WORKING_STATUSES },
        dueDate: { lt: dayEnd },
      },
      orderBy: { dueDate: "asc" },
      select: { id: true, title: true, dueDate: true, status: true },
    }),
    getTaskSettings(),
  ]);

  return rows.map((t) => {
    const overdue = t.dueDate.getTime() < now.getTime();
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      dueDate: t.dueDate,
      dueLabel: formatDateTimeUz(t.dueDate),
      overdue,
      locked: overdue && taskSettings.allowLateSubmission === false,
    };
  });
}

// ─────────────────────────────────────────────
// SO'ROVLAR — ko'rinish
// ─────────────────────────────────────────────

const serializeRequest = (row, { user, reviewer, usedAt } = {}) => ({
  id: row.id,
  userId: row.userId,
  userName: fullName(user),
  username: user?.username ?? null,
  date: dayKey(row.date),
  // ⚠️ `date` — UTC yarim tuni (`dates.md` §4)
  dateLabel: formatDateUz(row.date, { utc: true }),
  reason: row.reason,
  status: row.status,
  statusLabel: REQUEST_STATUS_LABELS[row.status] ?? row.status,
  pendingItems: row.pendingItems ?? {},
  reviewedBy: row.reviewedBy ?? null,
  reviewerName: fullName(reviewer),
  reviewedAt: row.reviewedAt ?? null,
  reviewedAtLabel: row.reviewedAt ? formatDateTimeUz(row.reviewedAt) : null,
  reviewNote: row.reviewNote ?? null,
  createdAt: row.createdAt,
  createdAtLabel: formatDateTimeUz(row.createdAt),
  // Tasdiqlangan ruxsat bilan ketilgan vaqt (bo'lmasa — hali ketmagan)
  usedAt: usedAt ?? null,
  usedAtLabel: usedAt ? formatTimeUz(usedAt) : null,
});

async function attachRequestRefs(rows) {
  if (rows.length === 0) return [];

  const userIds = [...new Set(rows.flatMap((r) => [r.userId, r.reviewedBy]).filter(Boolean))];
  const approvedIds = rows.filter((r) => r.status === "approved").map((r) => r.id);

  const [users, used] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true, username: true },
    }),
    approvedIds.length
      ? prisma.attendance.findMany({
          where: { checkoutRequestId: { in: approvedIds } },
          select: { checkoutRequestId: true, checkOut: true },
        })
      : [],
  ]);

  const userMap = new Map(users.map((u) => [u.id, u]));
  const usedMap = new Map(used.map((a) => [a.checkoutRequestId, a.checkOut]));

  return rows.map((r) =>
    serializeRequest(r, {
      user: userMap.get(r.userId),
      reviewer: r.reviewedBy ? userMap.get(r.reviewedBy) : null,
      usedAt: usedMap.get(r.id) ?? null,
    }),
  );
}

/** Bugungi so'rovlardan ko'rsatiladigani: faol bo'lsa u, aks holda eng oxirgisi. */
async function findTodayRequest(userId, day) {
  const rows = await prisma.checkoutRequest.findMany({
    where: { userId, date: day },
    orderBy: { createdAt: "desc" },
  });
  if (rows.length === 0) return null;
  return rows.find((r) => ACTIVE_REQUEST_STATUSES.includes(r.status)) ?? rows[0];
}

// ─────────────────────────────────────────────
// TAYYORLIK
// ─────────────────────────────────────────────

/**
 * Tugamagan ishlar — odam o'qiydigan qisqa ro'yxat.
 * @returns {string[]}
 */
function buildBlockers(grades, tasks) {
  const blockers = [];

  if (grades.required && !grades.exempt) {
    const notStarted = grades.lessons.filter((l) => l.state === "notStarted").length;
    const pending = grades.lessons.filter((l) => l.state === "pending").length;
    if (pending) blockers.push(`${pending} ta darsga baho qo'yilmagan`);
    if (notStarted) blockers.push(`${notStarted} ta dars hali boshlanmagan`);
  }

  const openTasks = tasks.items.filter((t) => !t.locked).length;
  if (tasks.required && openTasks) {
    blockers.push(`${openTasks} ta topshiriq topshirilmagan`);
  }

  return blockers;
}

/**
 * O'QITUVCHI BUGUN KETA OLADIMI — ishlar ro'yxati bilan.
 *
 * Panel "Men ketdim" oynasida shuni chizadi; `checkOut` ham AYNAN shuni
 * chaqiradi — ekrandagi ro'yxat bilan server qarori bir manbadan.
 *
 * @param {{id: string, role: string, extraRoles?: string[]}} user
 * @returns {Promise<object>}
 */
async function getCheckoutReadiness(user) {
  const day = currentDayDate();
  const now = new Date();

  const base = {
    date: dayKey(day),
    dateLabel: formatDateUz(day, { utc: true }),
    applies: false,
    ready: true,
    canCheckOut: true,
    closed: null,
    grades: { required: false, exempt: false, total: 0, done: 0, lessons: [] },
    tasks: { required: false, items: [] },
    blockers: [],
    request: null,
    attendance: null,
  };

  if (!isGatedUser(user)) return base;

  const settings = await getAttendanceSettings();
  const requireGrades = settings.checkoutRequireGrades !== false;
  const requireTasks = settings.checkoutRequireTasks !== false;
  if (!requireGrades && !requireTasks) return base;

  // Jarima sozlamasidan faqat OZOD ro'yxati o'qiladi (foiz chegarasi emas)
  const [penaltySettings, record, request] = await Promise.all([
    requireGrades ? getGradePenaltySettings() : null,
    prisma.attendance.findUnique({
      where: { userId_date: { userId: user.id, date: day } },
      select: { status: true, checkIn: true, checkOut: true },
    }),
    findTodayRequest(user.id, day),
  ]);

  const [lessonsResult, taskItems] = await Promise.all([
    requireGrades
      ? loadTeacherLessons(user.id, day, { nowMin: tashkentMinutesOf(now) })
      : { closed: null, lessons: [] },
    requireTasks ? loadOpenTasks(user.id, day, now) : [],
  ]);

  const exempt = Boolean(
    requireGrades && (penaltySettings.exemptTeachers || []).map(String).includes(String(user.id)),
  );

  const grades = {
    required: requireGrades,
    exempt,
    total: lessonsResult.lessons.length,
    done: lessonsResult.lessons.filter((l) => l.state === "done").length,
    lessons: lessonsResult.lessons,
  };
  const tasks = { required: requireTasks, items: taskItems };

  const blockers = buildBlockers(grades, tasks);
  const ready = blockers.length === 0;

  const [serializedRequest] = request ? await attachRequestRefs([request]) : [null];

  return {
    ...base,
    applies: true,
    ready,
    canCheckOut: ready || request?.status === "approved",
    closed: lessonsResult.closed,
    grades,
    tasks,
    blockers,
    request: serializedRequest,
    attendance: record
      ? {
          status: record.status,
          checkedIn: Boolean(record.checkIn) || ["present", "late"].includes(record.status),
          checkedOut: Boolean(record.checkOut),
        }
      : null,
  };
}

/**
 * Davomat qatoriga yoziladigan qisqa hisobot — faqat nima TUGAMAGANI to'liq.
 */
function sealReport(readiness, approvedRequestId) {
  const pendingLessons = readiness.grades.lessons.filter((l) => l.state !== "done");
  return {
    closedAt: new Date().toISOString(),
    ready: readiness.ready,
    approvedRequestId: approvedRequestId ?? null,
    grades: {
      required: readiness.grades.required,
      exempt: readiness.grades.exempt,
      total: readiness.grades.total,
      done: readiness.grades.done,
      pending: pendingLessons.map((l) => ({
        className: l.className,
        subjectName: l.subjectName,
        lessonOrder: l.lessonOrder,
        gradedStudents: l.gradedStudents,
        totalStudents: l.totalStudents,
        state: l.state,
      })),
    },
    tasks: {
      required: readiness.tasks.required,
      pending: readiness.tasks.items.map((t) => ({
        id: t.id,
        title: t.title,
        dueLabel: t.dueLabel,
        locked: t.locked,
      })),
    },
  };
}

/**
 * `checkOut` dan OLDIN chaqiriladi. Keta olmasa — 409 va tuzilma
 * (`details.reason = "checkout_blocked"`, `details.readiness`): panel
 * ro'yxatni xabar matnidan emas, shundan chizadi.
 *
 * @returns {Promise<{report: object|null, requestId: string|null, approved: boolean}>}
 */
async function resolveCheckout(user) {
  const readiness = await getCheckoutReadiness(user);
  if (!readiness.applies) return { report: null, requestId: null, approved: false };

  if (readiness.ready) {
    return { report: sealReport(readiness, null), requestId: null, approved: false };
  }

  if (readiness.request?.status === "approved") {
    return {
      report: sealReport(readiness, readiness.request.id),
      requestId: readiness.request.id,
      approved: true,
    };
  }

  const tail =
    readiness.request?.status === "pending"
      ? "Rahbariyatga yuborgan so'rovingiz hali ko'rib chiqilmagan."
      : "Ishlarni yakunlang yoki rahbariyatdan ruxsat so'rang.";

  throw new ConflictError(
    `Bugungi ishlaringiz tugamagan: ${readiness.blockers.join(", ")}. ${tail}`,
    { reason: "checkout_blocked", readiness },
  );
}

// ─────────────────────────────────────────────
// SO'ROVLAR — yozish
// ─────────────────────────────────────────────

/** So'rov paytidagi tugamagan ishlar — muhrlanadi (`CheckoutRequest.pendingItems`). */
function snapshotPending(readiness) {
  const report = sealReport(readiness, null);
  return {
    blockers: readiness.blockers,
    lessons: report.grades.pending,
    tasks: report.tasks.pending,
  };
}

/** Rahbariyat (owner + `attendance.review`) — so'rovchining o'zidan tashqari. */
async function notifyReviewers(request, requester) {
  const lines = [
    `🕐 <b>Ketishga ruxsat so'rovi — ${escapeHtml(getBranch()?.name || "Filial")}</b>`,
    `${escapeHtml(fullName(requester))} bugungi ishlarini tugatmay ketmoqchi.`,
    `Sabab: ${escapeHtml(request.reason)}`,
  ];
  const blockers = request.pendingItems?.blockers ?? [];
  if (blockers.length) lines.push(`Tugamagan: ${escapeHtml(blockers.join(", "))}`);
  lines.push("Ko'rib chiqish: Admin panel → Davomat → Ketish so'rovlari.");

  await sendTelegram(
    {
      id: { not: request.userId },
      OR: [
        { role: ROLES.OWNER },
        { extraRoles: { has: ROLES.OWNER } },
        { permissions: { has: PERMISSIONS.ATTENDANCE_REVIEW } },
        // Bare bo'lim kaliti bo'limning HAMMA amalini beradi (`permissions.js`)
        { permissions: { has: "attendance" } },
      ],
    },
    lines.join("\n"),
  );
}

async function notifyRequester(request, reviewer) {
  const approved = request.status === "approved";
  const lines = [
    approved
      ? "✅ <b>Ketishga ruxsat berildi</b>"
      : "❌ <b>Ketishga ruxsat berilmadi</b>",
    `${escapeHtml(fullName(reviewer))} so'rovingizni ${approved ? "tasdiqladi" : "rad etdi"}.`,
  ];
  if (request.reviewNote) lines.push(`Izoh: ${escapeHtml(request.reviewNote)}`);
  lines.push(
    approved
      ? "Endi \"Men ketdim\" tugmasini bosishingiz mumkin."
      : "Bugungi ishlaringizni yakunlab, keyin \"Men ketdim\" ni bosing.",
  );

  await sendTelegram({ id: request.userId }, lines.join("\n"));
}

/**
 * Telegram xabari — KUTILMAYDI va xato tashlamaydi: bot ishlamasa ham
 * so'rov yozilgan, panel esa holatni o'zi so'rab turadi.
 */
function sendTelegram(where, text) {
  if (!config.telegramBotToken) return Promise.resolve();

  return (async () => {
    const recipients = await prisma.user.findMany({
      where: { isArchived: false, isActive: true, ...where },
      select: { telegramIds: true },
    });
    const chatIds = [...new Set(recipients.flatMap((u) => u.telegramIds || []).filter(Boolean))];

    for (const chatId of chatIds) {
      try {
        const result = await telegramService.sendMessage(chatId, text);
        if (!result?.success) logger.warn(`[CheckoutGate] ${chatId}: ${result?.error || "yuborilmadi"}`);
      } catch (error) {
        logger.warn(`[CheckoutGate] ${chatId}: ${error.message}`);
      }
      await telegramService.sleep(config.messageRateLimitMs);
    }
  })().catch((error) => logger.error(`[CheckoutGate] Telegram xabari yuborilmadi: ${error.message}`));
}

/**
 * RAHBARIYATGA SO'ROV — ishlar tugamay ketish uchun.
 *
 * Faqat bugun uchun, faqat kelgan va hali ketmagan odam, faqat ishlari
 * haqiqatan tugamagan bo'lsa (aks holda ruxsat keraksiz — shunchaki keta
 * oladi). Bir kunda bitta FAOL so'rov: rad etilgandan keyin yangisi mumkin.
 */
async function createCheckoutRequest(user, { reason } = {}) {
  const text = String(reason ?? "").trim();
  if (text.length < REASON_MIN) {
    throw new BadRequestError(`Sababni yozing (kamida ${REASON_MIN} ta belgi)`);
  }
  if (text.length > REASON_MAX) {
    throw new BadRequestError(`Sabab ${REASON_MAX} belgidan oshmasin`);
  }

  const readiness = await getCheckoutReadiness(user);
  if (!readiness.applies || readiness.ready) {
    throw new BadRequestError("Bugungi ishlaringiz tugagan — ruxsat so'rash shart emas, \"Men ketdim\" ni bosing");
  }
  if (!readiness.attendance?.checkedIn) {
    throw new BadRequestError("Avval kelganingizni qayd eting");
  }
  if (readiness.attendance.checkedOut) {
    throw new BadRequestError("Bugun allaqachon ketganingiz qayd etilgan");
  }

  const day = currentDayDate();

  const created = await prisma.$transaction(async (tx) => {
    // ⚠️ "Bir kunda bitta faol so'rov" — qisman yagona indeks yo'q, shuning
    // uchun tekshiruv va yozuv BIR QULF ostida: parallel ikki bosish ikki
    // so'rov yozmaydi.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`checkout_request:${user.id}:${dayKey(day)}`}))`;

    const active = await tx.checkoutRequest.findFirst({
      where: { userId: user.id, date: day, status: { in: ACTIVE_REQUEST_STATUSES } },
      select: { status: true },
    });
    if (active) {
      throw new BadRequestError(
        `Bugun uchun so'rovingiz allaqachon bor (holati: ${REQUEST_STATUS_LABELS[active.status].toLowerCase()})`,
      );
    }

    return tx.checkoutRequest.create({
      data: {
        userId: user.id,
        date: day,
        reason: text,
        pendingItems: snapshotPending(readiness),
      },
    });
  });

  notifyReviewers(created, user);

  const [serialized] = await attachRequestRefs([created]);
  return serialized;
}

/** O'qituvchi o'zining KUTILAYOTGAN so'rovini bekor qiladi. */
async function cancelCheckoutRequest(user, requestId) {
  const request = await prisma.checkoutRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new NotFoundError("So'rov topilmadi");
  if (request.userId !== user.id) throw new ForbiddenError("Bu so'rov sizga tegishli emas");

  const { count } = await prisma.checkoutRequest.updateMany({
    where: { id: requestId, userId: user.id, status: "pending" },
    data: { status: "cancelled" },
  });
  if (count !== 1) {
    throw new BadRequestError("Faqat kutilayotgan so'rovni bekor qilish mumkin");
  }
}

/**
 * RAHBARIYAT QARORI.
 *
 * ⚠️ O'Z SO'ROVINI O'ZI TASDIQLAB BO'LMAYDI: ko'rib chiqish huquqi bor
 * o'qituvchi (masalan o'rinbosar direktor) darvozani o'zi ochib qo'yardi.
 * ⚠️ Faqat `pending` — CAS bilan: ikki rahbar bir vaqtda bossa, ikkinchisi
 * birinchisining qarorini ustidan yozmaydi.
 */
async function reviewCheckoutRequest(requestId, { status, note } = {}, reviewer) {
  if (!["approved", "rejected"].includes(status)) {
    throw new BadRequestError("Qaror: tasdiqlash yoki rad etish");
  }
  const text = String(note ?? "").trim();
  if (status === "rejected" && text.length < 3) {
    throw new BadRequestError("Rad etish sababini yozing");
  }
  if (text.length > NOTE_MAX) {
    throw new BadRequestError(`Izoh ${NOTE_MAX} belgidan oshmasin`);
  }

  const request = await prisma.checkoutRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new NotFoundError("So'rov topilmadi");
  if (request.userId === reviewer.id) {
    throw new ForbiddenError("O'z so'rovingizni o'zingiz ko'rib chiqa olmaysiz");
  }

  const reviewedAt = new Date();
  const { count } = await prisma.checkoutRequest.updateMany({
    where: { id: requestId, status: "pending" },
    data: { status, reviewedBy: reviewer.id, reviewedAt, reviewNote: text || null },
  });
  if (count !== 1) {
    throw new ConflictError("So'rov allaqachon ko'rib chiqilgan yoki bekor qilingan — ro'yxatni yangilang");
  }

  const updated = { ...request, status, reviewedBy: reviewer.id, reviewedAt, reviewNote: text || null };
  notifyRequester(updated, reviewer);

  const [serialized] = await attachRequestRefs([updated]);
  return serialized;
}

/**
 * Rahbariyat ro'yxati — sahifalangan, kutilayotganlar soni bilan.
 *
 * @param {object} req - `query.status` (`all` | holat), `query.date` ("YYYY-MM-DD")
 */
async function listCheckoutRequests(req) {
  const { page, limit, skip } = getPaginationParams(req);
  const { status, date } = req.query || {};

  const where = {};
  if (status && status !== "all") {
    if (!REQUEST_STATUS_LABELS[status]) throw new BadRequestError("Noma'lum holat");
    where.status = status;
  }
  if (date) where.date = parseDayDate(date, "Sana");

  const [rows, total, pendingCount] = await Promise.all([
    prisma.checkoutRequest.findMany({
      where,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    prisma.checkoutRequest.count({ where }),
    prisma.checkoutRequest.count({ where: { status: "pending", date: currentDayDate() } }),
  ]);

  const data = await attachRequestRefs(rows);
  return { ...formatPaginationResponse(data, total, page, limit), pendingCount };
}

module.exports = {
  REQUEST_STATUS_LABELS,
  getCheckoutReadiness,
  resolveCheckout,
  createCheckoutRequest,
  cancelCheckoutRequest,
  reviewCheckoutRequest,
  listCheckoutRequests,
};
