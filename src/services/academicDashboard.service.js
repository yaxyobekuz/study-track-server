/**
 * TA'LIM DASHBOARDI — bitta ekranda butun maktabning o'quv manzarasi.
 *
 * `financeDashboard.service.js` ning akademik ko'zgusi. Har bir tushuncha
 * o'z juftiga ega: u yerda pul harakati, bu yerda baho va davomat.
 *
 * ⚠️ BU FAYL HECH NARSA YOZMAYDI. Faqat mavjud jadvallarni yig'adi:
 *   baho          → `Grade`
 *   davomat       → `StudentAttendance` (o'quvchi) va `Attendance` (xodim)
 *   o'quvchi soni → `StudentEnrollment` (davr — yagona haqiqat manbai)
 *   topshiriq     → `Task`
 *   yutuq         → `StudentAchievement`
 *   to'garak      → `Club` / `ClubMember`
 *
 * ⚠️ O'QUVCHI SONI `User` DAN OLINMAYDI. "O'quvchi o'qiyaptimi" degan
 * savolga faqat o'qish davri javob beradi (`education.md` §4): `isActive`
 * va `isArchived` — login bayroqlari. Ro'yxatdan sanasak, o'tgan oyning
 * soni bugungi arxivlash bilan o'zgarib ketardi.
 *
 * ⚠️ SANA — KUN KOORDINATASI. Baho, davomat va o'qish davri UTC yarim
 * tunida yotadi, shuning uchun oraliq `monthStartDate/monthEndDate` bilan
 * quriladi, Toshkent ofseti bilan emas (`finance.md` §0).
 */

const prisma = require("../config/prisma");
const {
  currentMonthKey,
  parseOptionalMonthKey,
  formatMonthKey,
  formatMonthShort,
  prevMonth,
  monthStartDate,
  monthEndDate,
} = require("../helpers/month.helpers");
const { BadRequestError } = require("../utils/errors");
const { loadTargetMap } = require("./academicTarget.service");
const {
  ACHIEVEMENT_LEVEL_LABELS,
  ACHIEVEMENT_PLACE_LABELS,
} = require("./achievement.service");

/** Davomat dinamikasi diagrammasidagi oylar soni (dizayndagi "12 oylik"). */
const DEFAULT_TREND_MONTHS = 12;
const MAX_TREND_MONTHS = 36;

/** Fanlar diagrammasidagi ustunlar soni — undan ortig'i o'qi sig'maydi. */
const SUBJECT_LIMIT = 8;

/** "Fanlar bo'yicha top o'quvchi" jadvalidagi qatorlar soni. */
const TOP_STUDENT_LIMIT = 5;

/**
 * Top o'quvchi ro'yxatiga tushish uchun eng kam baho soni.
 *
 * ⚠️ Bittagina "5" olgan o'quvchi o'rtachasi 5.00 bilan ro'yxat boshiga
 * chiqib qolardi va butun jadval ishonchsiz bo'lardi.
 */
const TOP_STUDENT_MIN_GRADES = 3;

/** O'qituvchilar KPI jadvalidagi qatorlar soni. */
const TEACHER_LIMIT = 10;

/** So'nggi yutuqlar ro'yxatidagi qatorlar soni. */
const RECENT_ACHIEVEMENT_LIMIT = 4;

/**
 * Sinf darajalari — dizayndagi kesim.
 *
 * ⚠️ Daraja sinf NOMIDAN olinadi ("9-A" → 9), chunki `Class` da bosqich
 * ustuni yo'q va uni qo'shish butun sinflar bo'limini qayta yozishni
 * talab qilardi. Raqami o'qilmagan sinf ("Bitiruvchilar") "Boshqa"
 * guruhiga tushadi — jimgina yo'qolib ketmasligi uchun.
 */
const CLASS_LEVELS = [
  { key: "1-4", label: "1-4 sinflar", from: 1, to: 4 },
  { key: "5-6", label: "5-6 sinflar", from: 5, to: 6 },
  { key: "7-8", label: "7-8 sinflar", from: 7, to: 8 },
  { key: "9-11", label: "9-11 sinflar", from: 9, to: 11 },
];

/** Davomatda "keldi" deb sanaladigan holatlar (`education.md` §6). */
const PRESENT_STATUSES = new Set(["present", "late"]);

/** Bajarilgan deb sanaladigan topshiriq holati. */
const DONE_TASK_STATUS = "completed";

// ─────────────────────────────────────────────
// Umumiy yordamchilar
// ─────────────────────────────────────────────

