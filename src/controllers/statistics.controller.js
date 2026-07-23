const asyncHandler = require("../middleware/async.middleware");
const { NotFoundError, ForbiddenError } = require("../utils/errors");
const logger = require("../utils/logger");

const prisma = require("../config/prisma");

// Services
const ExcelService = require("../services/excel.service");
const { getCurrentWeekRange } = require("../helpers/statistics.helpers");
const {
  createWeeklyStatsForStudent,
  calculateStudentRankInClass,
  calculateStudentRankInSchool,
} = require("../services/weeklystats.service");

/**
 * WeeklyStats.simpleStats — JSONB (populate ishlamaydi). subjects[].subject
 * ObjectId'larni JSONB ichidan olib, alohida prisma.subject.findMany bilan
 * yuklab, JS'da biriktiradi (Mongoose'ning simpleStats.subjects.subject populate ekvivalenti).
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
  const subjectMap = new Map(subjects.map((s) => [s.id, { ...s, id: s.id }]));

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

// Student scalar ref'ni User hujjatiga aylantiradi (profilePicture bilan)
async function loadWeeklyStatsStudent(studentId) {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      fullName: true,
      displayName: true,
      nameColor: true,
      premiumIsActive: true,
      premiumExpiresAt: true,
      emojiBadgeId: true,
      profileImage: { select: { variants: true } },
    },
  });
  return student;
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

  return hydrateWeeklyStats(weeklyStats);
}

// Yuklangan weeklyStats qatorini API shakliga hydrate qiladi
async function hydrateWeeklyStats(weeklyStats) {
  const [student, simpleStats] = await Promise.all([
    loadWeeklyStatsStudent(weeklyStats.student),
    attachSimpleStatsSubjects(weeklyStats.simpleStats),
  ]);

  const classes = (weeklyStats.classes || []).map((wc) => ({
    ...wc.class,
    id: wc.class.id,
  }));

  return { ...weeklyStats, student, classes, simpleStats };
}

/**
 * Bitta o'quvchining haftalik statistikasini olish (FROM WEEKLYSTATS)
 * GET /api/statistics/weekly/current/:studentId
 * @access Private (Owner yoki student o'zini)
 */
