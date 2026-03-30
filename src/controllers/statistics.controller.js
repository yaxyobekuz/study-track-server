const asyncHandler = require("../middleware/async.middleware");
const { NotFoundError, ForbiddenError } = require("../utils/errors");
const logger = require("../utils/logger");

// Models
const Class = require("../models/class.model");
const WeeklyStats = require("../models/weeklystats.model");

// Services
const ExcelService = require("../services/excel.service");
const { getCurrentWeekRange } = require("../helpers/statistics.helpers");
const {
  calculateStudentRankInClass,
  calculateStudentRankInSchool,
} = require("../services/weeklystats.service");

/**
 * Bitta o'quvchining haftalik statistikasini olish (FROM WEEKLYSTATS)
 * GET /api/statistics/weekly/current/:studentId
 * @access Private (Owner yoki student o'zini)
 */
exports.getStudentWeeklyStatistics = asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const { weekNumber, year } = getCurrentWeekRange();

  // Student faqat o'z statistikasini ko'rishi mumkin
  if (req.user.role === "student" && req.user._id.toString() !== studentId) {
    throw new ForbiddenError("Siz faqat o'z statistikangizni ko'rishingiz mumkin");
  }

  // Find WeeklyStats
  let weeklyStats = await WeeklyStats.findOne({
    student: studentId,
    year,
    weekNumber,
  }).populate("student classes simpleStats.subjects.subject");

  // If doesn't exist, create it now (fallback)
  if (!weeklyStats) {
    const {
      createWeeklyStatsForStudent,
    } = require("../services/weeklystats.service");

    try {
      weeklyStats = await createWeeklyStatsForStudent(
        studentId,
        weekNumber,
        year,
      );
      await weeklyStats.populate(
        "student classes simpleStats.subjects.subject",
      );
    } catch (error) {
      // If student doesn't exist or has no class
      throw new NotFoundError("O'quvchi topilmadi yoki sinfga biriktirilmagan");
    }
  }

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
        cls._id,
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
        _id: weeklyStats.student._id,
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
  const classDoc = await Class.findById(classId);
  if (!classDoc) {
    throw new NotFoundError("Sinf topilmadi");
  }

  // Find all WeeklyStats for this class and week
  let allStats = await WeeklyStats.find({
    classes: classId,
    year,
    weekNumber,
  })
    .populate("student")
    .select("student simpleStats.totalSum simpleStats.totalGrades");

  // Convert to plain objects to include virtuals like fullName
  allStats = allStats.map((stat) => stat.toJSON());

  if (allStats.length === 0) {
    return res.json({
      success: true,
      data: {
        class: classDoc,
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
        _id: stat.student._id,
        firstName: stat.student.firstName,
        lastName: stat.student.lastName,
        fullName: stat.student.fullName,
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
      class: classDoc,
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
  let allStats = await WeeklyStats.find({
    year,
    weekNumber,
  })
    .populate({
      path: "student",
      populate: {
        path: "classes",
      },
    })
    .select("student simpleStats.totalSum simpleStats.totalGrades");

  // Convert to plain objects to include virtuals like fullName
  allStats = allStats.map((stat) => stat.toJSON());

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
        _id: stat.student._id,
        firstName: stat.student.firstName,
        lastName: stat.student.lastName,
        fullName: stat.student.fullName,
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
  if (req.user.role === "student" && req.user._id.toString() !== studentId) {
    throw new ForbiddenError("Siz faqat o'z statistikangizni ko'rishingiz mumkin");
  }

  const allStats = await WeeklyStats.find({ student: studentId })
    .populate("simpleStats.subjects.subject", "name")
    .sort({ year: 1, weekNumber: 1 })
    .lean();

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
    classDoc = await Class.findById(classId);
    if (!classDoc) {
      throw new NotFoundError("Sinf topilmadi");
    }

    let allStats = await WeeklyStats.find({
      classes: classId,
      year,
      weekNumber,
    })
      .populate("student")
      .select("student simpleStats.totalSum simpleStats.totalGrades");

    allStats = allStats.map((stat) => stat.toJSON());
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
    let allStats = await WeeklyStats.find({
      year,
      weekNumber,
    })
      .populate({
        path: "student",
        populate: {
          path: "classes",
        },
      })
      .select("student simpleStats.totalSum simpleStats.totalGrades");

    allStats = allStats.map((stat) => stat.toJSON());
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