/** Oyning kun oralig'i — `@db.Date` va UTC yarim tundagi qiymatlar uchun. */
const monthDayRange = (month) => ({
  gte: monthStartDate(month),
  lte: new Date(monthEndDate(month).getTime() + 86400000 - 1),
});

/** Foiz: 0 maxrajda `null` (nol bilan bo'lish "0%" emas, "ma'lumot yo'q"). */
const rate = (part, total, digits = 1) =>
  total > 0 ? Number(((part / total) * 100).toFixed(digits)) : null;

/** O'rtacha baho: 2 xonali. */
const average = (sum, count) => (count > 0 ? Number((sum / count).toFixed(2)) : null);

/** Ikki qiymat farqi — foizli ko'rsatkichda PUNKT, qolganida foiz. */
const changeOf = (value, previous, { unit }) => {
  if (value == null || previous == null) return null;

  if (unit === "percent" || unit === "grade") {
    return Number((value - previous).toFixed(unit === "grade" ? 2 : 1));
  }

  if (previous === 0) return null; // noldan o'sishning foizi yo'q
  return Number((((value - previous) / previous) * 100).toFixed(1));
};

/** Foizli va ballik ko'rsatkichda o'zgarish PUNKTDA o'lchanadi. */
const changeUnitOf = (unit) => (unit === "count" ? "percent" : "point");

/** Sinf nomidan bosqich raqami: "9-A" → 9, "Bitiruvchilar" → null. */
const levelOfClassName = (name) => {
  const match = String(name ?? "").match(/\d+/);
  if (!match) return null;

  const value = Number(match[0]);
  return Number.isFinite(value) && value > 0 && value <= 11 ? value : null;
};

/** Bosqich raqamidan guruh kaliti. */
const levelKeyOf = (level) => {
  if (level == null) return "other";
  const group = CLASS_LEVELS.find((row) => level >= row.from && level <= row.to);
  return group ? group.key : "other";
};

