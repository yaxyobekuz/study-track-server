const asyncHandler = require("../middleware/async.middleware");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const logger = require("../utils/logger");

const prisma = require("../config/prisma");

const { getCurrentDayUz, isSunday } = require("../helpers/date.helpers");
const { getCurrentWeekRange } = require("../helpers/statistics.helpers");
const {
  createWeeklyStatsForStudent,
  calculateStudentRankInClass,
  calculateStudentRankInSchool,
} = require("../services/weeklystats.service");

/**
 * ScheduleLesson child yozuvlaridagi subject/teacher soft ref'larni (relation YO'Q)
 * bitta so'rovdan yuklab, eski `subjects[]` embedded shakliga xaritalaydi.
 * @param {Array} schedules - lessons bilan yuklangan schedule'lar
 * @returns {Promise<{subjectMap: Map, teacherMap: Map}>}
 */
async function loadLessonRefs(schedules) {
  const subjectIds = new Set();
  const teacherIds = new Set();
  for (const schedule of schedules) {
    for (const lesson of schedule.lessons || []) {
      if (lesson.subjectId) subjectIds.add(lesson.subjectId);
      if (lesson.teacherId) teacherIds.add(lesson.teacherId);
    }
  }

  const [subjects, teachers] = await Promise.all([
    prisma.subject.findMany({
      where: { id: { in: [...subjectIds] } },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: { id: { in: [...teacherIds] } },
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);

  const subjectMap = new Map(
    subjects.map((s) => [s.id, { id: s.id, name: s.name }]),
  );
  const teacherMap = new Map(
    teachers.map((t) => [
      t.id,
      { id: t.id, firstName: t.firstName, lastName: t.lastName },
    ]),
  );

  return { subjectMap, teacherMap };
}

// lessons[] → eski subjects[] shakliga xaritalaydi (subject/teacher biriktirilgan)
function mapLessons(lessons, subjectMap, teacherMap) {
  return (lessons || []).map((lesson) => ({
    id: lesson.id,
    subject: subjectMap.get(lesson.subjectId) || null,
    teacher: teacherMap.get(lesson.teacherId) || null,
    order: lesson.order,
    startTime: lesson.startTime,
    endTime: lesson.endTime,
  }));
}

/**
 * WeeklyStats.simpleStats — JSONB (populate ishlamaydi). subjects[].subject
 * ObjectId'larni JSONB ichidan olib, alohida prisma.subject.findMany bilan yuklab biriktiradi.
 */
async function attachSimpleStatsSubjects(simpleStats) {
  if (!simpleStats || !Array.isArray(simpleStats.subjects)) {
    return simpleStats;
  }

  const subjectIds = [
    ...new Set(
      simpleStats.subjects.map((s) => s.subject).filter((v) => typeof v === "string"),
    ),
  ];

  if (subjectIds.length === 0) {
    return simpleStats;
  }

  const subjects = await prisma.subject.findMany({
    where: { id: { in: subjectIds } },
  });
  const subjectMap = new Map(subjects.map((s) => [s.id, { ...s }]));

  return {
    ...simpleStats,
    subjects: simpleStats.subjects.map((s) => ({
      ...s,
      subject:
        typeof s.subject === "string"
          ? subjectMap.get(s.subject) || s.subject
          : s.subject,
    })),
  };
}

// WeeklyStats hujjatini student/classes/simpleStats.subjects.subject bilan yuklaydi
async function loadWeeklyStats(studentId, weekNumber, year) {
  const weeklyStats = await prisma.weeklyStats.findUnique({
    where: {
      student_year_weekNumber: { student: studentId, year, weekNumber },
    },
    include: { classes: { include: { class: true } } },
  });

  if (!weeklyStats) return null;

  const [student, simpleStats] = await Promise.all([
    prisma.user.findUnique({
      where: { id: weeklyStats.student },
      select: { id: true, firstName: true, lastName: true, fullName: true },
    }),
    attachSimpleStatsSubjects(weeklyStats.simpleStats),
  ]);

  const classes = (weeklyStats.classes || []).map((wc) => ({
    ...wc.class,
  }));

  return { ...weeklyStats, student, classes, simpleStats };
}

// ============================================================
// Public monitor endpoints (monitor code bilan himoyalangan)
// ============================================================

/**
 * Monitor kodini tekshirish.
 * POST /api/monitor/verify
 * @param {Object} req.body - { code: string }
 * @returns {{ success: boolean, data: { verified: boolean, monitor: Object } }}
 */
const verifyCode = asyncHandler(async (req, res) => {
  const { code } = req.body;

  if (!code || !/^\d{6}$/.test(code)) {
    throw new BadRequestError("Monitor kodi 6 xonali raqam bo'lishi kerak");
  }

  const monitor = await prisma.monitor.findFirst({
    where: { code, isActive: true },
  });

  if (!monitor) {
    const { UnauthorizedError } = require("../utils/errors");
    throw new UnauthorizedError("Monitor kodi noto'g'ri");
  }

  return res.json({
    success: true,
    data: {
      verified: true,
      monitor: {
        id: monitor.id,
        name: monitor.name,
        code: monitor.code,
      },
    },
  });
});

/**
 * Barcha sinflar ro'yxatini olish.
 * GET /api/monitor/classes
 * @returns {{ success: boolean, data: Array }}
 */
const getClasses = asyncHandler(async (req, res) => {
  const classes = await prisma.class.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return res.json({ success: true, data: classes });
});

/**
 * Sinfdagi o'quvchilar ro'yxatini olish (minimal ma'lumot).
 * GET /api/monitor/classes/:classId/students
 * @param {string} req.params.classId
 * @returns {{ success: boolean, data: Array }}
 */
const getClassStudents = asyncHandler(async (req, res) => {
  const { classId } = req.params;

  const classExists = await prisma.class.findUnique({ where: { id: classId } });
  if (!classExists) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const students = await prisma.user.findMany({
    where: {
      classes: { some: { classId } },
      role: "student",
      isActive: true,
    },
    select: { id: true, firstName: true, lastName: true },
    orderBy: { firstName: "asc" },
  });

  return res.json({ success: true, data: students });
});

/**
 * Bugungi barcha sinf dars jadvallarini olish.
 * GET /api/monitor/schedules/all-today
 * @returns {{ success: boolean, data: Array }}
 */
const getAllTodaySchedules = asyncHandler(async (req, res) => {
  const dayName = getCurrentDayUz();

  if (isSunday()) {
    return res.json({ success: true, data: [] });
  }

  const schedules = await prisma.schedule.findMany({
    where: { day: dayName },
    include: { lessons: true },
  });

  const { subjectMap, teacherMap } = await loadLessonRefs(schedules);

  // class scalar ref (relation YO'Q) — nom uchun qo'lda yuklaymiz
  const classIds = [...new Set(schedules.map((s) => s.classId).filter(Boolean))];
  const classes = await prisma.class.findMany({
    where: { id: { in: classIds } },
    select: { id: true, name: true },
  });
  const classMap = new Map(
    classes.map((c) => [c.id, { id: c.id, name: c.name }]),
  );

  const formattedSchedules = schedules.map((schedule) => ({
    class: classMap.get(schedule.classId) || null,
    subjects: mapLessons(schedule.lessons, subjectMap, teacherMap).sort(
      (a, b) => a.order - b.order,
    ),
  }));

  // Sort by class name (eski .sort({ "class.name": 1 }) ekvivalenti)
  formattedSchedules.sort((a, b) =>
    (a.class?.name || "").localeCompare(b.class?.name || ""),
  );

  return res.json({ success: true, data: formattedSchedules });
});

/**
 * Sinf bo'yicha haftalik dars jadvalini olish.
 * GET /api/monitor/schedules/class/:classId
 * @param {string} req.params.classId
 * @returns {{ success: boolean, data: Array }}
 */
const getClassSchedule = asyncHandler(async (req, res) => {
  const { classId } = req.params;

  const classExists = await prisma.class.findUnique({ where: { id: classId } });
  if (!classExists) {
    throw new NotFoundError("Sinf topilmadi");
  }

  const schedules = await prisma.schedule.findMany({
    where: { classId },
    include: { lessons: true },
    orderBy: { day: "asc" },
  });

  const { subjectMap, teacherMap } = await loadLessonRefs(schedules);

  // Sort lessons by their order number (manual order, e.g. 1, 3, 4)
  const sortedSchedules = schedules.map((schedule) => ({
    ...schedule,
    class: schedule.classId,
    subjects: mapLessons(schedule.lessons, subjectMap, teacherMap).sort(
      (a, b) => (a.order || 0) - (b.order || 0),
    ),
  }));

  return res.json({ success: true, data: sortedSchedules });
});

/**
 * O'quvchining haftalik statistikasini olish.
 * GET /api/monitor/statistics/weekly/:studentId
 * @param {string} req.params.studentId
 * @returns {{ success: boolean, data: Object }}
 */
const getStudentWeeklyStats = asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const { weekNumber, year } = getCurrentWeekRange();

  let weeklyStats = await loadWeeklyStats(studentId, weekNumber, year);

  if (!weeklyStats) {
    try {
      await createWeeklyStatsForStudent(studentId, weekNumber, year);
      weeklyStats = await loadWeeklyStats(studentId, weekNumber, year);
    } catch (error) {
      throw new NotFoundError("O'quvchi topilmadi yoki sinfga biriktirilmagan");
    }
  }

  const schoolRanking = await calculateStudentRankInSchool(
    studentId,
    weekNumber,
    year,
  );

  const classRankings = [];
  if (weeklyStats.classes && weeklyStats.classes.length > 0) {
    for (const cls of weeklyStats.classes) {
      const classRanking = await calculateStudentRankInClass(
        studentId,
        cls.id,
        weekNumber,
        year,
      );
      if (classRanking) {
        classRankings.push({
          class: cls,
          rank: classRanking.rank,
          totalStudents: classRanking.totalStudents,
        });
      }
    }
  }

  return res.json({
    success: true,
    data: {
      student: {
        id: weeklyStats.student.id,
        firstName: weeklyStats.student.firstName,
        lastName: weeklyStats.student.lastName,
        fullName: weeklyStats.student.fullName,
      },
      class:
        weeklyStats.classes && weeklyStats.classes[0]
          ? weeklyStats.classes[0]
          : null,
      classes: weeklyStats.classes || [],
      weekStart: weeklyStats.weekStart,
      weekEnd: weeklyStats.weekEnd,
      weekNumber: weeklyStats.weekNumber,
      year: weeklyStats.year,
      simpleStats: weeklyStats.simpleStats,
      rankings: {
        schoolRank: schoolRanking?.rank || null,
        schoolTotalStudents: schoolRanking?.totalStudents || 0,
        classRanks: classRankings,
      },
    },
  });
});

/**
 * O'quvchining tanga balansini olish.
 * GET /api/monitor/coins/balance/:studentId
 * @param {string} req.params.studentId
 * @returns {{ success: boolean, data: { coinBalance: number } }}
 */
const getStudentCoinBalance = asyncHandler(async (req, res) => {
  const { studentId } = req.params;

  const user = await prisma.user.findUnique({
    where: { id: studentId },
    select: { coinBalance: true },
  });

  if (!user) {
    throw new NotFoundError("O'quvchi topilmadi");
  }

  return res.json({
    success: true,
    data: { coinBalance: user.coinBalance || 0 },
  });
});

/**
 * Ijtimoiy tarmoqlar ro'yxatini olish.
 * GET /api/monitor/social-networks
 * @returns {{ success: boolean, data: Array }}
 */
const getSocialNetworks = asyncHandler(async (req, res) => {
  const networks = await prisma.socialNetwork.findMany({
    where: { isActive: true },
    select: { id: true, platform: true, name: true, username: true },
    orderBy: { createdAt: "desc" },
  });

  return res.json({ success: true, data: networks });
});

// ============================================================
// Admin endpoints (JWT bilan himoyalangan)
// ============================================================

/**
 * Monitor sozlamalarini olish (bitta monitor).
 * GET /api/monitor/admin/settings
 * @returns {{ success: boolean, data: Object | null }}
 */
const getMonitorSettings = asyncHandler(async (req, res) => {
  const monitor = await prisma.monitor.findFirst();
  return res.json({ success: true, data: monitor || null });
});

/**
 * Monitor sozlamalarini yaratish yoki yangilash (upsert).
 * PUT /api/monitor/admin/settings
 * @param {Object} req.body - { code: string, name?: string }
 * @returns {{ success: boolean, data: Object }}
 */
const updateMonitorSettings = asyncHandler(async (req, res) => {
  const { code, name } = req.body;

  if (!code || !/^\d{6}$/.test(code)) {
    throw new BadRequestError("Monitor kodi 6 xonali raqam bo'lishi kerak");
  }

  // Bitta monitor hujjati bo'ladi (Mongoose findOneAndUpdate({}, ..., {upsert}))
  const existing = await prisma.monitor.findFirst();

  const monitor = existing
    ? await prisma.monitor.update({
        where: { id: existing.id },
        data: { code, name, isActive: true },
      })
    : await prisma.monitor.create({
        data: { code, name, isActive: true },
      });

  return res.json({ success: true, data: monitor });
});

module.exports = {
  verifyCode,
  getClasses,
  getClassStudents,
  getAllTodaySchedules,
  getClassSchedule,
  getStudentWeeklyStats,
  getStudentCoinBalance,
  getSocialNetworks,
  getMonitorSettings,
  updateMonitorSettings,
};
