const prisma = require("../config/prisma");
const {
  getTodayNormalized,
  getTodayAllRecords,
} = require("./attendance.service");
const { getLessonDayMap } = require("./schedule.service");
const { DAYS_UZ } = require("../utils/constants");

// Xavfli guruh chegaralari: 3+ kun ketma-ket yoki oyda 5+ kun qoldirish
const RISK_CONSECUTIVE_DAYS = 3;
const RISK_MONTHLY_MISSED_DAYS = 5;

// Davomat foizi: (keldi + kech keldi) / belgilangan yozuvlar
function attendancePercent({ present = 0, late = 0, absent = 0, excused = 0 }) {
  const total = present + late + absent + excused;
  if (!total) return null;
  return Math.round(((present + late) / total) * 1000) / 10;
}

function emptyCounts() {
  return { present: 0, late: 0, absent: 0, excused: 0, total: 0 };
}

// Yozuv sinfida o'sha kuni dars bormi? Dars bo'lmagan kun (masalan yakshanba
// yoki jadvalda darsi yo'q sinf kunlari) davomatsizlik hisobiga kirmaydi.
// (Yakshanba jadval enum'ida umuman yo'q - avtomatik chiqarib tashlanadi.)
function isLessonDayRecord(lessonDays, rec) {
  const dayName = DAYS_UZ[new Date(rec.date).getUTCDay()];
  return lessonDays.has(`${rec.classId}|${dayName}`);
}

// Yozuvlarni statuslar kesimida sanaydi
function countStatuses(records) {
  const counts = emptyCounts();
  for (const rec of records) {
    if (counts[rec.status] !== undefined) counts[rec.status]++;
    counts.total++;
  }
  return counts;
}

function monthRange(month, year) {
  const m = parseInt(month, 10);
  const y = parseInt(year, 10);
  return {
    m,
    y,
    start: new Date(Date.UTC(y, m - 1, 1)),
    end: new Date(Date.UTC(y, m, 1)),
  };
}

/**
 * O'quvchilar davomati bo'yicha to'liq hisobot.
 * Kunlik/haftalik ko'rsatkichlar joriy kunga, qolganlari tanlangan oyga tegishli.
 * @param {number|string} month - 1-12
 * @param {number|string} year
 */
