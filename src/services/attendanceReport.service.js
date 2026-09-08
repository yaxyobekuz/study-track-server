const prisma = require("../config/prisma");
const {
  getTodayNormalized,
  getTodayAllRecords,
} = require("./attendance.service");
const { buildExpectedResolver } = require("./studentAttendance.service");
// ⚠️ Sana MATNI serverda yig'ilmaydi — yagona formatlovchidan olinadi
// (`.claude/rules/dates.md`). Davomat kuni `@db.Date` kabi UTC yarim
// tunida yotadi, shuning uchun `{ utc: true }` MAJBURIY.
const { formatDateUz } = require("../helpers/date.helpers");
const { formatMonthKey } = require("../helpers/month.helpers");

// Xavfli guruh chegaralari: 3+ kun ketma-ket yoki oyda 5+ kun qoldirish
const RISK_CONSECUTIVE_DAYS = 3;
const RISK_MONTHLY_MISSED_DAYS = 5;

const EMPTY_SET = new Set();

// Davomat foizi: kelganlar (keldi + kech keldi) / KUTILGAN o'quvchi-kunlar.
// Belgilanganlarga nisbatan EMAS: belgilanmagan o'quvchi kelmagan hisoblanadi.
function attendancePercent({ came = 0, expected = 0 }) {
  if (!expected) return null;
  return Math.round((came / expected) * 1000) / 10;
}

function emptyCounts() {
  return {
    present: 0,
    late: 0,
    absent: 0,
    excused: 0,
    total: 0,
    came: 0,
    expected: 0,
    unmarked: 0,
  };
}

// Hosila ko'rsatkichlar: came = present + late, unmarked = expected − total, percent
function finalizeCounts(counts) {
  counts.came = counts.present + counts.late;
  counts.unmarked = Math.max(0, counts.expected - counts.total);
  counts.percent = attendancePercent(counts);
  return counts;
}