exports.getStudentWeeklyStatistics = asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const { weekNumber, year } = getCurrentWeekRange();

  // Student faqat o'z statistikasini ko'rishi mumkin
  if (req.user.role === "student" && req.user.id !== studentId) {
    throw new ForbiddenError("Siz faqat o'z statistikangizni ko'rishingiz mumkin");
  }

  // Find WeeklyStats
  let weeklyStats = await loadWeeklyStats(studentId, weekNumber, year);

  // If doesn't exist, create it now (fallback)
  if (!weeklyStats) {
    try {
      await createWeeklyStatsForStudent(studentId, weekNumber, year);
      weeklyStats = await loadWeeklyStats(studentId, weekNumber, year);
    } catch (error) {
      // If student doesn't exist or has no class
      throw new NotFoundError("O'quvchi topilmadi yoki sinfga biriktirilmagan");
    }
  }

  const student = weeklyStats.student;

  // Calculate rankings on-demand (lazy calculation)
  const schoolRanking = await calculateStudentRankInSchool(
    studentId,
    weekNumber,
    year,
  );

  // Calculate class rankings for all student's classes
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

  // Transform to API response format
  return res.json({
    success: true,
    data: {
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        fullName: student.fullName,
        displayName: student.displayName || null,
        nameColor: student.nameColor || null,
        premium: {
          isActive: student.premiumIsActive || false,
          expiresAt: student.premiumExpiresAt || null,
        },
        emojiBadgeId: student.emojiBadgeId || null,
        profilePictureUrl: student.profileImage?.variants?.sm?.url || null,
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
 * Sinf bo'yicha reytinglarni olish (FROM WEEKLYSTATS)
 * GET /api/statistics/weekly/class/:classId/rankings
 * @access Private (Owner only)
 */
exports.getClassRankings = asyncHandler(async (req, res) => {
  const { classId } = req.params;
  const { page = 1, limit = 20 } = req.query;
  const { weekStart, weekEnd, weekNumber, year } = getCurrentWeekRange();

  // Parse pagination parameters
  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  const skip = (pageNum - 1) * limitNum;

  // Sinfni tekshirish
  const classDoc = await prisma.class.findUnique({ where: { id: classId } });
  if (!classDoc) {
    throw new NotFoundError("Sinf topilmadi");
  }

  // Find all WeeklyStats for this class and week
  const rows = await prisma.weeklyStats.findMany({
    where: {
      classes: { some: { classId } },
      year,
      weekNumber,
    },
    select: {
      student: true,
      totalSum: true,
      totalGrades: true,
      simpleStats: true,
    },
  });

  // student scalar ref (relation YO'Q) — qo'lda yuklaymiz (profilePicture bilan)
  const studentIds = [...new Set(rows.map((r) => r.student).filter(Boolean))];
  const students = await prisma.user.findMany({
    where: { id: { in: studentIds } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      fullName: true,
      displayName: true,
      nameColor: true,
      premiumIsActive: true,
      premiumExpiresAt: true,
      emojiBadgeId: true,
      profileImage: { select: { variants: true } },
      classes: { include: { class: true } },
    },
  });
  const studentMap = new Map(students.map((s) => [s.id, s]));

  // Har bir stat uchun student hujjatini biriktiramiz (populate ekvivalenti)
  const allStats = rows.map((stat) => ({
    student: studentMap.get(stat.student) || null,
    simpleStats: stat.simpleStats,
  }));

  if (allStats.length === 0) {
    return res.json({
      success: true,
      data: {
        class: { ...classDoc, id: classDoc.id },
        weekStart,
        weekEnd,
        weekNumber,
        year,
        totalStudents: 0,
        rankings: [],
      },
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalPages: 0,
        totalItems: 0,
        hasNextPage: false,
        hasPrevPage: false,
      },
    });
  }

  // Sort by totalSum (descending) - this determines rank
  allStats.sort((a, b) => b.simpleStats.totalSum - a.simpleStats.totalSum);

  // Transform to ranking format with calculated ranks
  const rankings = allStats
    .filter((stat) => stat.student)
    .map((stat, index) => ({
      rank: index + 1, // Rank based on sorted position
      student: {
        id: stat.student.id,
        firstName: stat.student.firstName,
        lastName: stat.student.lastName,
        fullName: stat.student.fullName,
        displayName: stat.student.displayName || null,
        nameColor: stat.student.nameColor || null,
        premium: {
          isActive: stat.student.premiumIsActive || false,
          expiresAt: stat.student.premiumExpiresAt || null,
        },
        emojiBadgeId: stat.student.emojiBadgeId || null,
        profilePictureUrl: stat.student.profileImage?.variants?.sm?.url || null,
      },
      totalSum: stat.simpleStats.totalSum,
      totalGrades: stat.simpleStats.totalGrades,
    }));

  // Calculate pagination
  const totalItems = rankings.length;
  const totalPages = Math.ceil(totalItems / limitNum);
  const paginatedRankings = rankings.slice(skip, skip + limitNum);

  return res.json({
    success: true,
    data: {
      class: { ...classDoc, id: classDoc.id },
      weekStart,
      weekEnd,
      weekNumber,
      year,
      totalStudents: rankings.length,
      rankings: paginatedRankings,
    },
    pagination: {
      page: pageNum,
      limit: limitNum,
      totalPages,
      totalItems,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1,
    },
  });
});

/**
 * Maktab bo'yicha reytinglarni olish (FROM WEEKLYSTATS)
 * GET /api/statistics/weekly/school/rankings
 * @access Private (Owner only)
 */
exports.getSchoolRankings = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { weekStart, weekEnd, weekNumber, year } = getCurrentWeekRange();

  // Parse pagination parameters
  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  const skip = (pageNum - 1) * limitNum;

  // Find all WeeklyStats for this week
  const rows = await prisma.weeklyStats.findMany({
    where: {
      year,
      weekNumber,
    },
    select: {
      student: true,
      totalSum: true,
      totalGrades: true,
      simpleStats: true,
    },
  });

  // student scalar ref (relation YO'Q) — qo'lda yuklaymiz (classes + profilePicture bilan)
  const studentIds = [...new Set(rows.map((r) => r.student).filter(Boolean))];
  const students = await prisma.user.findMany({
    where: { id: { in: studentIds } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      fullName: true,
      displayName: true,
      nameColor: true,
      premiumIsActive: true,
      premiumExpiresAt: true,
      emojiBadgeId: true,
      profileImage: { select: { variants: true } },
      classes: { include: { class: true } },
    },
  });
  const studentMap = new Map(
    students.map((s) => [
      s.id,
      {
        ...s,
        classes: (s.classes || []).map((uc) => ({ ...uc.class, id: uc.class.id })),
      },
    ]),
  );

  const allStats = rows.map((stat) => ({
    student: studentMap.get(stat.student) || null,
    simpleStats: stat.simpleStats,
  }));

  if (allStats.length === 0) {
    return res.json({
      success: true,
      data: {
        weekStart,
        weekEnd,
        weekNumber,
        year,
        totalStudents: 0,
        rankings: [],
      },
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalPages: 0,
        totalItems: 0,
        hasNextPage: false,
        hasPrevPage: false,
      },
    });
  }

  // Sort by totalSum (descending) - this determines rank
  allStats.sort((a, b) => b.simpleStats.totalSum - a.simpleStats.totalSum);

  // Transform to ranking format with calculated ranks
  const rankings = allStats
    .filter((stat) => stat.student)
    .map((stat, index) => ({
      rank: index + 1,
      student: {
        id: stat.student.id,
        firstName: stat.student.firstName,
        lastName: stat.student.lastName,
        fullName: stat.student.fullName,
        displayName: stat.student.displayName || null,
        nameColor: stat.student.nameColor || null,
        premium: {
          isActive: stat.student.premiumIsActive || false,
          expiresAt: stat.student.premiumExpiresAt || null,
        },
        emojiBadgeId: stat.student.emojiBadgeId || null,
        profilePictureUrl: stat.student.profileImage?.variants?.sm?.url || null,
      },
      classes: stat.student.classes || [],
      totalSum: stat.simpleStats.totalSum,
      totalGrades: stat.simpleStats.totalGrades,
    }));

  // Calculate pagination
  const totalItems = rankings.length;
  const totalPages = Math.ceil(totalItems / limitNum);
  const paginatedRankings = rankings.slice(skip, skip + limitNum);

  return res.json({
    success: true,
    data: {
      weekStart,
      weekEnd,
      weekNumber,
      year,
      totalStudents: rankings.length,
      rankings: paginatedRankings,
    },
    pagination: {
      page: pageNum,
      limit: limitNum,
      totalPages,
      totalItems,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1,
    },
  });
});