async function getStudentReport(month, year) {
  const { m, y, start, end } = monthRange(month, year);

  const today = getTodayNormalized();
  // Hafta boshi (dushanba, Toshkent) - haftalik ko'rsatkich uchun
  const mondayOffset = (today.getUTCDay() + 6) % 7;
  const weekStart = new Date(today.getTime() - mondayOffset * 86400000);

  // Sinf+kun bo'yicha dars mavjudligi xaritasi (jadvaldan)
  const lessonDays = await getLessonDayMap();

  const [totalStudents, todayRecordsRaw, weekRecordsRaw, monthRecordsRaw] =
    await Promise.all([
      prisma.user.count({ where: { role: "student", isActive: true } }),
      prisma.studentAttendance.findMany({
        where: { date: today },
        select: { classId: true, status: true, date: true },
      }),
      prisma.studentAttendance.findMany({
        where: { date: { gte: weekStart, lte: today } },
        select: { classId: true, status: true, date: true },
      }),
      // Oy yozuvlari - barcha kesimlar uchun (sana bo'yicha tartiblangan)
      prisma.studentAttendance.findMany({
        where: { date: { gte: start, lt: end } },
        select: {
          studentId: true,
          classId: true,
          status: true,
          date: true,
          absenceReason: true,
        },
        orderBy: { date: "asc" },
      }),
    ]);

  // Dars bo'lmagan kun/sinf yozuvlarini barcha hisob-kitoblardan chiqarib tashlaymiz
  const todayRecords = todayRecordsRaw.filter((r) => isLessonDayRecord(lessonDays, r));
  const weekRecords = weekRecordsRaw.filter((r) => isLessonDayRecord(lessonDays, r));
  const monthRecords = monthRecordsRaw.filter((r) => isLessonDayRecord(lessonDays, r));

  const dailyCounts = countStatuses(todayRecords);
  const weeklyCounts = countStatuses(weekRecords);

  // ── Kun bo'yicha hisob ────────────────────────────────────────────
  const dayMap = new Map();
  for (const rec of monthRecords) {
    const key = new Date(rec.date).toISOString().slice(0, 10);
    if (!dayMap.has(key)) dayMap.set(key, { date: key, ...emptyCounts() });
    const day = dayMap.get(key);
    if (day[rec.status] !== undefined) day[rec.status]++;
    day.total++;
  }
  const byDay = [...dayMap.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, percent: attendancePercent(d) }));

  // Oylik umumiy yig'indi
  const monthlyCounts = emptyCounts();
  for (const d of byDay) {
    monthlyCounts.present += d.present;
    monthlyCounts.late += d.late;
    monthlyCounts.absent += d.absent;
    monthlyCounts.excused += d.excused;
    monthlyCounts.total += d.total;
  }

  // ── Hafta kunlari bo'yicha qoldirish trendi ───────────────────────
  // 1=Dushanba ... 6=Shanba, 0=Yakshanba
  const weekdayMap = new Map();
  for (const d of byDay) {
    const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay();
    if (!weekdayMap.has(dow)) {
      weekdayMap.set(dow, { dayOfWeek: dow, missed: 0, total: 0 });
    }
    const entry = weekdayMap.get(dow);
    entry.missed += d.absent + d.excused;
    entry.total += d.total;
  }
  const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];
  const weekdayTrend = weekdayOrder
    .filter((dow) => weekdayMap.has(dow))
    .map((dow) => {
      const entry = weekdayMap.get(dow);
      return {
        ...entry,
        percent: entry.total
          ? Math.round((entry.missed / entry.total) * 1000) / 10
          : null,
      };
    });

  // ── Sinf kesimi ───────────────────────────────────────────────────
  const classMap = new Map();
  for (const rec of monthRecords) {
    const key = String(rec.classId);
    if (!classMap.has(key)) classMap.set(key, { classId: key, ...emptyCounts() });
    const cls = classMap.get(key);
    if (cls[rec.status] !== undefined) cls[rec.status]++;
    cls.total++;
  }
  const classDocs = await prisma.class.findMany({
    where: { id: { in: [...classMap.keys()] } },
    select: { id: true, name: true },
  });
  const classNameMap = Object.fromEntries(
    classDocs.map((c) => [String(c.id), c.name]),
  );
  const byClass = [...classMap.values()]
    .map((c) => ({
      ...c,
      className: classNameMap[c.classId] || "-",
      percent: attendancePercent(c),
    }))
    .sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));

  // ── Xavfli guruh + eng yaxshi o'quvchilar (bir yurishda) ──────────
  // Eslatma: ketma-ketlik faqat belgilangan (yozuvi bor) kunlar bo'yicha hisoblanadi
  const perStudent = new Map();
  for (const rec of monthRecords) {
    const key = String(rec.studentId);
    if (!perStudent.has(key)) {
      perStudent.set(key, {
        studentId: key,
        present: 0,
        late: 0,
        absent: 0,
        excused: 0,
        total: 0,
        streak: 0,
        maxStreak: 0,
      });
    }
    const s = perStudent.get(key);
    if (s[rec.status] !== undefined) s[rec.status]++;
    s.total++;

    // Yozuvlar sana bo'yicha tartiblangan - qoldirish ketma-ketligini yuritamiz
    if (rec.status === "absent" || rec.status === "excused") {
      s.streak++;
      if (s.streak > s.maxStreak) s.maxStreak = s.streak;
    } else {
      s.streak = 0;
    }
  }

  const riskGroup = [...perStudent.values()]
    .map((s) => ({ ...s, missedTotal: s.absent + s.excused }))
    .filter(
      (s) =>
        s.maxStreak >= RISK_CONSECUTIVE_DAYS ||
        s.missedTotal >= RISK_MONTHLY_MISSED_DAYS,
    )
    .sort((a, b) => b.missedTotal - a.missedTotal)
    .slice(0, 100);

  // Eng yaxshilar: kamida yarim o'quv kunida belgilangan bo'lishi shart
  const minRecords = Math.max(1, Math.ceil(byDay.length / 2));
  const topStudents = [...perStudent.values()]
    .filter((s) => s.total >= minRecords)
    .map((s) => ({ ...s, percent: attendancePercent(s) }))
    .sort(
      (a, b) =>
        (b.percent ?? -1) - (a.percent ?? -1) ||
        a.late - b.late ||
        b.total - a.total,
    )
    .slice(0, 10);

  // Ism-familiya va sinf nomlari (faqat kerakli o'quvchilar uchun)
  const studentIds = [
    ...new Set([
      ...riskGroup.map((s) => s.studentId),
      ...topStudents.map((s) => s.studentId),
    ]),
  ];
  const studentsRaw = await prisma.user.findMany({
    where: { id: { in: studentIds } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      classes: { select: { class: { select: { id: true, name: true } } } },
    },
  });
  const students = studentsRaw.map((u) => ({
    ...u,
    classes: (u.classes || []).map((c) => c.class),
  }));
  const studentInfoMap = Object.fromEntries(
    students.map((u) => [
      String(u.id),
      {
        name: `${u.lastName || ""} ${u.firstName || ""}`.trim(),
        className: (u.classes || []).map((c) => c?.name).filter(Boolean).join(", ") || "-",
      },
    ]),
  );
  const attachStudentInfo = (s) => ({
    ...s,
    ...(studentInfoMap[s.studentId] || { name: "-", className: "-" }),
  });

  // ── Sabablar tahlili ──────────────────────────────────────────────
  const missedTotal = monthlyCounts.absent + monthlyCounts.excused;

  // "Sababli" yozuvlar kategoriya kesimida (null -> kategoriyasiz)
  const reasonCountMap = new Map();
  for (const rec of monthRecords) {
    if (rec.status !== "excused") continue;
    const key = rec.absenceReason ? String(rec.absenceReason) : null;
    reasonCountMap.set(key, (reasonCountMap.get(key) || 0) + 1);
  }

  const reasonIds = [...reasonCountMap.keys()].filter(Boolean);
  const reasonDocs = await prisma.absenceReason.findMany({
    where: { id: { in: reasonIds } },
    select: { id: true, title: true },
  });
  const reasonTitleMap = Object.fromEntries(
    reasonDocs.map((r) => [String(r.id), r.title]),
  );
  const categories = [...reasonCountMap.entries()]
    .map(([id, count]) => ({
      title: id ? reasonTitleMap[id] || "-" : "Kategoriyasiz",
      count,
      percent: missedTotal
        ? Math.round((count / missedTotal) * 1000) / 10
        : null,
    }))
    .sort((a, b) => b.count - a.count);

  const sharePercent = (count) =>
    missedTotal ? Math.round((count / missedTotal) * 1000) / 10 : null;

  return {
    month: m,
    year: y,
    totalStudents,
    overall: {
      daily: { ...dailyCounts, percent: attendancePercent(dailyCounts) },
      weekly: { ...weeklyCounts, percent: attendancePercent(weeklyCounts) },
      monthly: { ...monthlyCounts, percent: attendancePercent(monthlyCounts) },
    },
    byDay,
    byClass,
    weekdayTrend,
    riskGroup: riskGroup.map(attachStudentInfo),
    topStudents: topStudents.map(attachStudentInfo),
    reasons: {
      missedTotal,
      absentCount: monthlyCounts.absent,
      absentPercent: sharePercent(monthlyCounts.absent),
      excusedCount: monthlyCounts.excused,
      excusedPercent: sharePercent(monthlyCounts.excused),
      categories,
    },
    thresholds: {
      consecutiveDays: RISK_CONSECUTIVE_DAYS,
      monthlyMissedDays: RISK_MONTHLY_MISSED_DAYS,
    },
  };
}

