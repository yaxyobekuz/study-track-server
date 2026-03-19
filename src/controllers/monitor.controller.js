const Monitor = require("../models/monitor.model");
const Class = require("../models/class.model");
const User = require("../models/user.model");
const Schedule = require("../models/schedule.model");
const WeeklyStats = require("../models/weeklystats.model");
const SocialNetwork = require("../models/socialNetwork.model");

const { getCurrentDayUz, isSunday } = require("../helpers/date.helpers");
const { getCurrentWeekRange } = require("../helpers/statistics.helpers");
const {
  calculateStudentRankInClass,
  calculateStudentRankInSchool,
} = require("../services/weeklystats.service");

// ============================================================
// Public monitor endpoints (monitor code bilan himoyalangan)
// ============================================================

/**
 * Monitor kodini tekshirish.
 * POST /api/monitor/verify
 * @param {Object} req.body - { code: string }
 * @returns {{ success: boolean, data: { verified: boolean, monitor: Object } }}
 */
const verifyCode = async (req, res) => {
  try {
    const { code } = req.body;

    if (!code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({
        success: false,
        message: "Monitor kodi 6 xonali raqam bo'lishi kerak",
      });
    }

    const monitor = await Monitor.findOne({ code, isActive: true });

    if (!monitor) {
      return res.status(401).json({
        success: false,
        message: "Monitor kodi noto'g'ri",
      });
    }

    return res.json({
      success: true,
      data: {
        verified: true,
        monitor: {
          _id: monitor._id,
          name: monitor.name,
          code: monitor.code,
        },
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Barcha sinflar ro'yxatini olish.
 * GET /api/monitor/classes
 * @returns {{ success: boolean, data: Array }}
 */
const getClasses = async (req, res) => {
  try {
    const classes = await Class.find({ isActive: true })
      .select("name")
      .sort({ name: 1 })
      .lean();

    return res.json({ success: true, data: classes });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Sinfdagi o'quvchilar ro'yxatini olish (minimal ma'lumot).
 * GET /api/monitor/classes/:classId/students
 * @param {string} req.params.classId
 * @returns {{ success: boolean, data: Array }}
 */
const getClassStudents = async (req, res) => {
  try {
    const { classId } = req.params;

    const classExists = await Class.findById(classId);
    if (!classExists) {
      return res.status(404).json({
        success: false,
        message: "Sinf topilmadi",
      });
    }

    const students = await User.find({
      classes: classId,
      role: "student",
      isActive: true,
    })
      .select("firstName lastName")
      .sort({ firstName: 1 })
      .lean();

    return res.json({ success: true, data: students });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Bugungi barcha sinf dars jadvallarini olish.
 * GET /api/monitor/schedules/all-today
 * @returns {{ success: boolean, data: Array }}
 */
const getAllTodaySchedules = async (req, res) => {
  try {
    const dayName = getCurrentDayUz();

    if (isSunday()) {
      return res.json({ success: true, data: [] });
    }

    const schedules = await Schedule.find({ day: dayName })
      .populate("class", "name")
      .populate("subjects.subject", "name")
      .populate("subjects.teacher", "firstName lastName")
      .sort({ "class.name": 1 });

    const formattedSchedules = schedules.map((schedule) => ({
      class: schedule.class,
      subjects: schedule.subjects.sort((a, b) => a.order - b.order),
      startingOrder: schedule.startingOrder || 1,
    }));

    return res.json({ success: true, data: formattedSchedules });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Sinf bo'yicha haftalik dars jadvalini olish.
 * GET /api/monitor/schedules/class/:classId
 * @param {string} req.params.classId
 * @returns {{ success: boolean, data: Array }}
 */
const getClassSchedule = async (req, res) => {
  try {
    const { classId } = req.params;

    const classExists = await Class.findById(classId);
    if (!classExists) {
      return res.status(404).json({
        success: false,
        message: "Sinf topilmadi",
      });
    }

    const schedules = await Schedule.find({ class: classId })
      .populate("subjects.subject", "name")
      .populate("subjects.teacher", "firstName lastName")
      .sort({ day: 1 })
      .lean();

    return res.json({ success: true, data: schedules });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * O'quvchining haftalik statistikasini olish.
 * GET /api/monitor/statistics/weekly/:studentId
 * @param {string} req.params.studentId
 * @returns {{ success: boolean, data: Object }}
 */
const getStudentWeeklyStats = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { weekNumber, year } = getCurrentWeekRange();

    let weeklyStats = await WeeklyStats.findOne({
      student: studentId,
      year,
      weekNumber,
    }).populate("student classes simpleStats.subjects.subject");

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
        return res.status(404).json({
          success: false,
          message: "O'quvchi topilmadi yoki sinfga biriktirilmagan",
        });
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
  } catch (error) {
    console.error("Monitor: Get student weekly statistics error:", error);
    return res.status(500).json({
      success: false,
      message: "Statistikalarni olishda xatolik yuz berdi",
    });
  }
};

/**
 * O'quvchining tanga balansini olish.
 * GET /api/monitor/coins/balance/:studentId
 * @param {string} req.params.studentId
 * @returns {{ success: boolean, data: { coinBalance: number } }}
 */
const getStudentCoinBalance = async (req, res) => {
  try {
    const { studentId } = req.params;

    const user = await User.findById(studentId).select("coinBalance").lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "O'quvchi topilmadi",
      });
    }

    return res.json({
      success: true,
      data: { coinBalance: user.coinBalance || 0 },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Ijtimoiy tarmoqlar ro'yxatini olish.
 * GET /api/monitor/social-networks
 * @returns {{ success: boolean, data: Array }}
 */
const getSocialNetworks = async (req, res) => {
  try {
    const networks = await SocialNetwork.find({ isActive: true })
      .select("platform name username")
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ success: true, data: networks });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// ============================================================
// Admin endpoints (JWT bilan himoyalangan)
// ============================================================

/**
 * Monitor sozlamalarini olish (bitta monitor).
 * GET /api/monitor/admin/settings
 * @returns {{ success: boolean, data: Object | null }}
 */
const getMonitorSettings = async (req, res) => {
  try {
    const monitor = await Monitor.findOne().lean();
    return res.json({ success: true, data: monitor || null });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Monitor sozlamalarini yaratish yoki yangilash (upsert).
 * PUT /api/monitor/admin/settings
 * @param {Object} req.body - { code: string, name?: string }
 * @returns {{ success: boolean, data: Object }}
 */
const updateMonitorSettings = async (req, res) => {
  try {
    const { code, name } = req.body;

    if (!code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({
        success: false,
        message: "Monitor kodi 6 xonali raqam bo'lishi kerak",
      });
    }

    const monitor = await Monitor.findOneAndUpdate(
      {},
      { code, name, isActive: true },
      { upsert: true, new: true, runValidators: true },
    );

    return res.json({ success: true, data: monitor });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Bu kod allaqachon ishlatilmoqda",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

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