/**
 * O'quvchining barcha haftalik statistikasini olish (ALL WEEKS, ALL YEARS)
 * GET /api/statistics/weekly/student/:studentId/all
 * @access Private (Owner yoki student o'zini)
 */
exports.getAllStudentWeeklyStats = asyncHandler(async (req, res) => {
  const { studentId } = req.params;

  // Student faqat o'z statistikasini ko'rishi mumkin
  if (req.user.role === "student" && req.user.id !== studentId) {
    throw new ForbiddenError("Siz faqat o'z statistikangizni ko'rishingiz mumkin");
  }

  const rows = await prisma.weeklyStats.findMany({
    where: { student: studentId },
    orderBy: [{ year: "asc" }, { weekNumber: "asc" }],
  });

  // simpleStats.subjects.subject — JSONB ichidagi ObjectId'lar; qo'lda name bilan yuklaymiz
  const allStats = await Promise.all(
    rows.map(async (stat) => ({
      ...stat,
      simpleStats: await attachSimpleStatsSubjects(stat.simpleStats),
    })),
  );

  return res.json({ success: true, data: allStats });
});

/**
 * Haftalik statistikani Excel formatida export qilish
 * GET /api/statistics/weekly/export
 * @access Private (Owner only)
 */
exports.exportWeeklyStatistics = asyncHandler(async (req, res) => {
  const { type = "school", classId } = req.query;
  const { weekStart, weekEnd, weekNumber, year } = getCurrentWeekRange();

  let rankings = [];
  let sheetName = "Maktab reytingi";
  let classDoc = null;

  if (type === "class" && classId) {
    classDoc = await prisma.class.findUnique({ where: { id: classId } });
    if (!classDoc) {
      throw new NotFoundError("Sinf topilmadi");
    }

    const rows = await prisma.weeklyStats.findMany({
      where: {
        classes: { some: { classId } },
        year,
        weekNumber,
      },
      select: { student: true, totalSum: true, totalGrades: true, simpleStats: true },
    });

    // student scalar ref — qo'lda yuklaymiz (fullName uchun)
    const studentIds = [...new Set(rows.map((r) => r.student).filter(Boolean))];
    const students = await prisma.user.findMany({
      where: { id: { in: studentIds } },
      select: { id: true, firstName: true, lastName: true, fullName: true },
    });
    const studentMap = new Map(students.map((s) => [s.id, s]));

    const allStats = rows.map((stat) => ({
      student: studentMap.get(stat.student) || null,
      simpleStats: stat.simpleStats,
    }));
    allStats.sort((a, b) => b.simpleStats.totalSum - a.simpleStats.totalSum);

    rankings = allStats
      .filter((stat) => stat.student)
      .map((stat, index) => ({
        rank: index + 1,
        fullName: stat.student.fullName,
        totalSum: stat.simpleStats.totalSum,
        totalGrades: stat.simpleStats.totalGrades,
      }));

    sheetName = `${classDoc.name} reytingi`;
  } else {
    const rows = await prisma.weeklyStats.findMany({
      where: {
        year,
        weekNumber,
      },
      select: { student: true, totalSum: true, totalGrades: true, simpleStats: true },
    });

    // student scalar ref — qo'lda yuklaymiz (fullName + classes uchun)
    const studentIds = [...new Set(rows.map((r) => r.student).filter(Boolean))];
    const students = await prisma.user.findMany({
      where: { id: { in: studentIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        fullName: true,
        classes: { include: { class: { select: { id: true, name: true } } } },
      },
    });
    const studentMap = new Map(
      students.map((s) => [
        s.id,
        { ...s, classes: (s.classes || []).map((uc) => uc.class) },
      ]),
    );

    const allStats = rows.map((stat) => ({
      student: studentMap.get(stat.student) || null,
      simpleStats: stat.simpleStats,
    }));
    allStats.sort((a, b) => b.simpleStats.totalSum - a.simpleStats.totalSum);

    rankings = allStats
      .filter((stat) => stat.student)
      .map((stat, index) => ({
        rank: index + 1,
        fullName: stat.student.fullName,
        classes:
          stat.student.classes && stat.student.classes.length > 0
            ? stat.student.classes.map((c) => c.name).join(", ")
            : "-",
        totalSum: stat.simpleStats.totalSum,
        totalGrades: stat.simpleStats.totalGrades,
      }));
  }

  const columns =
    type === "class"
      ? [
          { header: "O'rin", key: "rank", width: 8 },
          { header: "O'quvchi", key: "fullName", width: 30 },
          { header: "Umumiy ball", key: "totalSum", width: 15 },
          { header: "Baholar soni", key: "totalGrades", width: 15 },
        ]
      : [
          { header: "O'rin", key: "rank", width: 8 },
          { header: "O'quvchi", key: "fullName", width: 30 },
          { header: "Sinflar", key: "classes", width: 20 },
          { header: "Umumiy ball", key: "totalSum", width: 15 },
          { header: "Baholar soni", key: "totalGrades", width: 15 },
        ];

  const workbook = ExcelService.createExcel({
    sheetName,
    columns,
    data: rankings,
    headerStyle: {
      bgColor: ExcelService.COLORS.HEADER_BLUE,
    },
  });

  const baseFileName =
    type === "class" && classDoc
      ? `haftalik_reyting_${classDoc.name}`
      : "haftalik_reyting_maktab";
  const filename = ExcelService.generateFileName(baseFileName);

  await ExcelService.sendWorkbook(res, workbook, filename);
});
