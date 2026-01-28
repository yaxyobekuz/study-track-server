const WeeklyStats = require("../models/weeklystats.model");
const User = require("../models/user.model");
const Grade = require("../models/grade.model");
const {
  getCurrentWeekRange,
  getWeekNumber,
  calculateTotalSum,
} = require("../helpers/statistics.helpers");
const logger = require("../utils/logger");

/**
 * Update WeeklyStats after a grade is created/updated
 */
async function updateWeeklyStatsForGrade(gradeDoc) {
  const { weekStart, weekEnd, weekNumber, year } = getCurrentWeekRange();

  // Only update if grade is from current week
  const gradeDate = new Date(gradeDoc.date);
  if (gradeDate < weekStart || gradeDate > weekEnd) {
    return; // Grade is from a different week, skip
  }

  // Find or create WeeklyStats for this student
  let weeklyStats = await WeeklyStats.findOne({
    student: gradeDoc.student,
    year,
    weekNumber,
  });

  if (!weeklyStats) {
    // Create new stats if doesn't exist
    weeklyStats = await createWeeklyStatsForStudent(
      gradeDoc.student,
      weekNumber,
      year,
    );
  } else {
    // Recalculate stats
    await recalculateWeeklyStats(weeklyStats);
  }
}

/**
 * Create WeeklyStats for a student
 */
async function createWeeklyStatsForStudent(studentId, weekNumber, year) {
  const student = await User.findById(studentId).populate("classes");

  if (
    !student ||
    student.role !== "student" ||
    !student.classes ||
    student.classes.length === 0
  ) {
    throw new Error("Invalid student or no class assigned");
  }

  const classIds = student.classes.map((c) => c._id);

  // Get week range
  const { weekStart, weekEnd } = getWeekRangeByNumber(weekNumber, year);

  // Create empty stats
  const weeklyStats = new WeeklyStats({
    student: studentId,
    classes: classIds,
    weekStart,
    weekEnd,
    weekNumber,
    year,
    simpleStats: {
      subjects: [],
      totalSum: 0,
      totalGrades: 0,
    },
    rankings: {},
  });

  // Calculate initial stats
  await recalculateWeeklyStats(weeklyStats);

  return weeklyStats;
}

/**
 * Recalculate all statistics for a WeeklyStats document
 */
async function recalculateWeeklyStats(weeklyStats) {
  const { weekStart, weekEnd } = weeklyStats;

  // 1. Get all grades for this week (from all student's classes)
  const grades = await Grade.find({
    student: weeklyStats.student,
    class: { $in: weeklyStats.classes },
    date: { $gte: weekStart, $lte: weekEnd },
  }).populate("subject teacher");

  if (grades.length === 0) {
    // No grades this week - save empty stats
    weeklyStats.simpleStats.subjects = [];
    weeklyStats.simpleStats.totalSum = 0;
    weeklyStats.simpleStats.totalGrades = 0;
    weeklyStats.lastUpdated = new Date();
    await weeklyStats.save();
    return weeklyStats;
  }

  // 2. Group by subject
  const subjectMap = new Map();
  grades.forEach((g) => {
    const subjectId = g.subject._id.toString();
    if (!subjectMap.has(subjectId)) {
      subjectMap.set(subjectId, {
        subject: g.subject,
        grades: [],
        teachers: new Set(),
      });
    }
    const stats = subjectMap.get(subjectId);
    stats.grades.push(g.grade);
    stats.teachers.add(g.teacher.firstName + " " + g.teacher.lastName);
  });

  // 3. Calculate sum-based stats
  const simpleSubjects = [];
  subjectMap.forEach((stats, subjectId) => {
    const sum = calculateTotalSum(stats.grades.map((g) => ({ grade: g })));
    simpleSubjects.push({
      subject: stats.subject._id,
      grades: stats.grades,
      sum: sum,
      count: stats.grades.length,
      teachers: Array.from(stats.teachers),
    });
  });

  const totalSum = calculateTotalSum(grades);

  // 4. Update WeeklyStats document
  weeklyStats.simpleStats = {
    subjects: simpleSubjects,
    totalSum: totalSum,
    totalGrades: grades.length,
  };

  weeklyStats.lastUpdated = new Date();

  await weeklyStats.save();

  return weeklyStats;
}