/** Ism-familiya — bo'sh maydonlar bilan ham toza chiqadi. */
const fullName = (user) =>
  [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() || "Noma'lum";

// ─────────────────────────────────────────────
// Manba so'rovlari
// ─────────────────────────────────────────────

/**
 * Bir oyning baholari — sinf, fan, o'qituvchi kesimida bitta so'rovda.
 *
 * ⚠️ `groupBy` UCH KALIT BO'YICHA: keyin JS'da istalgan kesimga
 * yig'iladi. Har kesim uchun alohida so'rov yuborilsa, bitta ekran
 * baholar jadvaliga besh marta borardi.
 */
const loadGradeFacts = async (month) => {
  const [groups, distribution] = await Promise.all([
    prisma.grade.groupBy({
      by: ["classId", "subjectId", "teacherId"],
      where: { date: monthDayRange(month) },
      _sum: { grade: true },
      _count: { _all: true },
    }),
    prisma.grade.groupBy({
      by: ["grade"],
      where: { date: monthDayRange(month) },
      _count: { _all: true },
    }),
  ]);

  // "A'lo va yaxshi" — 4 va 5. Uni guruhlangan so'rovdan chiqarib
  // bo'lmaydi (baho ustuni guruh kalitida yo'q), shuning uchun taqsimot
  // so'rovidan olinadi: ikkalasi ham bitta oyning bir xil qatorlarini
  // sanaydi, ya'ni maxraj bir xil.
  let count = 0;
  let good = 0;
  let sum = 0;

  for (const row of distribution) {
    count += row._count._all;
    sum += row.grade * row._count._all;
    if (row.grade >= 4) good += row._count._all;
  }

  return {
    groups: groups.map((row) => ({
      classId: row.classId,
      subjectId: row.subjectId,
      teacherId: row.teacherId,
      sum: row._sum.grade ?? 0,
      count: row._count._all,
    })),
    total: { sum, count, good },
    distribution: distribution.map((row) => ({
      grade: row.grade,
      count: row._count._all,
    })),
  };
};

/** Bir oyning o'quvchi davomati — sinf kesimida. */
const loadAttendanceFacts = async (month) => {
  const rows = await prisma.studentAttendance.groupBy({
    by: ["classId", "status"],
    where: { date: monthDayRange(month) },
    _count: { _all: true },
  });

  const byClass = new Map();
  let total = 0;
  let present = 0;

  for (const row of rows) {
    const bucket = byClass.get(row.classId) ?? { total: 0, present: 0 };

    bucket.total += row._count._all;
    total += row._count._all;

    if (PRESENT_STATUSES.has(row.status)) {
      bucket.present += row._count._all;
      present += row._count._all;
    }

    byClass.set(row.classId, bucket);
  }

  return { byClass, total, present };
};

/**
 * Shu oyda o'qigan o'quvchilar — davr bo'yicha.
 *
 * ⚠️ Davr oy bilan KESISHSA yetarli: 20-sentabrda kelgan o'quvchi ham,
 * 3-sentabrda ketgani ham sentabrda o'qigan. `startDate <= oy oxiri` va
 * `endDate` yo'q yoki `>= oy boshi`.
 */
const loadEnrollmentFacts = async (month) => {
  const range = monthDayRange(month);

  const [studying, admissions] = await Promise.all([
    prisma.studentEnrollment.findMany({
      where: {
        startDate: { lte: range.lte },
        OR: [{ endDate: null }, { endDate: { gte: range.gte } }],
      },
      select: { studentId: true },
      distinct: ["studentId"],
    }),
    prisma.studentEnrollment.count({ where: { startDate: range } }),
  ]);

  return { studentIds: studying.map((row) => row.studentId), admissions };
};

/**
 * Topshiriq intizomi — muddati SHU OYDA tugagan topshiriqlar.
 *
 * ⚠️ Yaratilgan sanasi bo'yicha emas: martda berilgan, muddati aprelda
 * tugaydigan topshiriq mart hisobotida "bajarilmagan" bo'lib turardi.
 */
const loadTaskFacts = async (month) => {
  const rows = await prisma.task.groupBy({
    by: ["assignee", "status"],
    where: { dueDate: monthDayRange(month) },
    _count: { _all: true },
  });

  const byAssignee = new Map();
  let total = 0;
  let done = 0;

  for (const row of rows) {
    const bucket = byAssignee.get(row.assignee) ?? { total: 0, done: 0 };

    bucket.total += row._count._all;
    total += row._count._all;

    if (row.status === DONE_TASK_STATUS) {
      bucket.done += row._count._all;
      done += row._count._all;
    }

    byAssignee.set(row.assignee, bucket);
  }

  return { byAssignee, total, done };
};

/** Xodim davomati — o'qituvchilar KPI jadvalidagi ustun. */
const loadStaffAttendance = async (month) => {
  const rows = await prisma.attendance.groupBy({
    by: ["userId", "status"],
    where: { date: monthDayRange(month) },
    _count: { _all: true },
  });

  const byUser = new Map();

  for (const row of rows) {
    const bucket = byUser.get(row.userId) ?? { total: 0, present: 0 };

    bucket.total += row._count._all;
    if (PRESENT_STATUSES.has(row.status)) bucket.present += row._count._all;

    byUser.set(row.userId, bucket);
  }

  return byUser;
};

// ─────────────────────────────────────────────
// Bloklar
// ─────────────────────────────────────────────

/**
 * KPI kartalari — oltita savolga bir qarashda javob.
 *
 * Har kartada IKKI taqqoslash: REJA (o'quv bo'limi nima kutgan) va
 * O'TGAN OY (haqiqat qayoqqa ketyapti) — moliya dashboardidagi bilan
 * bir xil shakl, chunki ikkala ekran bir xil o'qiladi.
 */
const buildKpi = ({ current, previous, targets }) => {
  const card = (key, unit, value, previousValue, sub) => {
    const plan = targets.get(key);
    const planNumber = plan == null ? null : Number(plan.toString());

    return {
      key,
      unit,
      value,
      previous: previousValue,
      change: changeOf(value, previousValue, { unit }),
      changeUnit: changeUnitOf(unit),
      plan: planNumber,
      // Bajarilish foizi — reja nol bo'lsa hisoblanmaydi (Infinity
      // har qanday natijani "yashil" qilib qo'yardi)
      planRate:
        planNumber == null || planNumber === 0 || value == null
          ? null
          : Number(((value / planNumber) * 100).toFixed(1)),
      sub,
    };
  };

  return {
    students: card("students", "count", current.students, previous.students, "Shu oyda o'qiyapti"),
    averageGrade: card(
      "averageGrade",
      "grade",
      current.averageGrade,
      previous.averageGrade,
      `${current.gradeCount} ta baho`,
    ),
    qualityRate: card(
      "qualityRate",
      "percent",
      current.qualityRate,
      previous.qualityRate,
      "4 va 5 baholar ulushi",
    ),
    attendanceRate: card(
      "attendanceRate",
      "percent",
      current.attendanceRate,
      previous.attendanceRate,
      `${current.attendanceTotal} ta belgi`,
    ),
    taskCompletion: card(
      "taskCompletion",
      "percent",
      current.taskCompletion,
      previous.taskCompletion,
      `${current.taskTotal} ta topshiriq`,
    ),
    achievements: card(
      "achievements",
      "count",
      current.achievements,
      previous.achievements,
      "Olimpiada va musobaqalar",
    ),
  };
};

/** Fanlar kesimi — o'rtacha baho va o'tgan oy bilan farqi. */
const buildSubjects = ({ current, previous, subjects }) => {
  const fold = (facts) => {
    const map = new Map();

    for (const row of facts.groups) {
      const bucket = map.get(row.subjectId) ?? { sum: 0, count: 0 };
      bucket.sum += row.sum;
      bucket.count += row.count;
      map.set(row.subjectId, bucket);
    }

    return map;
  };

  const currentMap = fold(current.grades);
  const previousMap = fold(previous.grades);

  return [...currentMap.entries()]
    .map(([subjectId, bucket]) => {
      const before = previousMap.get(subjectId);

      return {
        subjectId,
        name: subjects.get(subjectId) ?? "Noma'lum fan",
        average: average(bucket.sum, bucket.count),
        previousAverage: before ? average(before.sum, before.count) : null,
        gradeCount: bucket.count,
      };
    })
    // Ko'p baho qo'yilgan fan ishonchliroq — diagrammaga o'shalar tushadi
    .sort((a, b) => b.gradeCount - a.gradeCount)
    .slice(0, SUBJECT_LIMIT)
    .sort((a, b) => (b.average ?? 0) - (a.average ?? 0));
};

/** Sinflar jadvali — o'quvchi soni, o'rtacha baho, sifat, davomat. */
const buildClasses = ({ grades, attendance, classes, studentsByClass }) => {
  const byClass = new Map();

  for (const row of grades.groups) {
    const bucket = byClass.get(row.classId) ?? { sum: 0, count: 0 };
    bucket.sum += row.sum;
    bucket.count += row.count;
    byClass.set(row.classId, bucket);
  }

  return [...classes.entries()]
    .map(([classId, name]) => {
      const grade = byClass.get(classId);
      const visits = attendance.byClass.get(classId);

      return {
        classId,
        name,
        level: levelOfClassName(name),
        studentCount: studentsByClass.get(classId) ?? 0,
        average: grade ? average(grade.sum, grade.count) : null,
        gradeCount: grade?.count ?? 0,
        attendanceRate: visits ? rate(visits.present, visits.total) : null,
      };
    })
    .filter((row) => row.studentCount > 0 || row.gradeCount > 0)
    .sort((a, b) => {
      // Bosqich bo'yicha, ichida nom bo'yicha — "10-A" "9-A" dan keyin
      // turishi uchun (matn saralashda "10" < "9" bo'lib qolardi)
      if (a.level != null && b.level != null && a.level !== b.level) return a.level - b.level;
      if (a.level == null) return 1;
      if (b.level == null) return -1;
      return a.name.localeCompare(b.name, "uz");
    });
};

/** Sinf darajalari kesimi — dizayndagi "1-4 / 5-6 / 7-8 / 9-11" jadvali. */
const buildLevels = ({ grades, attendance, classes, studentsByClass }) => {
  const levelOfClass = new Map(
    [...classes.entries()].map(([classId, name]) => [classId, levelKeyOf(levelOfClassName(name))]),
  );

  const buckets = new Map();
  const bucketOf = (key) => {
    if (!buckets.has(key)) {
      buckets.set(key, { sum: 0, count: 0, present: 0, total: 0, students: 0 });
    }
    return buckets.get(key);
  };

  for (const [classId, key] of levelOfClass) {
    bucketOf(key).students += studentsByClass.get(classId) ?? 0;
  }

  for (const row of grades.groups) {
    const bucket = bucketOf(levelOfClass.get(row.classId) ?? "other");
    bucket.sum += row.sum;
    bucket.count += row.count;
  }

  for (const [classId, visits] of attendance.byClass) {
    const bucket = bucketOf(levelOfClass.get(classId) ?? "other");
    bucket.present += visits.present;
    bucket.total += visits.total;
  }

  const rows = [...CLASS_LEVELS, { key: "other", label: "Boshqa sinflar" }]
    .map((level) => {
      const bucket = buckets.get(level.key);
      if (!bucket) return null;

      return {
        key: level.key,
        label: level.label,
        studentCount: bucket.students,
        average: average(bucket.sum, bucket.count),
        attendanceRate: rate(bucket.present, bucket.total),
      };
    })
    .filter((row) => row && (row.studentCount > 0 || row.average != null));

  return rows;
};

/**
 * Baholar taqsimoti — 5 dan 1 gacha, ulushi bilan.
 *
 * Qo'yilmagan baholar KIRMAYDI: taqsimot faqat qo'yilganini bo'ladi.
 */
const buildDistribution = (grades) => {
  const total = grades.total.count;
  const byGrade = new Map(grades.distribution.map((row) => [row.grade, row.count]));

  const LABELS = {
    5: "A'lo",
    4: "Yaxshi",
    3: "Qoniqarli",
    2: "Qoniqarsiz",
    1: "Yomon",
  };

  return [5, 4, 3, 2, 1].map((grade) => {
    const count = byGrade.get(grade) ?? 0;

    return {
      grade,
      label: LABELS[grade],
      count,
      share: rate(count, total),
    };
  });
};

/**
 * 12 oylik davomat dinamikasi.
 *
 * ⚠️ BITTA SO'ROV: `date` va `status` bo'yicha guruhlanadi, oylarga JS'da
 * bo'linadi. Har oy uchun alohida so'rov yuborilsa, bitta diagramma
 * uchun 12 marta bazaga borilardi.
 */
const buildAttendanceTrend = async (month, trendMonths) => {
  const months = [];
  let cursor = month;
  for (let i = 0; i < trendMonths; i += 1) {
    months.unshift(cursor);
    cursor = prevMonth(cursor);
  }

  const rows = await prisma.studentAttendance.groupBy({
    by: ["date", "status"],
    where: {
      date: {
        gte: monthStartDate(months[0]),
        lte: new Date(monthEndDate(month).getTime() + 86400000 - 1),
      },
    },
    _count: { _all: true },
  });

  const buckets = new Map(months.map((key) => [key, { present: 0, total: 0 }]));

  for (const row of rows) {
    // Kun UTC yarim tunida yotadi — oy raqami `getUTC*` bilan olinadi
    const key = row.date.getUTCFullYear() * 100 + row.date.getUTCMonth() + 1;
    const bucket = buckets.get(key);
    if (!bucket) continue;

    bucket.total += row._count._all;
    if (PRESENT_STATUSES.has(row.status)) bucket.present += row._count._all;
  }

  return months.map((key) => {
    const bucket = buckets.get(key);

    return {
      month: key,
      monthLabel: formatMonthKey(key),
      monthShort: formatMonthShort(key),
      rate: rate(bucket.present, bucket.total),
      present: bucket.present,
      total: bucket.total,
    };
  });
};

/**
 * Fanlar bo'yicha eng yaxshi o'quvchi.
 *
 * ⚠️ Eng ko'p baho qo'yilgan fanlar olinadi va HAR FANDAN BITTA o'quvchi
 * — dizayndagi jadval aynan shunday o'qiladi ("Matematika — Abdullaev").
 * Bitta fandan besh o'quvchi chiqsa, jadval "eng kuchli sinf" ro'yxatiga
 * aylanib qolardi.
 */
const buildTopStudents = async ({ month, subjects, subjectOrder }) => {
  const targetSubjects = subjectOrder.slice(0, TOP_STUDENT_LIMIT);
  if (targetSubjects.length === 0) return [];

  const rows = await prisma.grade.groupBy({
    by: ["subjectId", "studentId"],
    where: { date: monthDayRange(month), subjectId: { in: targetSubjects } },
    _sum: { grade: true },
    _count: { _all: true },
  });

  const best = new Map();

  for (const row of rows) {
    if (row._count._all < TOP_STUDENT_MIN_GRADES) continue;

    const value = average(row._sum.grade ?? 0, row._count._all);
    const current = best.get(row.subjectId);

    // Teng o'rtachada ko'proq baho olgani yutadi — u ishonchliroq
    if (
      !current ||
      value > current.average ||
      (value === current.average && row._count._all > current.gradeCount)
    ) {
      best.set(row.subjectId, {
        subjectId: row.subjectId,
        studentId: row.studentId,
        average: value,
        gradeCount: row._count._all,
      });
    }
  }

  const winners = targetSubjects.map((subjectId) => best.get(subjectId)).filter(Boolean);
  if (winners.length === 0) return [];

  const students = await prisma.user.findMany({
    where: { id: { in: winners.map((row) => row.studentId) } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      classes: { select: { class: { select: { name: true } } } },
    },
  });
  const byId = new Map(students.map((row) => [row.id, row]));

  return winners.map((row) => {
    const student = byId.get(row.studentId);

    return {
      subjectId: row.subjectId,
      subjectName: subjects.get(row.subjectId) ?? "Noma'lum fan",
      studentId: row.studentId,
      studentName: fullName(student),
      className: student?.classes?.[0]?.class?.name ?? "—",
      average: row.average,
      gradeCount: row.gradeCount,
    };
  });
};

/**
 * O'QITUVCHILAR SAMARADORLIGI (KPI).
 *
 * Uch ustundan bitta ball: o'rtacha baho, o'z davomati, topshiriq
 * intizomi. ⚠️ Vaznlar KODDA turadi va ATAYLAB o'zgarmas: sozlamaga
 * chiqarilsa, "ballim past chiqdi" degan har bir suhbat vaznlarni
 * o'zgartirish bilan tugardi va o'tgan oylar bilan taqqoslab bo'lmasdi.
 *
 * ⚠️ Baho ustuni "o'qituvchi qanchalik yaxshi baho qo'yadi" degani EMAS,
 * "uning darsidagi o'rtacha natija" degani. Shuning uchun u yagona
 * ko'rsatkich sifatida ishlatilmaydi — uchtasining yig'indisi.
 */
const buildTeachers = async ({ grades, tasks, staffAttendance, subjects }) => {
  const byTeacher = new Map();

  for (const row of grades.groups) {
    const bucket = byTeacher.get(row.teacherId) ?? { sum: 0, count: 0, subjects: new Set() };
    bucket.sum += row.sum;
    bucket.count += row.count;
    bucket.subjects.add(row.subjectId);
    byTeacher.set(row.teacherId, bucket);
  }

  if (byTeacher.size === 0) return [];

  const teachers = await prisma.user.findMany({
    where: { id: { in: [...byTeacher.keys()] } },
    select: { id: true, firstName: true, lastName: true, isArchived: true },
  });
  const byId = new Map(teachers.map((row) => [row.id, row]));

  return [...byTeacher.entries()]
    .map(([teacherId, bucket]) => {
      const teacher = byId.get(teacherId);
      const visits = staffAttendance.get(teacherId);
      const task = tasks.byAssignee.get(teacherId);

      const averageGrade = average(bucket.sum, bucket.count);
      const attendanceRate = visits ? rate(visits.present, visits.total) : null;
      const taskRate = task ? rate(task.done, task.total) : null;

      // ⚠️ Yo'q ustun 0 SANALMAYDI — u ballni pastga tortib, davomati
      // yuritilmagan o'qituvchini "yomon ishlagan" qilib ko'rsatardi.
      // Mavjud ustunlar o'z vazni bilan qayta normallashtiriladi.
      const parts = [
        averageGrade != null ? { weight: 0.5, value: (averageGrade / 5) * 100 } : null,
        attendanceRate != null ? { weight: 0.3, value: attendanceRate } : null,
        taskRate != null ? { weight: 0.2, value: taskRate } : null,
      ].filter(Boolean);

      const weight = parts.reduce((acc, part) => acc + part.weight, 0);
      const score =
        weight > 0
          ? Number(
              (parts.reduce((acc, part) => acc + part.weight * part.value, 0) / weight).toFixed(1),
            )
          : null;

      return {
        teacherId,
        name: fullName(teacher),
        isArchived: Boolean(teacher?.isArchived),
        subjectNames: [...bucket.subjects]
          .map((id) => subjects.get(id))
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b, "uz")),
        gradeCount: bucket.count,
        averageGrade,
        attendanceRate,
        taskRate,
        score,
      };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .slice(0, TEACHER_LIMIT);
};

/**
 * OLIMPIADA VA MUSOBAQALAR — daraja kesimida sanoq va so'nggi yutuqlar.
 *
 * ⚠️ Sanoq YUTUQ QATORLARI bo'yicha, o'quvchilar bo'yicha emas: bir
 * o'quvchi bir oyda ikkita olimpiadada g'olib bo'lsa, ikkalasi ham
 * ko'rinishi kerak.
 */
const buildAchievements = async ({ month, previousMonth }) => {
  const range = monthDayRange(month);

  const [levels, places, previousCount, recent] = await Promise.all([
    prisma.studentAchievement.groupBy({
      by: ["level"],
      where: { date: range },
      _count: { _all: true },
    }),
    prisma.studentAchievement.groupBy({
      by: ["place"],
      where: { date: range },
      _count: { _all: true },
    }),
    prisma.studentAchievement.count({ where: { date: monthDayRange(previousMonth) } }),
    prisma.studentAchievement.findMany({
      where: { date: range },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: RECENT_ACHIEVEMENT_LIMIT,
      select: {
        id: true,
        title: true,
        level: true,
        place: true,
        date: true,
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            classes: { select: { class: { select: { name: true } } } },
          },
        },
      },
    }),
  ]);

  const byLevel = new Map(levels.map((row) => [row.level, row._count._all]));
  const byPlace = new Map(places.map((row) => [row.place, row._count._all]));
  const total = levels.reduce((acc, row) => acc + row._count._all, 0);

  return {
    total,
    previousTotal: previousCount,
    change: changeOf(total, previousCount, { unit: "count" }),
    levels: Object.entries(ACHIEVEMENT_LEVEL_LABELS).map(([key, label]) => ({
      key,
      label,
      count: byLevel.get(key) ?? 0,
    })),
    places: Object.entries(ACHIEVEMENT_PLACE_LABELS).map(([key, label]) => ({
      key,
      label,
      count: byPlace.get(key) ?? 0,
    })),
    recent: recent.map((row) => ({
      id: row.id,
      title: row.title,
      level: row.level,
      levelLabel: ACHIEVEMENT_LEVEL_LABELS[row.level] ?? row.level,
      place: row.place,
      placeLabel: ACHIEVEMENT_PLACE_LABELS[row.place] ?? row.place,
      date: row.date,
      studentName: fullName(row.student),
      className: row.student?.classes?.[0]?.class?.name ?? "—",
    })),
  };
};