function addCounts(target, src) {
  target.present += src.present;
  target.late += src.late;
  target.absent += src.absent;
  target.excused += src.excused;
  target.total += src.total;
  target.expected += src.expected;
  return target;
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

function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

// 1=Dushanba ... 6=Shanba, 0=Yakshanba
function weekdayOf(key) {
  return new Date(`${key}T00:00:00Z`).getUTCDay();
}

// Ikki to'plam birlashmasining o'lchami
function unionSize(a, b) {
  let size = a.size;
  for (const x of b) if (!a.has(x)) size++;
  return size;
}

/**
 * Kun kesimi: yozuvlarni kun bo'yicha sanaydi va har kunga kutilganlarni qo'shadi.
 * O'quv kuni = maktab bo'ylab kamida bitta yozuvi bor kun; yozuvsiz kun
 * (bayram, yakshanba) ro'yxatga kirmaydi.
 * Kun uchun kutilganlar = jadval bo'yicha kutilganlar ∪ o'sha kuni belgilanganlar:
 * belgilangan o'quvchi (jadvalda bo'lmasa ham) shubhasiz kutilgan edi — shu
 * tufayli `total ≤ expected` invarianti buzilmaydi.
 * Har kun `recorded` (belgilangan o'quvchilar to'plami) bilan qaytadi.
 */
function aggregateByDay(records, resolver) {
  const dayMap = new Map();
  for (const rec of records) {
    const key = dayKey(rec.date);
    if (!dayMap.has(key)) {
      dayMap.set(key, { date: key, ...emptyCounts(), recorded: new Set() });
    }
    const day = dayMap.get(key);
    if (day[rec.status] !== undefined) day[rec.status]++;
    day.total++;
    day.recorded.add(rec.studentId);
  }
  for (const day of dayMap.values()) {
    const { ids } = resolver.forWeekday(weekdayOf(day.date));
    day.expected = unionSize(ids, day.recorded);
    finalizeCounts(day);
  }
  return dayMap;
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
 * Bir KUNNING davomati — taqqoslash kartalari uchun.
 *
 * ⚠️ Kutilgan = jadval bo'yicha kutilganlar ∪ o'sha kuni belgilanganlar.
 * Yozuvi yo'q kun (yakshanba, bayram) uchun ham chaqirilishi mumkin —
 * u paytda `expected = 0` va foiz `null` ("ma'lumot yo'q", 0% emas).
 *
 * @param {Date} date - UTC yarim tunidagi kun
 * @param {object} resolver - `buildExpectedResolver()` natijasi
 */
async function dayCounts(date, resolver) {
  const records = await prisma.studentAttendance.findMany({
    where: { date },
    select: { studentId: true, status: true },
  });

  const counts = countStatuses(records);
  counts.expected = unionSize(
    resolver.forWeekday(date.getUTCDay()).ids,
    new Set(records.map((r) => r.studentId)),
  );
  finalizeCounts(counts);

  counts.date = dayKey(date);
  counts.dateLabel = formatDateUz(date, { utc: true });

  return counts;
}

/**
 * Bir OYNING davomati — taqqoslash kartasi uchun.
 *
 * ⚠️ Yig'indi KUNLAR bo'yicha yig'iladi, xom yozuvlardan emas: kutilgan
 * o'quvchi-kunlar faqat kun kesimida ma'noli (`aggregateByDay`).
 */
async function monthCounts(month, year, resolver) {
  const { m, y, start, end } = monthRange(month, year);

  const records = await prisma.studentAttendance.findMany({
    where: { date: { gte: start, lt: end } },
    select: { studentId: true, status: true, date: true },
    orderBy: { date: "asc" },
  });

  const counts = emptyCounts();
  for (const day of aggregateByDay(records, resolver).values()) {
    addCounts(counts, day);
  }
  finalizeCounts(counts);

  counts.month = m;
  counts.year = y;
  counts.monthLabel = formatMonthKey(y * 100 + m);

  return counts;
}

/** Ikki foiz farqi — PUNKTDA (foizning foizi rahbarni chalg'itardi). */
const pointDiff = (value, previous) =>
  value == null || previous == null
    ? null
    : Math.round((value - previous) * 10) / 10;

/**
 * "YYYY-MM-DD" → UTC yarim tunidagi kun. Yaroqsiz qiymatda `null`.
 *
 * ⚠️ `new Date("2026-09-06")` allaqachon UTC yarim tunini beradi, lekin
 * qiymat "2026-9-6" kabi kelsa jimgina siljib ketardi — shuning uchun
 * shakl qat'iy tekshiriladi.
 */
function parseDayParam(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * O'quvchilar davomati bo'yicha to'liq hisobot.
 *
 * Kunlik ko'rsatkich TANLANGAN kunga (odatda bugun), qolganlari tanlangan
 * oyga tegishli. Barcha foizlar KUTILGAN o'quvchi-kunlarga nisbatan
 * (`buildExpectedResolver`).
 *
 * ⚠️ HAFTALIK KO'RSATKICH OLIB TASHLANDI. U doim JORIY haftaga tegishli
 * edi va tanlangan oyga bo'ysunmasdi: avgust tanlansa ham yonida sentabr
 * haftasining foizi turardi. Uning o'rnini TAQQOSLASH egalladi — kunni
 * kunga, oyni oyga solishtirish o'sha savolga ("yaxshilandimi?") to'g'ri
 * javob beradi.
 *
 * @param {number|string} month - 1-12
 * @param {number|string} year
 * @param {{day?: string, compareDay?: string, compareMonth?: number|string,
 *          compareYear?: number|string}} [options]
 *   `day`          — kunlik karta qaysi kunni ko'rsatadi (default: bugun)
 *   `compareDay`   — shu kun bilan taqqoslanadigan kun
 *   `compareMonth` / `compareYear` — oylik karta bilan taqqoslanadigan oy
 */
async function getStudentReport(month, year, options = {}) {
  const { m, y, start, end } = monthRange(month, year);

  const today = getTodayNormalized();

  // Kutilgan o'quvchilar resolveri (faol o'quvchilar + jadval, bir marta)
  const resolver = await buildExpectedResolver();
  const totalStudents = resolver.allStudentIds.size;

  // ⚠️ Tanlangan kun oyga TEGISHLI bo'lishi shart emas: karta "bugun"
  // deb ochiladi, foydalanuvchi esa istagan kunni tanlaydi. Yaroqsiz
  // qiymat jimgina bugunga tushadi — xato qaytarish butun sahifani
  // bo'sh qoldirardi.
  const selectedDay = parseDayParam(options.day) ?? today;
  const compareDay = parseDayParam(options.compareDay);

  const compareMonthNumber = Number(options.compareMonth);
  const compareYearNumber = Number(options.compareYear);
  const hasCompareMonth =
    Number.isInteger(compareMonthNumber) &&
    compareMonthNumber >= 1 &&
    compareMonthNumber <= 12 &&
    Number.isInteger(compareYearNumber) &&
    compareYearNumber > 2000 &&
    // Oyni o'zi bilan taqqoslash ma'nosiz — karta "0 p.p." bo'lib turardi
    !(compareMonthNumber === m && compareYearNumber === y);

  const [dailyCounts, dailyCompare, monthlyCompare, monthRecords] = await Promise.all([
    dayCounts(selectedDay, resolver),
    compareDay ? dayCounts(compareDay, resolver) : Promise.resolve(null),
    hasCompareMonth
      ? monthCounts(compareMonthNumber, compareYearNumber, resolver)
      : Promise.resolve(null),
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

  // ── Kun bo'yicha hisob (oy) ───────────────────────────────────────
  const monthDayMap = aggregateByDay(monthRecords, resolver);
  const monthDays = [...monthDayMap.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const byDay = monthDays.map(({ recorded, ...d }) => d);

  // Oylik umumiy yig'indi
  const monthlyCounts = emptyCounts();
  for (const d of monthDays) addCounts(monthlyCounts, d);
  finalizeCounts(monthlyCounts);
  monthlyCounts.month = m;
  monthlyCounts.year = y;
  monthlyCounts.monthLabel = formatMonthKey(y * 100 + m);

  // ── Hafta kunlari bo'yicha qoldirish trendi ───────────────────────
  // missed = kutilgan − kelgan (belgilanmagan ham qoldirgan hisoblanadi)
  const weekdayMap = new Map();
  for (const d of byDay) {
    const dow = weekdayOf(d.date);
    if (!weekdayMap.has(dow)) {
      weekdayMap.set(dow, { dayOfWeek: dow, missed: 0, total: 0 });
    }
    const entry = weekdayMap.get(dow);
    entry.missed += Math.max(0, d.expected - d.came);
    entry.total += d.expected;
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
  // Yozuvlar sinf bo'yicha; kutilgan esa o'quv kunlari × shu kuni darsi bor
  // sinf o'quvchilari. Kutilgan-u umuman belgilanmagan sinf ham ro'yxatga kiradi.
  const classMap = new Map();
  const ensureClass = (classId) => {
    if (!classMap.has(classId)) {
      classMap.set(classId, { classId, ...emptyCounts() });
    }
    return classMap.get(classId);
  };
  // kun → sinf → belgilangan o'quvchilar
  const dayClassRecorded = new Map();
  for (const rec of monthRecords) {
    const classId = String(rec.classId);
    const cls = ensureClass(classId);
    if (cls[rec.status] !== undefined) cls[rec.status]++;
    cls.total++;

    const key = dayKey(rec.date);
    if (!dayClassRecorded.has(key)) dayClassRecorded.set(key, new Map());
    const perClass = dayClassRecorded.get(key);
    if (!perClass.has(classId)) perClass.set(classId, new Set());
    perClass.get(classId).add(rec.studentId);
  }

  // Har bir o'quvchi uchun kutilgan kunlar soni (eng yaxshilar foizi uchun)
  const perStudentExpected = new Map();
  const bumpExpected = (id) =>
    perStudentExpected.set(id, (perStudentExpected.get(id) || 0) + 1);

  for (const day of monthDays) {
    const { ids, byClass } = resolver.forWeekday(weekdayOf(day.date));
    const recordedByClass = dayClassRecorded.get(day.date) || new Map();

    const classIdsToday = new Set([...byClass.keys(), ...recordedByClass.keys()]);
    for (const classId of classIdsToday) {
      const scheduled = byClass.get(classId) || EMPTY_SET;
      const recorded = recordedByClass.get(classId) || EMPTY_SET;
      ensureClass(classId).expected += unionSize(scheduled, recorded);
    }

    for (const id of ids) bumpExpected(id);
    for (const id of day.recorded) if (!ids.has(id)) bumpExpected(id);
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
      ...finalizeCounts(c),
      className: classNameMap[c.classId] || "-",
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
        ...emptyCounts(),
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
  for (const s of perStudent.values()) {
    s.expected = perStudentExpected.get(s.studentId) || s.total;
    finalizeCounts(s);
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
    // ⚠️ `weekly` YO'Q (yuqoridagi izohga qarang). O'rniga taqqoslash:
    // `dailyCompare` / `monthlyCompare` tanlanmagan bo'lsa `null` bo'ladi
    // va frontend faqat ikkita kartani chizadi.
    overall: {
      daily: dailyCounts,
      dailyCompare,
      dailyChange: dailyCompare
        ? pointDiff(dailyCounts.percent, dailyCompare.percent)
        : null,
      monthly: monthlyCounts,
      monthlyCompare,
      monthlyChange: monthlyCompare
        ? pointDiff(monthlyCounts.percent, monthlyCompare.percent)
        : null,
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
    .map((u) => ({
      ...u,
      percent: attendancePercent({ came: u.present + u.late, expected: u.total }),
    }))
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
