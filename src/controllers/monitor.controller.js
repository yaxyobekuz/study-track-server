const asyncHandler = require("../middleware/async.middleware");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const logger = require("../utils/logger");

const prisma = require("../config/prisma");

const { getCurrentDayUz, isSunday } = require("../helpers/date.helpers");
const statisticsService = require("../services/statistics.service");

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
  const data = await statisticsService.getStudentWeekly(studentId);
  return res.json({ success: true, data });
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
