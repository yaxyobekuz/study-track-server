// Models
const Class = require("../models/class.model");
const WeeklyStats = require("../models/weeklystats.model");

// Services
const { getCurrentWeekRange } = require("../helpers/statistics.helpers");

/**
 * Bitta o'quvchining haftalik statistikasini olish (FROM WEEKLYSTATS)
 * GET /api/statistics/weekly/current/:studentId
 * @access Private (Owner yoki student o'zini)
 */
exports.getStudentWeeklyStatistics = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { weekStart, weekEnd, weekNumber, year } = getCurrentWeekRange();

    // Student faqat o'z statistikasini ko'rishi mumkin
    if (req.user.role === "student" && req.user._id.toString() !== studentId) {
      return res.status(403).json({
        success: false,
        message: "Siz faqat o'z statistikangizni ko'rishingiz mumkin",
      });
    }

    // Find pre-calculated WeeklyStats
    let weeklyStats = await WeeklyStats.findOne({
      student: studentId,
      year,
      weekNumber,
    }).populate(
      "student classes simpleStats.subjects.subject rankings.classRanks.class",
    );

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
          "student classes simpleStats.subjects.subject rankings.classRanks.class",
        );
      } catch (error) {
        // If student doesn't exist or has no class
        return res.status(404).json({
          success: false,
          message: "O'quvchi topilmadi yoki sinfga biriktirilmagan",
        });
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
        class: weeklyStats.classes && weeklyStats.classes[0] ? weeklyStats.classes[0] : null,
        classes: weeklyStats.classes || [],
        weekStart: weeklyStats.weekStart,
        weekEnd: weeklyStats.weekEnd,
        weekNumber: weeklyStats.weekNumber,
        year: weeklyStats.year,
        simpleStats: weeklyStats.simpleStats,
        rankings: weeklyStats.rankings,
      },
    });
  } catch (error) {
    console.error("Get student weekly statistics error:", error);
    return res.status(500).json({
      success: false,
      message: "Statistikalarni olishda xatolik yuz berdi",
    });
  }
};

/**
 * Sinf bo'yicha reytinglarni olish (FROM WEEKLYSTATS)
 * GET /api/statistics/weekly/class/:classId/rankings
 * @access Private (Owner only)
 */
exports.getClassRankings = async (req, res) => {
  try {
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
      return res.status(404).json({
        success: false,
        message: "Sinf topilmadi",
      });
    }

    // Find all WeeklyStats for this class and week
    const allStats = await WeeklyStats.find({
      classes: classId,
      year,
      weekNumber,
    }).populate("student rankings.classRanks.class");

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

    // Transform to ranking format
    const rankings = allStats.map((stat) => {
      // Find this student's rank in this specific class
      const classRankData = stat.rankings.classRanks
        ? stat.rankings.classRanks.find(
            (cr) => cr.class._id.toString() === classId,
          )
        : null;

      return {
        rank: classRankData ? classRankData.rank : null,
        student: {
          _id: stat.student._id,
          firstName: stat.student.firstName,
          lastName: stat.student.lastName,
          fullName: stat.student.fullName,
        },
        totalSum: stat.simpleStats.totalSum,
        totalGrades: stat.simpleStats.totalGrades,
      };
    });

    // Sort by rank
    rankings.sort((a, b) => a.rank - b.rank);

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
  } catch (error) {
    console.error("Get class rankings error:", error);
    return res.status(500).json({
      success: false,
      message: "Reytinglarni olishda xatolik yuz berdi",
    });
  }
};

/**
 * Maktab bo'yicha reytinglarni olish (FROM WEEKLYSTATS)
 * GET /api/statistics/weekly/school/rankings
 * @access Private (Owner only)
 */
exports.getSchoolRankings = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const { weekStart, weekEnd, weekNumber, year } = getCurrentWeekRange();

    // Parse pagination parameters
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    // Find all WeeklyStats for this week
    const allStats = await WeeklyStats.find({
      year,
      weekNumber,
    })
      .populate("classes rankings.classRanks.class")
      .populate({
        path: "student",
        populate: {
          path: "classes",
        },
      });

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

    // Transform to ranking format
    const rankings = allStats.map((stat) => ({
      rank: stat.rankings.schoolRank,
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

    // Sort by rank
    rankings.sort((a, b) => a.rank - b.rank);

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
  } catch (error) {
    console.error("Get school rankings error:", error);
    return res.status(500).json({
      success: false,
      message: "Reytinglarni olishda xatolik yuz berdi",
    });
  }
};
