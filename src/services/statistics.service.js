const prisma = require("../config/prisma");
const { NotFoundError } = require("../utils/errors");
const {
  getCurrentWeekRange,
  getWeekRangeForDate,
} = require("../helpers/statistics.helpers");

/**
 * Statistika xizmati — REYTINGLAR TO'G'RIDAN-TO'G'RI `grade` JADVALIDAN hisoblanadi.
 *
 * Eski (MongoDB davridan qolgan) denormalizatsiyalangan `WeeklyStats` jadvaliga
 * tayanmaydi: u faqat baho olgan/generatsiya qilingan o'quvchilar uchun qator
 * saqlagani sabab reytinglarda hamma o'quvchi ko'rinmasdi. Endi barcha faol
 * o'quvchidan boshlanadi (baho yo'q bo'lsa 0) va har doim aniq bo'ladi.
 */

// Reytinglarda ko'rsatiladigan o'quvchi maydonlari (ikkala panel ham shularni kutadi)
const STUDENT_SELECT = {
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
  classes: { include: { class: { select: { id: true, name: true } } } },
};

function projectStudent(s) {
  return {
    id: s.id,
    firstName: s.firstName,
    lastName: s.lastName,
    fullName: s.fullName,
    displayName: s.displayName || null,
    nameColor: s.nameColor || null,
    premium: {
      isActive: s.premiumIsActive || false,
      expiresAt: s.premiumExpiresAt || null,
    },
    emojiBadgeId: s.emojiBadgeId || null,
    profilePictureUrl: s.profileImage?.variants?.sm?.url || null,
  };
}

/**
 * Berilgan sana oralig'ida har bir o'quvchining baho yig'indisi/sonini
 * bitta GROUP BY so'rov bilan hisoblaydi.
 * @returns {Promise<Map<string,{totalSum:number,totalGrades:number}>>}
 */
async function aggregateGradesByStudent(weekStart, weekEnd, studentIds) {
  const where = { date: { gte: weekStart, lte: weekEnd } };
  if (studentIds) {
    if (studentIds.length === 0) return new Map();
    where.studentId = { in: studentIds };
  }

  const rows = await prisma.grade.groupBy({
    by: ["studentId"],
    where,
    _sum: { grade: true },
    _count: { _all: true },
  });

  return new Map(
    rows.map((r) => [
      r.studentId,
      { totalSum: r._sum.grade || 0, totalGrades: r._count._all || 0 },
    ]),
  );
}

// Ball bo'yicha kamayish, teng bo'lsa ism bo'yicha (deterministik tartib)
function byScoreThenName(a, b) {
  if (b.totalSum !== a.totalSum) return b.totalSum - a.totalSum;
  return (a.student.fullName || "").localeCompare(b.student.fullName || "");
}

// Saralangan qatorlarga musobaqa reytingini beradi (teng ball → teng o'rin: 1,2,2,4)
function assignRanks(sorted) {
  let prevSum = null;
  let prevRank = 0;
  return sorted.map((row, i) => {
    const rank = i > 0 && row.totalSum === prevSum ? prevRank : i + 1;
    prevSum = row.totalSum;
    prevRank = rank;
    return { ...row, rank };
  });
}

function paginate(rows, pageNum, limitNum) {
  const totalItems = rows.length;
  const totalPages = Math.ceil(totalItems / limitNum) || 0;
  const skip = (pageNum - 1) * limitNum;
  return {
    items: rows.slice(skip, skip + limitNum),
    pagination: {
      page: pageNum,
      limit: limitNum,
      totalPages,
      totalItems,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1,
    },
  };
}

// ─────────────────────────────────────────────
// REYTING QATORLARINI QURISH (to'liq, saralangan, reyting berilgan)
// ─────────────────────────────────────────────

async function buildRankingRows(studentWhere) {
  const week = getCurrentWeekRange();
  const students = await prisma.user.findMany({
    where: { role: "student", isActive: true, ...studentWhere },
    select: STUDENT_SELECT,
  });

  const sums = await aggregateGradesByStudent(
    week.weekStart,
    week.weekEnd,
    students.map((s) => s.id),
  );

  const rows = students.map((s) => {
    const agg = sums.get(s.id) || { totalSum: 0, totalGrades: 0 };
    return {
      student: projectStudent(s),
      classes: (s.classes || []).map((uc) => uc.class),
      totalSum: agg.totalSum,
      totalGrades: agg.totalGrades,
    };
  });

  rows.sort(byScoreThenName);
  return { week, rows: assignRanks(rows) };
}

