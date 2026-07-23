const prisma = require("../config/prisma");
const {
  getCurrentWeekRange,
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
  let weeklyStats = await prisma.weeklyStats.findUnique({
    where: {
      student_year_weekNumber: {
        student: gradeDoc.studentId,
        year,
        weekNumber,
      },
    },
  });

  if (!weeklyStats) {
    // Create new stats if doesn't exist
    weeklyStats = await createWeeklyStatsForStudent(
      gradeDoc.studentId,
      weekNumber,
      year,
    );
  } else {
    // Recalculate stats
    await recalculateWeeklyStats(weeklyStats);
  }

  // Note: Rankings are now calculated on-demand (lazy calculation)
  // No need to recalculate all rankings here - much faster!
}

/**
 * Recalculate the current week's stats for a single student.
 * Use when something other than a grade changes the inputs - e.g. the
 * student is moved to a different class mid-week. Without this, the weekly
 * stats only refresh on the next grade event.
 */
async function recalculateCurrentWeekForStudent(studentId) {
  const { weekNumber, year } = getCurrentWeekRange();

  const weeklyStats = await prisma.weeklyStats.findUnique({
    where: {
      student_year_weekNumber: {
        student: studentId,
        year,
        weekNumber,
      },
    },
  });

  if (weeklyStats) {
    await recalculateWeeklyStats(weeklyStats);
  } else {
    await createWeeklyStatsForStudent(studentId, weekNumber, year);
  }
}

/**
 * Create WeeklyStats for a student
 */
async function createWeeklyStatsForStudent(studentId, weekNumber, year) {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    include: { classes: true },
  });

  if (
    !student ||
    student.role !== "student" ||
    !student.classes ||
    student.classes.length === 0
  ) {
    throw new Error("Invalid student or no class assigned");
  }

  const classIds = student.classes.map((c) => c.classId);

  // Get week range
  const { weekStart, weekEnd } = getWeekRangeByNumber(weekNumber, year);

  // Create empty stats (persist row + classes junction)
  const weeklyStats = await prisma.weeklyStats.create({
    data: {
      student: studentId,
      classes: {
        create: classIds.map((classId) => ({ classId })),
      },
      weekStart,
      weekEnd,
      weekNumber,
      year,
      simpleStats: {
        subjects: [],
        totalSum: 0,
        totalGrades: 0,
      },
      totalSum: 0,
      totalGrades: 0,
      classRanks: [],
      schoolRank: null,
      schoolTotalStudents: null,
    },
  });

  // Calculate initial stats
  return recalculateWeeklyStats(weeklyStats);
}

/**
 * Recalculate all statistics for a WeeklyStats document
 */