/**
 * TO'GARAK VA QO'SHIMCHA DARSLAR.
 *
 * ⚠️ "Qamrov" — o'quvchining NECHA FOIZI to'garakka qatnashadi. Dizaynda
 * bu o'rinda "qoniqish darajasi" turgan edi, lekin qoniqish so'rov
 * natijasi va tizimda so'rov yuritilmaydi. Bo'lmagan raqamni ko'rsatish
 * o'rniga o'lchanadigan ko'rsatkich qo'yildi.
 */
const buildClubs = async ({ month, previousMonth, studentCount }) => {
  // Shu oyda FAOL a'zolik: davr oy bilan kesishadi (`endDate` inklyuziv)
  const overlapping = (target) => {
    const range = monthDayRange(target);
    return {
      startDate: { lte: range.lte },
      OR: [{ endDate: null }, { endDate: { gte: range.gte } }],
    };
  };

  const [clubs, members, previousMembers, byClub] = await Promise.all([
    prisma.club.findMany({
      where: { isActive: true },
      select: { id: true, name: true, weeklyHours: true, subject: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.clubMember.findMany({
      where: overlapping(month),
      select: { studentId: true },
      distinct: ["studentId"],
    }),
    prisma.clubMember.findMany({
      where: overlapping(previousMonth),
      select: { studentId: true },
      distinct: ["studentId"],
    }),
    // ⚠️ To'garak kesimidagi sanoq ALOHIDA so'rov: `_count` ichida
    // filtr (`filteredRelationCount`) hamma Prisma qurilishida yoqilgan
    // emas va u yoqilmagan joyda so'rov jimgina butun a'zolikni sanardi.
    prisma.clubMember.groupBy({
      by: ["clubId"],
      where: overlapping(month),
      _count: { _all: true },
    }),
  ]);

  const countByClub = new Map(byClub.map((row) => [row.clubId, row._count._all]));
  const weeklyHours = clubs.reduce((acc, row) => acc + row.weeklyHours, 0);
  const studentsInClubs = members.length;

  return {
    clubCount: clubs.length,
    studentCount: studentsInClubs,
    previousStudentCount: previousMembers.length,
    studentChange: changeOf(studentsInClubs, previousMembers.length, { unit: "count" }),
    weeklyHours,
    coverage: rate(studentsInClubs, studentCount),
    items: clubs
      .map((row) => ({
        id: row.id,
        name: row.name,
        subjectName: row.subject?.name ?? null,
        weeklyHours: row.weeklyHours,
        memberCount: countByClub.get(row.id) ?? 0,
      }))
      .sort((a, b) => b.memberCount - a.memberCount)
      .slice(0, TOP_STUDENT_LIMIT),
  };
};

// ─────────────────────────────────────────────
// Asosiy kirish nuqtasi
// ─────────────────────────────────────────────

/**
 * Bir oyning butun akademik manzarasi.
 *
 * @param {{month?: *, compareMonth?: *, trendMonths?: *}} query
 */
const getOverview = async (query = {}) => {
  const month = parseOptionalMonthKey(query.month, "Oy") ?? currentMonthKey();
  const compareMonth = parseOptionalMonthKey(query.compareMonth, "Taqqoslash oyi") ?? prevMonth(month);

  if (compareMonth >= month) {
    throw new BadRequestError("Taqqoslash oyi tanlangan oydan oldin bo'lishi kerak");
  }

  const rawTrend = Number.parseInt(query.trendMonths, 10);
  const trendMonths =
    Number.isFinite(rawTrend) && rawTrend > 0
      ? Math.min(rawTrend, MAX_TREND_MONTHS)
      : DEFAULT_TREND_MONTHS;

  // ── Bir oyning barcha faktlari ────────────────────────────────────
  const [
    grades,
    attendance,
    enrollment,
    tasks,
    staffAttendance,
    previousGrades,
    previousAttendance,
    previousEnrollment,
    previousTasks,
    targets,
  ] = await Promise.all([
    loadGradeFacts(month),
    loadAttendanceFacts(month),
    loadEnrollmentFacts(month),
    loadTaskFacts(month),
    loadStaffAttendance(month),
    loadGradeFacts(compareMonth),
    loadAttendanceFacts(compareMonth),
    loadEnrollmentFacts(compareMonth),
    loadTaskFacts(compareMonth),
    loadTargetMap(month),
  ]);

  // ── Ma'lumotnomalar ───────────────────────────────────────────────
  const [subjectRows, classRows, studentClassRows, achievementCount, previousAchievementCount] =
    await Promise.all([
      prisma.subject.findMany({ select: { id: true, name: true } }),
      prisma.class.findMany({ select: { id: true, name: true } }),
      // Sinf bo'yicha o'quvchi soni — FAQAT shu oyda o'qiganlar
      enrollment.studentIds.length > 0
        ? prisma.userClass.groupBy({
            by: ["classId"],
            where: { userId: { in: enrollment.studentIds } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      prisma.studentAchievement.count({ where: { date: monthDayRange(month) } }),
      prisma.studentAchievement.count({ where: { date: monthDayRange(compareMonth) } }),
    ]);

  const subjects = new Map(subjectRows.map((row) => [row.id, row.name]));
  const classes = new Map(classRows.map((row) => [row.id, row.name]));
  const studentsByClass = new Map(studentClassRows.map((row) => [row.classId, row._count._all]));

  const summarize = (facts) => ({
    students: facts.enrollment.studentIds.length,
    admissions: facts.enrollment.admissions,
    averageGrade: average(facts.grades.total.sum, facts.grades.total.count),
    gradeCount: facts.grades.total.count,
    qualityRate: rate(facts.grades.total.good, facts.grades.total.count),
    attendanceRate: rate(facts.attendance.present, facts.attendance.total),
    attendanceTotal: facts.attendance.total,
    taskCompletion: rate(facts.tasks.done, facts.tasks.total),
    taskTotal: facts.tasks.total,
    achievements: facts.achievements,
  });

  const current = summarize({
    grades,
    attendance,
    enrollment,
    tasks,
    achievements: achievementCount,
  });
  const previous = summarize({
    grades: previousGrades,
    attendance: previousAttendance,
    enrollment: previousEnrollment,
    tasks: previousTasks,
    achievements: previousAchievementCount,
  });

  const subjectRowsBuilt = buildSubjects({
    current: { grades },
    previous: { grades: previousGrades },
    subjects,
  });

  // ── Og'irroq bloklar — yuqoridagi natijalarga tayanadi ────────────
  const [attendanceTrend, topStudents, teachers, achievements, clubs] = await Promise.all([
    buildAttendanceTrend(month, trendMonths),
    buildTopStudents({
      month,
      subjects,
      subjectOrder: subjectRowsBuilt.map((row) => row.subjectId),
    }),
    buildTeachers({ grades, tasks, staffAttendance, subjects }),
    buildAchievements({ month, previousMonth: compareMonth }),
    buildClubs({ month, previousMonth: compareMonth, studentCount: current.students }),
  ]);

  return {
    month,
    monthLabel: formatMonthKey(month),
    compareMonth,
    compareMonthLabel: formatMonthKey(compareMonth),

    kpi: buildKpi({ current, previous, targets }),
    subjects: subjectRowsBuilt,
    classes: buildClasses({ grades, attendance, classes, studentsByClass }),
    levels: buildLevels({ grades, attendance, classes, studentsByClass }),
    distribution: buildDistribution(grades),
    attendanceTrend,
    topStudents,
    teachers,
    achievements,
    clubs,

    totals: {
      students: current.students,
      admissions: current.admissions,
      gradeCount: current.gradeCount,
      attendanceMarks: current.attendanceTotal,
      taskTotal: current.taskTotal,
    },
  };
};

module.exports = {
  getOverview,
  // Sinov uchun ochiladi
  levelOfClassName,
  levelKeyOf,
  CLASS_LEVELS,
};