// ─────────────────────────────────────────────
// MAKTAB REYTINGI
// ─────────────────────────────────────────────

async function getSchoolRankings({ page = 1, limit = 20 } = {}) {
  const pageNum = parseInt(page, 10) || 1;
  const limitNum = parseInt(limit, 10) || 20;

  const { week, rows } = await buildRankingRows({});
  const { items, pagination } = paginate(rows, pageNum, limitNum);

  return {
    data: {
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      weekNumber: week.weekNumber,
      year: week.year,
      totalStudents: rows.length,
      rankings: items.map((r) => ({
        rank: r.rank,
        student: r.student,
        classes: r.classes,
        totalSum: r.totalSum,
        totalGrades: r.totalGrades,
      })),
    },
    pagination,
  };
}

// ─────────────────────────────────────────────
// SINF REYTINGI
// ─────────────────────────────────────────────

async function getClassRankings(classId, { page = 1, limit = 20 } = {}) {
  const pageNum = parseInt(page, 10) || 1;
  const limitNum = parseInt(limit, 10) || 20;

  const classDoc = await prisma.class.findUnique({ where: { id: classId } });
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");

  const { week, rows } = await buildRankingRows({
    classes: { some: { classId } },
  });
  const { items, pagination } = paginate(rows, pageNum, limitNum);

  return {
    data: {
      class: classDoc,
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      weekNumber: week.weekNumber,
      year: week.year,
      totalStudents: rows.length,
      rankings: items.map((r) => ({
        rank: r.rank,
        student: r.student,
        totalSum: r.totalSum,
        totalGrades: r.totalGrades,
      })),
    },
    pagination,
  };
}

// ─────────────────────────────────────────────
// FAN BO'YICHA TAFSILOT (simpleStats)
// ─────────────────────────────────────────────

// Baholar to'plamidan fan bo'yicha simpleStats quradi (joriy hafta + tarix uchun umumiy)
function buildSimpleStatsFromGrades(grades, subjectById, teacherById) {
  if (!grades.length) return { subjects: [], totalSum: 0, totalGrades: 0 };

  const bySubject = new Map();
  for (const g of grades) {
    const key = String(g.subjectId);
    if (!bySubject.has(key)) {
      bySubject.set(key, {
        subject: subjectById.get(g.subjectId) || {
          id: g.subjectId,
          name: "Noma'lum fan",
        },
        grades: [],
        teachers: new Set(),
      });
    }
    const entry = bySubject.get(key);
    entry.grades.push(g.grade);
    const t = teacherById.get(g.teacherId);
    if (t) entry.teachers.add(`${t.firstName || ""} ${t.lastName || ""}`.trim());
  }

  const subjects = [];
  let totalSum = 0;
  let totalGrades = 0;
  for (const entry of bySubject.values()) {
    const sum = entry.grades.reduce((a, b) => a + b, 0);
    subjects.push({
      subject: { id: entry.subject.id, name: entry.subject.name },
      grades: entry.grades,
      sum,
      count: entry.grades.length,
      teachers: [...entry.teachers],
    });
    totalSum += sum;
    totalGrades += entry.grades.length;
  }

  return { subjects, totalSum, totalGrades };
}

