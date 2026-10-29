const prisma = require("../config/prisma");
const { NotFoundError } = require("../utils/errors");
const {
  getWeekRangeForDate,
  getStatisticsPeriodRange,
} = require("../helpers/statistics.helpers");

/**
 * Statistika xizmati — REYTINGLAR TO'G'RIDAN-TO'G'RI `grade` JADVALIDAN hisoblanadi.
 *
 * Eski (MongoDB davridan qolgan) denormalizatsiyalangan `WeeklyStats` jadvaliga
 * tayanmaydi: u faqat baho olgan/generatsiya qilingan o'quvchilar uchun qator
 * saqlagani sabab reytinglarda hamma o'quvchi ko'rinmasdi. Endi barcha faol
 * o'quvchidan boshlanadi (baho yo'q bo'lsa 0) va har doim aniq bo'ladi.
 *
 * ⚠️ DAVR — BITTA JOYDA (`getStatisticsPeriodRange`): "kunlik / haftalik /
 * oylik" ning farqi faqat SANA ORALIG'IDA, qolgan hamma narsa (saralash,
 * teng ballga teng o'rin, sahifalash, fan kesimi) AYNI. Ikkinchi hisob
 * yozilsa, jadvaldagi ball bilan oynadagi ball bir-biriga mos kelmay
 * qolardi.
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

async function buildRankingRows(studentWhere, periodKey, dateKey) {
  const range = getStatisticsPeriodRange(periodKey, dateKey);
  const students = await prisma.user.findMany({
    where: { role: "student", isActive: true, isArchived: false, ...studentWhere },
    select: STUDENT_SELECT,
  });

  const sums = await aggregateGradesByStudent(
    range.start,
    range.end,
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
  return { range, rows: assignRanks(rows) };
}

/**
 * Javobga tushadigan davr maydonlari.
 *
 * ⚠️ `weekStart`/`weekEnd`/`weekNumber`/`year` SAQLANADI — student paneli,
 * bot va monitor shu nomlarni o'qiydi. Yangi `period*` maydonlari ularning
 * ustiga qo'shiladi, o'rniga EMAS.
 */
function periodFields(range) {
  return {
    period: range.period,
    periodTitle: range.title,
    // Normallashtirilgan ankor kuni ("YYYY-MM-DD") va davr bugunni
    // qamraydimi — panel tanlagichi va "keyingi" tugmasi shundan o'qiydi
    periodDate: range.date,
    isCurrentPeriod: range.isCurrent,
    periodStart: range.start,
    periodEnd: range.end,
    weekStart: range.weekStart,
    weekEnd: range.weekEnd,
    weekNumber: range.weekNumber,
    year: range.year,
  };
}

// ─────────────────────────────────────────────
// MAKTAB REYTINGI
// ─────────────────────────────────────────────