/**
 * Xodimlar davomati bo'yicha HR hisobot.
 * Bugungi balans joriy kunga, qolganlari tanlangan oyga tegishli.
 * @param {number|string} month - 1-12
 * @param {number|string} year
 */
async function getStaffReport(month, year) {
  const { m, y, start, end } = monthRange(month, year);
  const today = getTodayNormalized();

  const [todayAll, monthRows, lateRows, timeRows, distinctDatesRaw, todayExcusedDocs] =
    await Promise.all([
      // Bugungi balans (mavjud xizmatdan qayta foydalanamiz)
      getTodayAllRecords(null, null),
      // Oy bo'yicha foydalanuvchi + status kesimida
      prisma.attendance.groupBy({
        by: ["userId", "status"],
        where: { date: { gte: start, lt: end } },
        _count: { _all: true },
      }),
      // Kechikishlar kesimi
      prisma.attendance.groupBy({
        by: ["userId"],
        where: { date: { gte: start, lt: end }, isLate: true },
        _count: { userId: true },
        _sum: { lateMinutes: true },
        _avg: { lateMinutes: true },
        orderBy: [
          { _count: { userId: "desc" } },
          { _sum: { lateMinutes: "desc" } },
        ],
        take: 20,
      }),
      // Ish vaqti (check-in/check-out to'liq kunlar) — hisoblanuvchi ayirma, raw SQL
      prisma.$queryRaw`
        SELECT user_id AS "userId",
               SUM(GREATEST(EXTRACT(EPOCH FROM (check_out - check_in)) * 1000, 0)) AS "totalMs",
               COUNT(*) AS "days"
        FROM attendances
        WHERE date >= ${start} AND date < ${end}
          AND check_in IS NOT NULL AND check_out IS NOT NULL
        GROUP BY user_id
        ORDER BY "totalMs" DESC
        LIMIT 100
      `,
      // Oy oralig'idagi noyob sanalar
      prisma.attendance.findMany({
        where: { date: { gte: start, lt: end } },
        distinct: ["date"],
        select: { date: true },
      }),
      // Bugun sababli kelmaganlar (sabab kategoriyasi bilan)
      prisma.attendance.findMany({
        where: { date: today, status: "excused" },
      }),
    ]);

  const distinctDates = distinctDatesRaw.map((r) => r.date);

  // Oy bo'yicha foydalanuvchi kesimida yig'ish
  const perUser = new Map();
  for (const row of monthRows) {
    const key = String(row.userId);
    if (!perUser.has(key)) {
      perUser.set(key, {
        userId: key,
        present: 0,
        late: 0,
        absent: 0,
        excused: 0,
        total: 0,
      });
    }
    const u = perUser.get(key);
    const count = row._count._all;
    if (u[row.status] !== undefined) u[row.status] = count;
    u.total += count;
  }

  const minRecords = Math.max(1, Math.ceil(distinctDates.length / 2));
  const topStaffRaw = [...perUser.values()]
    .filter((u) => u.total >= minRecords)
    .map((u) => ({ ...u, percent: attendancePercent(u) }))
    .sort(
      (a, b) =>
        (b.percent ?? -1) - (a.percent ?? -1) ||
        a.late - b.late ||
        b.total - a.total,
    )
    .slice(0, 10);

  // raw SQL natijalarini normalizatsiya (bigint -> number)
  const timeRowsNorm = timeRows.map((r) => ({
    userId: String(r.userId),
    totalMs: Number(r.totalMs) || 0,
    days: Number(r.days) || 0,
  }));

  // Ism/rol ma'lumotlari - barcha kerakli foydalanuvchilar uchun bitta so'rov
  const userIds = [
    ...new Set([
      ...lateRows.map((r) => String(r.userId)),
      ...timeRowsNorm.map((r) => r.userId),
      ...topStaffRaw.map((r) => r.userId),
    ]),
  ];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, firstName: true, lastName: true, role: true },
  });
  const userInfoMap = Object.fromEntries(
    users.map((u) => [
      String(u.id),
      {
        name: `${u.firstName || ""} ${u.lastName || ""}`.trim(),
        role: u.role,
      },
    ]),
  );
  // Student/owner yozuvlari (chekka holatlar) hisobotga kiritilmaydi
  const isStaff = (id) => {
    const info = userInfoMap[id];
    return info && info.role !== "student" && info.role !== "owner";
  };

  const punctuality = lateRows
    .filter((r) => isStaff(String(r.userId)))
    .map((r) => ({
      userId: String(r.userId),
      ...userInfoMap[String(r.userId)],
      lateCount: r._count.userId,
      totalLateMinutes: r._sum.lateMinutes || 0,
      avgLateMinutes: Math.round(r._avg.lateMinutes || 0),
    }));

  const timesheet = timeRowsNorm
    .filter((r) => isStaff(r.userId))
    .map((r) => ({
      userId: r.userId,
      ...userInfoMap[r.userId],
      days: r.days,
      totalMinutes: Math.round(r.totalMs / 60000),
      avgMinutesPerDay: r.days ? Math.round(r.totalMs / r.days / 60000) : 0,
    }));

  const topStaff = topStaffRaw
    .filter((r) => isStaff(r.userId))
    .map((r) => ({ ...r, ...userInfoMap[r.userId] }));

  // absenceReason — soft ref, qo'lda yuklaymiz
  const excusedUserIds = [
    ...new Set(todayExcusedDocs.map((d) => d.userId).filter(Boolean)),
  ];
  const excusedReasonIds = [
    ...new Set(todayExcusedDocs.map((d) => d.absenceReason).filter(Boolean)),
  ];
  const [excusedUsers, excusedReasons] = await Promise.all([
    excusedUserIds.length
      ? prisma.user.findMany({
          where: { id: { in: excusedUserIds } },
          select: { id: true, firstName: true, lastName: true, role: true },
        })
      : [],
    excusedReasonIds.length
      ? prisma.absenceReason.findMany({
          where: { id: { in: excusedReasonIds } },
          select: { id: true, title: true },
        })
      : [],
  ]);
  const excusedUserMap = new Map(excusedUsers.map((u) => [u.id, u]));
  const excusedReasonMap = new Map(excusedReasons.map((r) => [r.id, r]));

  const todayExcused = todayExcusedDocs
    .map((d) => ({ ...d, user: excusedUserMap.get(d.userId) || null }))
    .filter((d) => d.user)
    .map((d) => ({
      userId: String(d.user.id),
      name: `${d.user.firstName || ""} ${d.user.lastName || ""}`.trim(),
      role: d.user.role,
      reasonTitle: d.absenceReason
        ? excusedReasonMap.get(d.absenceReason)?.title || null
        : null,
      note: d.excuseReason || null,
    }));

  return {
    month: m,
    year: y,
    todayBalance: todayAll.summary,
    todayExcused,
    punctuality,
    timesheet,
    topStaff,
  };
}

module.exports = {
  getStudentReport,
  getStaffReport,
};