// subject/teacher — scalar ref (relation YO'Q); baholardagi id'larni bir so'rovda yuklaydi
async function loadGradeRefMaps(grades) {
  const subjectIds = [...new Set(grades.map((g) => g.subjectId).filter(Boolean))];
  const teacherIds = [...new Set(grades.map((g) => g.teacherId).filter(Boolean))];
  const [subjects, teachers] = await Promise.all([
    subjectIds.length
      ? prisma.subject.findMany({
          where: { id: { in: subjectIds } },
          select: { id: true, name: true },
        })
      : [],
    teacherIds.length
      ? prisma.user.findMany({
          where: { id: { in: teacherIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [],
  ]);
  return {
    subjectById: new Map(subjects.map((s) => [s.id, s])),
    teacherById: new Map(teachers.map((t) => [t.id, t])),
  };
}

// Bitta o'quvchi + hafta oralig'i bo'yicha reytingni (>ball) hisoblaydi
async function computeRankAmong(studentWhere, studentSum, weekStart, weekEnd) {
  const ids = (
    await prisma.user.findMany({
      where: { role: "student", isActive: true, ...studentWhere },
      select: { id: true },
    })
  ).map((s) => s.id);

  const sums = await aggregateGradesByStudent(weekStart, weekEnd, ids);
  let greater = 0;
  for (const { totalSum } of sums.values()) {
    if (totalSum > studentSum) greater++;
  }
  return { rank: greater + 1, totalStudents: ids.length };
}

// ─────────────────────────────────────────────
// O'QUVCHINING JORIY HAFTA STATISTIKASI
// ─────────────────────────────────────────────

async function getStudentWeekly(studentId) {
  const { weekStart, weekEnd, weekNumber, year } = getCurrentWeekRange();

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { ...STUDENT_SELECT, role: true },
  });
  if (!student || student.role !== "student") {
    throw new NotFoundError("O'quvchi topilmadi");
  }

  const classes = (student.classes || []).map((uc) => uc.class);

  const grades = await prisma.grade.findMany({
    where: { studentId, date: { gte: weekStart, lte: weekEnd } },
    select: { grade: true, subjectId: true, teacherId: true },
  });
  const { subjectById, teacherById } = await loadGradeRefMaps(grades);
  const simpleStats = buildSimpleStatsFromGrades(grades, subjectById, teacherById);

  const schoolRanking = await computeRankAmong(
    {},
    simpleStats.totalSum,
    weekStart,
    weekEnd,
  );

  const classRanks = [];
  for (const cls of classes) {
    const cr = await computeRankAmong(
      { classes: { some: { classId: cls.id } } },
      simpleStats.totalSum,
      weekStart,
      weekEnd,
    );
    classRanks.push({
      class: cls,
      rank: cr.rank,
      totalStudents: cr.totalStudents,
    });
  }

  return {
    student: projectStudent(student),
    class: classes[0] || null,
    classes,
    weekStart,
    weekEnd,
    weekNumber,
    year,
    simpleStats,
    rankings: {
      schoolRank: schoolRanking.rank,
      schoolTotalStudents: schoolRanking.totalStudents,
      classRanks,
    },
  };
}

// ─────────────────────────────────────────────
// O'QUVCHINING BARCHA HAFTALARI (tarix — grafik uchun)
// ─────────────────────────────────────────────

async function getStudentAllWeeks(studentId) {
  const grades = await prisma.grade.findMany({
    where: { studentId },
    select: { grade: true, subjectId: true, teacherId: true, date: true },
    orderBy: { date: "asc" },
  });
  if (!grades.length) return [];

  const { subjectById, teacherById } = await loadGradeRefMaps(grades);

  // Haftalar bo'yicha guruhlash
  const weeks = new Map();
  for (const g of grades) {
    const range = getWeekRangeForDate(g.date);
    const key = `${range.year}-${range.weekNumber}`;
    if (!weeks.has(key)) weeks.set(key, { range, grades: [] });
    weeks.get(key).grades.push(g);
  }

  return [...weeks.values()]
    .sort((a, b) => a.range.weekStart - b.range.weekStart)
    .map(({ range, grades: weekGrades }) => ({
      weekStart: range.weekStart,
      weekEnd: range.weekEnd,
      weekNumber: range.weekNumber,
      year: range.year,
      simpleStats: buildSimpleStatsFromGrades(
        weekGrades,
        subjectById,
        teacherById,
      ),
    }));
}

// ─────────────────────────────────────────────
// EXPORT UCHUN (barcha qatorlar, sahifalanmagan)
// ─────────────────────────────────────────────

async function getSchoolRankingRows() {
  const { rows } = await buildRankingRows({});
  return rows;
}

async function getClassRankingRows(classId) {
  const classDoc = await prisma.class.findUnique({ where: { id: classId } });
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");
  const { rows } = await buildRankingRows({ classes: { some: { classId } } });
  return { classDoc, rows };
}

module.exports = {
  getSchoolRankings,
  getClassRankings,
  getStudentWeekly,
  getStudentAllWeeks,
  getSchoolRankingRows,
  getClassRankingRows,
  // pastki funksiyalar (test/qayta ishlatish uchun)
  aggregateGradesByStudent,
};