async function getSchoolRankings({ page = 1, limit = 20, period, date } = {}) {
  const pageNum = parseInt(page, 10) || 1;
  const limitNum = parseInt(limit, 10) || 20;

  const { range, rows } = await buildRankingRows({}, period, date);
  const { items, pagination } = paginate(rows, pageNum, limitNum);

  return {
    data: {
      ...periodFields(range),
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
// ENG YUQORI / ENG PAST (bosh sahifadagi karta)
// ─────────────────────────────────────────────

/** Har ro'yxatda nechta qator (biznes qarori: 5 ta). */
const TOP_LIMIT = 5;

/**
 * ⚠️ CHEGARA SO'ROVDAN KELADI, LEKIN CHEKLANADI: `?limit=100000` butun
 * maktabni kartaning javobiga tiqib qo'yardi. Ro'yxatning o'zi uchun
 * Statistika bo'limi bor.
 */
const MAX_TOP_LIMIT = 20;

const resolveTopLimit = (value) => {
  const size = parseInt(value, 10);
  if (!Number.isFinite(size) || size < 1) return TOP_LIMIT;
  return Math.min(size, MAX_TOP_LIMIT);
};

/**
 * BITTA SARALANGAN RO'YXATDAN IKKI UCHI.
 *
 * ⚠️ IKKINCHI REYTING QURILMAYDI: qatorlar `buildRankingRows` dan
 * saralangan va O'RIN berilgan holda keladi, bu yerda faqat KESIB
 * olinadi. Aks holda bosh sahifada bir o'quvchi, Statistika bo'limida
 * boshqasi birinchi turardi.
 *
 * ⚠️ ENG PAST — FAQAT BALL TO'PLAGANLAR ORASIDAN (biznes qarori,
 * 2026-10-29). Ro'yxatning aynan oxirida davr ichida UMUMAN baho
 * olmaganlar (0 ball) turadi va ular teng bo'lgani uchun tartib alifboga
 * tushadi: "eng past 5 ta" degan yozuv ostida tasodifiy beshta ism
 * chiqardi. Ball to'plamaganlar soni (`unscored`) YO'QOLMAYDI — u
 * javobda alohida qaytadi va kartada aytiladi.
 *
 * ⚠️ IKKI RO'YXAT KESISHMAYDI (`buildRankings` bilan AYNI qoida): ballga
 * ega o'quvchi kam bo'lsa ro'yxatlar yarmidan bo'linadi (5 ta → 3 + 2),
 * aks holda bitta bola ham "eng yuqori", ham "eng past" bo'lib turardi.
 *
 * @param {Array} rows - `buildRankingRows` qatorlari (saralangan, `rank` bilan)
 * @param {number} [limit]
 */
function splitTopAndBottom(rows, limit = TOP_LIMIT) {
  const scored = rows.filter((row) => row.totalSum > 0);

  const bestCount = Math.min(limit, Math.ceil(scored.length / 2));
  const worstCount = Math.min(limit, Math.floor(scored.length / 2));

  const project = (row, place) => ({
    place,
    rank: row.rank,
    student: row.student,
    classes: row.classes,
    totalSum: row.totalSum,
    totalGrades: row.totalGrades,
    ...(row._branch ? { _branch: row._branch } : {}),
  });

  return {
    totalStudents: rows.length,
    scored: scored.length,
    // "Bu davrda baho olmaganlar" — kartadagi izoh shundan
    unscored: rows.length - scored.length,
    // Eng yuqorida `place` — HAQIQIY o'rin (teng ball → teng o'rin)
    best: scored.slice(0, bestCount).map((row) => project(row, row.rank)),
    // Eng pastda esa 1 = eng past (kartadagi yorliq ham shunday aytadi)
    worst: scored
      .slice(scored.length - worstCount)
      .reverse()
      .map((row, index) => project(row, index + 1)),
  };
}

/**
 * Bosh sahifadagi "O'quvchilar natijalari" kartasi.
 *
 * ⚠️ Statistika bo'limi bilan AYNI DVIGATEL (`buildRankingRows`) va AYNI
 * davr kalitlari: karta "haftalik" deganda bo'lim ham aynan o'sha
 * haftani ko'rsatadi, "Batafsil" esa o'sha davr bilan ochiladi.
 */
async function getSchoolTop({ period, date, limit } = {}) {
  const { range, rows } = await buildRankingRows({}, period, date);

  return {
    ...periodFields(range),
    isNetwork: false,
    partial: [],
    ...splitTopAndBottom(rows, resolveTopLimit(limit)),
  };
}

// ─────────────────────────────────────────────
// SINF REYTINGI
// ─────────────────────────────────────────────

async function getClassRankings(
  classId,
  { page = 1, limit = 20, period, date } = {},
) {
  const pageNum = parseInt(page, 10) || 1;
  const limitNum = parseInt(limit, 10) || 20;

  const classDoc = await prisma.class.findUnique({ where: { id: classId } });
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");

  const { range, rows } = await buildRankingRows(
    { classes: { some: { classId } } },
    period,
    date,
  );
  const { items, pagination } = paginate(rows, pageNum, limitNum);

  return {
    data: {
      class: classDoc,
      ...periodFields(range),
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

// Bitta o'quvchi + davr oralig'i bo'yicha reytingni (>ball) hisoblaydi
async function computeRankAmong(studentWhere, studentSum, rangeStart, rangeEnd) {
  const ids = (
    await prisma.user.findMany({
      where: { role: "student", isActive: true, isArchived: false, ...studentWhere },
      select: { id: true },
    })
  ).map((s) => s.id);

  const sums = await aggregateGradesByStudent(rangeStart, rangeEnd, ids);
  let greater = 0;
  for (const { totalSum } of sums.values()) {
    if (totalSum > studentSum) greater++;
  }
  return { rank: greater + 1, totalStudents: ids.length };
}

// ─────────────────────────────────────────────
// O'QUVCHINING JORIY HAFTA STATISTIKASI
// ─────────────────────────────────────────────

async function getStudentWeekly(studentId, periodKey, dateKey) {
  const range = getStatisticsPeriodRange(periodKey, dateKey);

  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { ...STUDENT_SELECT, role: true },
  });
  if (!student || student.role !== "student") {
    throw new NotFoundError("O'quvchi topilmadi");
  }

  const classes = (student.classes || []).map((uc) => uc.class);

  const grades = await prisma.grade.findMany({
    where: { studentId, date: { gte: range.start, lte: range.end } },
    select: { grade: true, subjectId: true, teacherId: true },
  });
  const { subjectById, teacherById } = await loadGradeRefMaps(grades);
  const simpleStats = buildSimpleStatsFromGrades(grades, subjectById, teacherById);

  const schoolRanking = await computeRankAmong(
    {},
    simpleStats.totalSum,
    range.start,
    range.end,
  );

  const classRanks = [];
  for (const cls of classes) {
    const cr = await computeRankAmong(
      { classes: { some: { classId: cls.id } } },
      simpleStats.totalSum,
      range.start,
      range.end,
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
    ...periodFields(range),
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

async function getSchoolRankingRows(periodKey, dateKey) {
  const { range, rows } = await buildRankingRows({}, periodKey, dateKey);
  return { range, rows };
}

async function getClassRankingRows(classId, periodKey, dateKey) {
  const classDoc = await prisma.class.findUnique({ where: { id: classId } });
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");
  const { range, rows } = await buildRankingRows(
    { classes: { some: { classId } } },
    periodKey,
    dateKey,
  );
  return { classDoc, range, rows };
}

module.exports = {
  getSchoolRankings,
  getSchoolTop,
  getClassRankings,
  getStudentWeekly,
  getStudentAllWeeks,
  getSchoolRankingRows,
  getClassRankingRows,
  // pastki funksiyalar (test/qayta ishlatish uchun). ⚠️ Tarmoq reytingi
  // (`statisticsNetwork.service.js`) shu yerdan oziqlanadi — u ikkinchi
  // quruvchi YOZMAYDI, faqat filiallar qatorini birlashtirib QAYTA
  // saralaydi.
  buildRankingRows,
  byScoreThenName,
  assignRanks,
  paginate,
  periodFields,
  aggregateGradesByStudent,
  splitTopAndBottom,
  resolveTopLimit,
  TOP_LIMIT,
  MAX_TOP_LIMIT,
};