async function recalculateWeeklyStats(weeklyStats) {
  const { weekStart, weekEnd } = weeklyStats;

  // Keep the class snapshot in sync with the student's CURRENT classes.
  // Stats are per-student per-week; a mid-week class change must not drop
  // the student from their new class's rankings.
  const student = await prisma.user.findUnique({
    where: { id: weeklyStats.student },
    include: { classes: true },
  });
  if (student && student.classes && student.classes.length > 0) {
    const classIds = student.classes.map((c) => c.classId);
    await prisma.weeklyStatsClass.deleteMany({
      where: { weeklyStatsId: weeklyStats.id },
    });
    await prisma.weeklyStatsClass.createMany({
      data: classIds.map((classId) => ({
        weeklyStatsId: weeklyStats.id,
        classId,
      })),
    });
  }

  // 1. Get all grades for this week (regardless of class).
  // Weekly stats reflect every grade the student earned during the week;
  // the class is just a label and must not filter the calculation.
  const grades = await prisma.grade.findMany({
    where: {
      studentId: weeklyStats.student,
      date: { gte: weekStart, lte: weekEnd },
    },
  });

  if (grades.length === 0) {
    // No grades this week - save empty stats
    return prisma.weeklyStats.update({
      where: { id: weeklyStats.id },
      data: {
        simpleStats: {
          subjects: [],
          totalSum: 0,
          totalGrades: 0,
        },
        totalSum: 0,
        totalGrades: 0,
        lastUpdated: new Date(),
      },
    });
  }

  // subject/teacher — scalar ref (relation YO'Q), qo'lda yuklaymiz
  const subjectIds = [...new Set(grades.map((g) => g.subjectId).filter(Boolean))];
  const teacherIds = [...new Set(grades.map((g) => g.teacherId).filter(Boolean))];
  const [subjects, teachers] = await Promise.all([
    subjectIds.length
      ? prisma.subject.findMany({ where: { id: { in: subjectIds } } })
      : [],
    teacherIds.length
      ? prisma.user.findMany({
          where: { id: { in: teacherIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [],
  ]);
  const subjectMapById = new Map(subjects.map((s) => [s.id, s]));
  const teacherMapById = new Map(teachers.map((t) => [t.id, t]));

  // 2. Group by subject
  const subjectMap = new Map();
  grades.forEach((g) => {
    const subject = subjectMapById.get(g.subjectId);
    const teacher = teacherMapById.get(g.teacherId);
    const subjectId = String(g.subjectId);
    if (!subjectMap.has(subjectId)) {
      subjectMap.set(subjectId, {
        subject,
        grades: [],
        teachers: new Set(),
      });
    }
    const stats = subjectMap.get(subjectId);
    stats.grades.push(g.grade);
    stats.teachers.add(
      `${teacher?.firstName || ""} ${teacher?.lastName || ""}`,
    );
  });

  // 3. Calculate sum-based stats
  const simpleSubjects = [];
  subjectMap.forEach((stats, subjectId) => {
    const sum = calculateTotalSum(stats.grades.map((g) => ({ grade: g })));
    simpleSubjects.push({
      subject: stats.subject?.id ?? subjectId,
      grades: stats.grades,
      sum: sum,
      count: stats.grades.length,
      teachers: Array.from(stats.teachers),
    });
  });

  const totalSum = calculateTotalSum(grades);

  // 4. Update WeeklyStats document
  return prisma.weeklyStats.update({
    where: { id: weeklyStats.id },
    data: {
      simpleStats: {
        subjects: simpleSubjects,
        totalSum: totalSum,
        totalGrades: grades.length,
      },
      totalSum: totalSum,
      totalGrades: grades.length,
      lastUpdated: new Date(),
    },
  });
}

/**
 * Generate WeeklyStats for all students (cron job)
 */
async function generateWeeklyStatsForAllStudents(weekNumber, year) {
  logger.info(
    `Starting weekly stats generation for week ${weekNumber}, year ${year}`,
  );

  const students = await prisma.user.findMany({
    where: {
      role: "student",
      isActive: true,
    },
    include: { classes: true },
  });

  let successCount = 0;
  let errorCount = 0;

  for (const student of students) {
    try {
      if (!student.classes || student.classes.length === 0) {
        continue; // Skip students without class
      }

      await createWeeklyStatsForStudent(student.id, weekNumber, year);
      successCount++;
    } catch (error) {
      logger.error(`Error generating stats for student ${student.id}:`, error);
      errorCount++;
    }
  }

  logger.info(
    `Weekly stats generation completed: ${successCount} success, ${errorCount} errors`,
  );

  return { successCount, errorCount };
}

/**
 * Calculate individual student's rank in a class (lazy calculation)
 * Uses COUNT query for optimal performance
 */
async function calculateStudentRankInClass(
  studentId,
  classId,
  weekNumber,
  year,
) {
  // 1. Get student's totalSum
  const studentStats = await prisma.weeklyStats.findFirst({
    where: {
      student: studentId,
      classes: { some: { classId } },
      weekNumber,
      year,
    },
  });

  if (!studentStats) {
    return null;
  }

  const studentTotalSum = studentStats.totalSum;

  // 2. Count students with higher totalSum
  const higherCount = await prisma.weeklyStats.count({
    where: {
      classes: { some: { classId } },
      weekNumber,
      year,
      totalSum: { gt: studentTotalSum },
    },
  });

  // 3. Rank = higher count + 1
  const rank = higherCount + 1;

  // 4. Total students in class
  const totalStudents = await prisma.weeklyStats.count({
    where: {
      classes: { some: { classId } },
      weekNumber,
      year,
    },
  });

  return {
    rank,
    totalStudents,
    totalSum: studentTotalSum,
    totalGrades: studentStats.totalGrades,
  };
}

/**
 * Calculate individual student's rank in school (lazy calculation)
 */
async function calculateStudentRankInSchool(studentId, weekNumber, year) {
  // 1. Get student's totalSum
  const studentStats = await prisma.weeklyStats.findFirst({
    where: {
      student: studentId,
      weekNumber,
      year,
    },
  });

  if (!studentStats) {
    return null;
  }

  const studentTotalSum = studentStats.totalSum;

  // 2. Count students with higher totalSum
  const higherCount = await prisma.weeklyStats.count({
    where: {
      weekNumber,
      year,
      totalSum: { gt: studentTotalSum },
    },
  });

  // 3. Rank = higher count + 1
  const rank = higherCount + 1;

  // 4. Total students in school
  const totalStudents = await prisma.weeklyStats.count({
    where: {
      weekNumber,
      year,
    },
  });

  return {
    rank,
    totalStudents,
    totalSum: studentTotalSum,
    totalGrades: studentStats.totalGrades,
  };
}

/**
 * DEPRECATED: Old pre-calculation method - kept for cron job only
 * Recalculate rankings for a specific week (based on totalSum)
 */
async function recalculateRankings(weekNumber, year) {
  logger.info(`Recalculating rankings for week ${weekNumber}, year ${year}`);

  // Get all stats for this week (classes junction bilan)
  const allStats = await prisma.weeklyStats.findMany({
    where: {
      year,
      weekNumber,
    },
    include: { classes: true },
  });

  // Ranking maydonlarini xotirada tayyorlaymiz (schoolRank/schoolTotalStudents/classRanks)
  const updates = new Map();
  allStats.forEach((stat) => {
    updates.set(stat.id, {
      schoolRank: null,
      schoolTotalStudents: null,
      classRanks: [],
    });
  });

  // 1. Calculate school rankings (by totalSum - higher is better)
  const sortedSchool = [...allStats].sort((a, b) => {
    return b.totalSum - a.totalSum;
  });

  sortedSchool.forEach((stat, index) => {
    const u = updates.get(stat.id);
    u.schoolRank = index + 1;
    u.schoolTotalStudents = allStats.length;
  });

  // 2. Calculate class rankings for each class
  // Group students by class
  const classBuckets = new Map();
  allStats.forEach((stat) => {
    if (stat.classes && stat.classes.length > 0) {
      stat.classes.forEach((cls) => {
        const classId = String(cls.classId);
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
      return b.totalSum - a.totalSum;
    });

    // Assign ranks
    sorted.forEach((stat, index) => {
      const rank = index + 1;
      const totalStudents = statsInClass.length;

      const u = updates.get(stat.id);

      // Find or create classRank entry for this class
      const existingRankIndex = u.classRanks.findIndex(
        (cr) => String(cr.class) === classId,
      );

      if (existingRankIndex >= 0) {
        // Update existing
        u.classRanks[existingRankIndex].rank = rank;
        u.classRanks[existingRankIndex].totalStudents = totalStudents;
      } else {
        // Add new
        u.classRanks.push({
          class: classId,
          rank: rank,
          totalStudents: totalStudents,
        });
      }
    });
  });

  // Save all stats
  await Promise.all(
    allStats.map((stat) => {
      const u = updates.get(stat.id);
      return prisma.weeklyStats.update({
        where: { id: stat.id },
        data: {
          schoolRank: u.schoolRank,
          schoolTotalStudents: u.schoolTotalStudents,
          classRanks: u.classRanks,
        },
      });
    }),
  );

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
  recalculateCurrentWeekForStudent,
  createWeeklyStatsForStudent,
  recalculateWeeklyStats,
  generateWeeklyStatsForAllStudents,
  recalculateRankings, // Kept for cron job
  calculateStudentRankInClass, // NEW: Lazy calculation
  calculateStudentRankInSchool, // NEW: Lazy calculation
};