/**
 * Generate WeeklyStats for all students (cron job)
 */
async function generateWeeklyStatsForAllStudents(weekNumber, year) {
  logger.info(
    `Starting weekly stats generation for week ${weekNumber}, year ${year}`,
  );

  const students = await User.find({
    role: "student",
    isActive: true,
  }).populate("classes");

  let successCount = 0;
  let errorCount = 0;

  for (const student of students) {
    try {
      if (!student.classes || student.classes.length === 0) {
        continue; // Skip students without class
      }

      await createWeeklyStatsForStudent(student._id, weekNumber, year);
      successCount++;
    } catch (error) {
      logger.error(`Error generating stats for student ${student._id}:`, error);
      errorCount++;
    }
  }

  logger.info(
    `Weekly stats generation completed: ${successCount} success, ${errorCount} errors`,
  );

  return { successCount, errorCount };
}

/**
 * Recalculate rankings for a specific week (based on totalSum)
 */
async function recalculateRankings(weekNumber, year) {
  logger.info(`Recalculating rankings for week ${weekNumber}, year ${year}`);

  // Get all stats for this week
  const allStats = await WeeklyStats.find({
    year,
    weekNumber,
  }).populate("student classes");

  // 1. Calculate school rankings (by totalSum - higher is better)
  const sortedSchool = [...allStats].sort((a, b) => {
    return b.simpleStats.totalSum - a.simpleStats.totalSum;
  });

  sortedSchool.forEach((stat, index) => {
    stat.rankings.schoolRank = index + 1;
    stat.rankings.schoolTotalStudents = allStats.length;
  });

  // 2. Calculate class rankings for each class
  // Group students by class
  const classBuckets = new Map();
  allStats.forEach((stat) => {
    if (stat.classes && stat.classes.length > 0) {
      stat.classes.forEach((cls) => {
        const classId = cls._id.toString();
        if (!classBuckets.has(classId)) {
          classBuckets.set(classId, []);
        }
        classBuckets.get(classId).push(stat);
      });
    }
  });

  // Calculate rankings for each class
  classBuckets.forEach((statsInClass, classId) => {
    // Sort by totalSum
    const sorted = [...statsInClass].sort((a, b) => {
      return b.simpleStats.totalSum - a.simpleStats.totalSum;
    });

    // Assign ranks
    sorted.forEach((stat, index) => {
      const rank = index + 1;
      const totalStudents = statsInClass.length;

      // Find if this student already has classRanks array
      if (!stat.rankings.classRanks) {
        stat.rankings.classRanks = [];
      }

      // Find or create classRank entry for this class
      const existingRankIndex = stat.rankings.classRanks.findIndex(
        (cr) => cr.class.toString() === classId,
      );

      if (existingRankIndex >= 0) {
        // Update existing
        stat.rankings.classRanks[existingRankIndex].rank = rank;
        stat.rankings.classRanks[existingRankIndex].totalStudents =
          totalStudents;
      } else {
        // Add new
        stat.rankings.classRanks.push({
          class: classId,
          rank: rank,
          totalStudents: totalStudents,
        });
      }
    });
  });

  // Save all stats
  await Promise.all(allStats.map((stat) => stat.save()));

  logger.info(`Rankings recalculated for ${allStats.length} students`);
}

/**
 * Helper: Get week range by week number and year
 */
function getWeekRangeByNumber(weekNumber, year) {
  // Calculate Monday of the week
  const firstDayOfYear = new Date(year, 0, 1);
  const daysOffset = (weekNumber - 1) * 7;
  const targetDate = new Date(
    firstDayOfYear.getTime() + daysOffset * 24 * 60 * 60 * 1000,
  );

  // Find Monday
  const dayOfWeek = targetDate.getDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(targetDate);
  monday.setDate(targetDate.getDate() - daysFromMonday);
  monday.setHours(0, 0, 0, 0);

  // Saturday end
  const saturday = new Date(monday);
  saturday.setDate(monday.getDate() + 5);
  saturday.setHours(23, 59, 59, 999);

  return {
    weekStart: monday,
    weekEnd: saturday,
  };
}

module.exports = {
  updateWeeklyStatsForGrade,
  createWeeklyStatsForStudent,
  recalculateWeeklyStats,
  generateWeeklyStatsForAllStudents,
  recalculateRankings,
};
