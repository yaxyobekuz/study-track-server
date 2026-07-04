const StudentAttendance = require("../models/studentAttendance.model");
const Attendance = require("../models/attendance.model");
const AbsenceReason = require("../models/absenceReason.model");
const User = require("../models/user.model");
const Class = require("../models/class.model");
const {
  getTodayNormalized,
  getTodayAllRecords,
} = require("./attendance.service");

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

// Berilgan filtr bo'yicha o'quvchi davomatini statuslar kesimida sanaydi
async function countStudentStatuses(dateFilter) {
  const rows = await StudentAttendance.aggregate([
    { $match: { date: dateFilter } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  const counts = emptyCounts();
  for (const row of rows) {
    if (counts[row._id] !== undefined) counts[row._id] = row.count;
    counts.total += row.count;
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

  const [
    totalStudents,
    dailyCounts,
    weeklyCounts,
    byDayRows,
    byClassRows,
    excusedByReason,
    monthRecords,
  ] = await Promise.all([
    User.countDocuments({ role: "student", isActive: true }),
    countStudentStatuses(today),
    countStudentStatuses({ $gte: weekStart, $lte: today }),
    // Oy ichida kun + status kesimida
    StudentAttendance.aggregate([
      { $match: { date: { $gte: start, $lt: end } } },
      { $group: { _id: { date: "$date", status: "$status" }, count: { $sum: 1 } } },
    ]),
    // Sinf + status kesimida
    StudentAttendance.aggregate([
      { $match: { date: { $gte: start, $lt: end } } },
      { $group: { _id: { class: "$class", status: "$status" }, count: { $sum: 1 } } },
    ]),
    // "Sababli" yozuvlar kategoriya kesimida
    StudentAttendance.aggregate([
      { $match: { date: { $gte: start, $lt: end }, status: "excused" } },
      { $group: { _id: "$absenceReason", count: { $sum: 1 } } },
    ]),
    // Xavfli guruh va eng yaxshilar uchun xom yozuvlar (sana bo'yicha tartiblangan)
    StudentAttendance.find(
      { date: { $gte: start, $lt: end } },
      "student status date",
    )
      .sort({ date: 1 })
      .lean(),
  ]);

  // ── Kun bo'yicha hisob ────────────────────────────────────────────
  const dayMap = new Map();
  for (const row of byDayRows) {
    const key = new Date(row._id.date).toISOString().slice(0, 10);
    if (!dayMap.has(key)) dayMap.set(key, { date: key, ...emptyCounts() });
    const day = dayMap.get(key);
    if (day[row._id.status] !== undefined) day[row._id.status] = row.count;
    day.total += row.count;
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
  for (const row of byClassRows) {
    const key = String(row._id.class);
    if (!classMap.has(key)) classMap.set(key, { classId: key, ...emptyCounts() });
    const cls = classMap.get(key);
    if (cls[row._id.status] !== undefined) cls[row._id.status] = row.count;
    cls.total += row.count;
  }
  const classDocs = await Class.find(
    { _id: { $in: [...classMap.keys()] } },
    "name",
  ).lean();
  const classNameMap = Object.fromEntries(
    classDocs.map((c) => [String(c._id), c.name]),
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
    const key = String(rec.student);
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
  const students = await User.find(
    { _id: { $in: studentIds } },
    "firstName lastName classes",
  )
    .populate("classes", "name")
    .lean();
  const studentInfoMap = Object.fromEntries(
    students.map((u) => [
      String(u._id),
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
  const reasonIds = excusedByReason.map((r) => r._id).filter(Boolean);
  const reasonDocs = await AbsenceReason.find(
    { _id: { $in: reasonIds } },
    "title",
  ).lean();
  const reasonTitleMap = Object.fromEntries(
    reasonDocs.map((r) => [String(r._id), r.title]),
  );
  const categories = excusedByReason
    .map((r) => ({
      title: r._id ? reasonTitleMap[String(r._id)] || "-" : "Kategoriyasiz",
      count: r.count,
      percent: missedTotal
        ? Math.round((r.count / missedTotal) * 1000) / 10
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
  const range = { $gte: start, $lt: end };

  const [todayAll, monthRows, lateRows, timeRows, distinctDates, todayExcusedDocs] =
    await Promise.all([
      // Bugungi balans (mavjud xizmatdan qayta foydalanamiz)
      getTodayAllRecords(null, null),
      // Oy bo'yicha foydalanuvchi + status kesimida
      Attendance.aggregate([
        { $match: { date: range } },
        { $group: { _id: { user: "$user", status: "$status" }, count: { $sum: 1 } } },
      ]),
      // Kechikishlar kesimi
      Attendance.aggregate([
        { $match: { date: range, isLate: true } },
        {
          $group: {
            _id: "$user",
            lateCount: { $sum: 1 },
            totalLateMinutes: { $sum: "$lateMinutes" },
            avgLateMinutes: { $avg: "$lateMinutes" },
          },
        },
        { $sort: { lateCount: -1, totalLateMinutes: -1 } },
        { $limit: 20 },
      ]),
      // Ish vaqti (check-in/check-out to'liq kunlar)
      Attendance.aggregate([
        { $match: { date: range, checkIn: { $ne: null }, checkOut: { $ne: null } } },
        {
          $project: {
            user: 1,
            ms: { $max: [{ $subtract: ["$checkOut", "$checkIn"] }, 0] },
          },
        },
        { $group: { _id: "$user", totalMs: { $sum: "$ms" }, days: { $sum: 1 } } },
        { $sort: { totalMs: -1 } },
        { $limit: 100 },
      ]),
      Attendance.distinct("date", { date: range }),
      // Bugun sababli kelmaganlar (sabab kategoriyasi bilan)
      Attendance.find({ date: today, status: "excused" })
        .populate("user", "firstName lastName role")
        .populate("absenceReason", "title")
        .lean(),
    ]);

  // Oy bo'yicha foydalanuvchi kesimida yig'ish
  const perUser = new Map();
  for (const row of monthRows) {
    const key = String(row._id.user);
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
    if (u[row._id.status] !== undefined) u[row._id.status] = row.count;
    u.total += row.count;
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

  // Ism/rol ma'lumotlari - barcha kerakli foydalanuvchilar uchun bitta so'rov
  const userIds = [
    ...new Set([
      ...lateRows.map((r) => String(r._id)),
      ...timeRows.map((r) => String(r._id)),
      ...topStaffRaw.map((r) => r.userId),
    ]),
  ];
  const users = await User.find(
    { _id: { $in: userIds } },
    "firstName lastName role",
  ).lean();
  const userInfoMap = Object.fromEntries(
    users.map((u) => [
      String(u._id),
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
    .filter((r) => isStaff(String(r._id)))
    .map((r) => ({
      userId: String(r._id),
      ...userInfoMap[String(r._id)],
      lateCount: r.lateCount,
      totalLateMinutes: r.totalLateMinutes,
      avgLateMinutes: Math.round(r.avgLateMinutes || 0),
    }));

  const timesheet = timeRows
    .filter((r) => isStaff(String(r._id)))
    .map((r) => ({
      userId: String(r._id),
      ...userInfoMap[String(r._id)],
      days: r.days,
      totalMinutes: Math.round(r.totalMs / 60000),
      avgMinutesPerDay: r.days ? Math.round(r.totalMs / r.days / 60000) : 0,
    }));

  const topStaff = topStaffRaw
    .filter((r) => isStaff(r.userId))
    .map((r) => ({ ...r, ...userInfoMap[r.userId] }));

  const todayExcused = todayExcusedDocs
    .filter((d) => d.user)
    .map((d) => ({
      userId: String(d.user._id),
      name: `${d.user.firstName || ""} ${d.user.lastName || ""}`.trim(),
      role: d.user.role,
      reasonTitle: d.absenceReason?.title || null,
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
