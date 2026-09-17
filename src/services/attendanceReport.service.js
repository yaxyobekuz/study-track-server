const prisma = require("../config/prisma");
const {
  getTodayNormalized,
  getTodayAllRecords,
} = require("./attendance.service");
const { buildExpectedResolver } = require("./studentAttendance.service");
const { loadArchivedStudentScope } = require("./archivedStudentScope.service");
// ⚠️ Sana MATNI serverda yig'ilmaydi — yagona formatlovchidan olinadi
// (`.claude/rules/dates.md`). Davomat kuni `@db.Date` kabi UTC yarim
// tunida yotadi, shuning uchun `{ utc: true }` MAJBURIY.
const { formatDateUz } = require("../helpers/date.helpers");
const { formatMonthKey } = require("../helpers/month.helpers");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { isValidId } = require("../utils/objectId");

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
    const { ids } = resolver.forDate(day.date);
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

/** Bir kunning butun maktab bo'yicha yozuvlari (sinf kesimi uchun `classId` bilan). */
function loadDayRecords(date, scope = {}) {
  return prisma.studentAttendance.findMany({
    where: { date, ...scope },
    select: { studentId: true, classId: true, status: true },
  });
}

/**
 * Bir KUNNING davomati — kunlik karta va taqqoslash uchun.
 *
 * ⚠️ Kutilgan = jadval bo'yicha kutilganlar ∪ o'sha kuni belgilanganlar.
 * Yozuvi yo'q kun (yakshanba, bayram) uchun ham chaqirilishi mumkin —
 * u paytda `expected = 0` va foiz `null` ("ma'lumot yo'q", 0% emas).
 *
 * @param {Date} date - UTC yarim tunidagi kun
 * @param {Array} records - `loadDayRecords(date)` natijasi
 * @param {object} resolver - `buildExpectedResolver()` natijasi
 */
function countDay(date, records, resolver) {
  const counts = countStatuses(records);
  counts.expected = unionSize(
    resolver.forDate(date).ids,
    new Set(records.map((r) => r.studentId)),
  );
  finalizeCounts(counts);

  counts.date = dayKey(date);
  counts.dateLabel = formatDateUz(date, { utc: true });

  return counts;
}

async function dayCounts(date, resolver, scope) {
  return countDay(date, await loadDayRecords(date, scope), resolver);
}

// ── Sinf kesimi ─────────────────────────────────────────────────────

/**
 * Kun yozuvlari indeksi: o'quvchi → yozuv, sinf → shu sinf nomidan
 * belgilangan o'quvchilar.
 */
function indexDay(records) {
  const byStudent = new Map();
  const byClass = new Map();
  for (const rec of records) {
    byStudent.set(rec.studentId, rec);
    const classId = String(rec.classId);
    if (!byClass.has(classId)) byClass.set(classId, new Set());
    byClass.get(classId).add(rec.studentId);
  }
  return { byStudent, byClass };
}

/**
 * Sinfning bir kundagi KUTILGAN o'quvchilari va har birining yozuvi
 * (`null` — belgilanmagan).
 *
 * Kutilgan = (shu kuni darsi bor va o'qiyotgan a'zolar) ∪ (shu sinf nomidan
 * belgilanganlar — sinfdan chiqib ketgan bo'lsa ham).
 *
 * ⚠️ Yozuv O'QUVCHI bo'yicha olinadi, sinf bo'yicha EMAS — kunlik sahifa
 * (`getTodayClassAttendance`) bilan AYNI qoida: o'quvchi kuniga bitta
 * yozuvga ega va u boshqa sinf nomidan belgilangan bo'lishi mumkin. Sinf
 * bo'yicha olinsa, ikki sinfda turgan o'quvchi ikkinchisida har kuni
 * "belgilanmagan" bo'lib, o'sha sinfni jimgina "eng past" qilib qo'yardi.
 *
 * @returns {Array<[string, object|null]>}
 */
function classDayEntries(classId, key, resolver, dayIndex) {
  const members = resolver.classOn(classId, key);
  const recordedHere = dayIndex.byClass.get(classId) || EMPTY_SET;

  const entries = [];
  for (const id of members) {
    entries.push([id, dayIndex.byStudent.get(id) || null]);
  }
  for (const id of recordedHere) {
    if (!members.has(id)) entries.push([id, dayIndex.byStudent.get(id)]);
  }
  return entries;
}

// Bitta kutilgan o'quvchi-kunni yig'indiga qo'shadi
function tallyEntry(counts, record) {
  counts.expected++;
  if (!record) return;
  if (counts[record.status] !== undefined) counts[record.status]++;
  counts.total++;
}

/**
 * Tanlangan KUN uchun sinflar jadvali.
 *
 * ⚠️ Kun bo'yicha, oy bo'yicha EMAS: oy yig'indisi "Kutilgan 152, kelgan
 * 151" kabi o'quvchi-kunlarni ko'rsatardi va "bugun sinfda nima bo'ldi"
 * degan savolga javob bermasdi. Oy va yil kesimi sinf hisobotida
 * (`getClassReport`).
 */
async function buildDailyByClass(date, records, resolver) {
  const key = dayKey(date);
  const dayIndex = indexDay(records);

  const classIds = new Set([
    ...resolver.forDate(key).byClass.keys(),
    ...dayIndex.byClass.keys(),
  ]);

  const rows = [];
  for (const classId of classIds) {
    const counts = { classId, ...emptyCounts() };
    for (const [, record] of classDayEntries(classId, key, resolver, dayIndex)) {
      tallyEntry(counts, record);
    }
    if (counts.expected) rows.push(finalizeCounts(counts));
  }

  const classDocs = await prisma.class.findMany({
    where: { id: { in: rows.map((r) => r.classId) } },
    select: { id: true, name: true },
  });
  const classNameMap = new Map(classDocs.map((c) => [String(c.id), c.name]));

  return rows
    .map((row) => ({ ...row, className: classNameMap.get(row.classId) || "-" }))
    .sort(
      (a, b) =>
        (b.percent ?? -1) - (a.percent ?? -1) ||
        a.className.localeCompare(b.className, "uz"),
    );
}

/**
 * Bir OYNING davomati — taqqoslash kartasi uchun.
 *
 * ⚠️ Yig'indi KUNLAR bo'yicha yig'iladi, xom yozuvlardan emas: kutilgan
 * o'quvchi-kunlar faqat kun kesimida ma'noli (`aggregateByDay`).
 */
async function monthCounts(month, year, resolver, scope = {}) {
  const { m, y, start, end } = monthRange(month, year);

  const records = await prisma.studentAttendance.findMany({
    where: { date: { gte: start, lt: end }, ...scope },
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
  const [resolver, scope] = await Promise.all([
    buildExpectedResolver(),
    loadArchivedStudentScope(),
  ]);
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

  const [selectedDayRecords, dailyCompare, monthlyCompare, monthRecords] = await Promise.all([
    loadDayRecords(selectedDay, scope),
    compareDay ? dayCounts(compareDay, resolver, scope) : Promise.resolve(null),
    hasCompareMonth
      ? monthCounts(compareMonthNumber, compareYearNumber, resolver, scope)
      : Promise.resolve(null),
    // Oy yozuvlari - barcha kesimlar uchun (sana bo'yicha tartiblangan)
    prisma.studentAttendance.findMany({
      where: { date: { gte: start, lt: end }, ...scope },
      select: {
        studentId: true,
        status: true,
        date: true,
        absenceReason: true,
      },
      orderBy: { date: "asc" },
    }),
  ]);

  const dailyCounts = countDay(selectedDay, selectedDayRecords, resolver);

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

  // ── Sinf kesimi — TANLANGAN KUN (kunlik karta bilan bir kun) ───────
  const byClass = await buildDailyByClass(selectedDay, selectedDayRecords, resolver);

  // Har bir o'quvchi uchun kutilgan kunlar soni (eng yaxshilar foizi uchun)
  const perStudentExpected = new Map();
  const bumpExpected = (id) =>
    perStudentExpected.set(id, (perStudentExpected.get(id) || 0) + 1);

  for (const day of monthDays) {
    const { ids } = resolver.forDate(day.date);
    for (const id of ids) bumpExpected(id);
    for (const id of day.recorded) if (!ids.has(id)) bumpExpected(id);
  }

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

// ── Sinf hisoboti (kunlik / oylik / yillik) ──────────────────────────

const CLASS_REPORT_PERIODS = ["day", "month", "year"];

// Kunlik ro'yxatda tartib: avval kelmaganlar (e'tibor talab qiladi), keyin kelganlar
const DAY_STATUS_ORDER = { absent: 0, unmarked: 1, excused: 2, late: 3, present: 4 };

const round1 = (value) => Math.round(value * 10) / 10;
const shareOf = (part, whole) => (whole ? round1((part / whole) * 100) : null);

/**
 * Sinf hisoboti davrini aniqlaydi. Parametr berilmasa — joriy kun/oy/yil
 * (Toshkent). Berilgan-u yaroqsiz bo'lsa 400: sahifa URL'dan o'qiydi va
 * jimgina boshqa davrni ko'rsatish "noto'g'ri raqam"dan yomonroq.
 */
function resolveClassPeriod(period, options) {
  const today = getTodayNormalized();

  if (period === "day") {
    const date = options.date ? parseDayParam(options.date) : today;
    if (!date) throw new BadRequestError("Sana noto'g'ri (YYYY-MM-DD)");
    return {
      start: date,
      end: new Date(date.getTime() + 86400000),
      date: dayKey(date),
      label: formatDateUz(date, { utc: true }),
    };
  }

  const year = options.year ? Number(options.year) : today.getUTCFullYear();
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new BadRequestError("Yil noto'g'ri");
  }

  if (period === "month") {
    const month = options.month ? Number(options.month) : today.getUTCMonth() + 1;
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestError("Oy noto'g'ri");
    }
    return {
      ...monthRange(month, year),
      month,
      year,
      label: formatMonthKey(year * 100 + month),
    };
  }

  return {
    start: new Date(Date.UTC(year, 0, 1)),
    end: new Date(Date.UTC(year + 1, 0, 1)),
    year,
    label: `${year}-yil`,
  };
}

/**
 * O'quv kunlari: butun maktab bo'yicha kamida bitta yozuvi bor kunlar
 * (`aggregateByDay` bilan AYNI ta'rif — bayram va yakshanba kirmaydi).
 *
 * ⚠️ `groupBy`, `distinct` EMAS: Prisma `distinct` ni xotirada bajaradi va
 * yillik oraliqda butun maktab yozuvlarini yuklab olardi.
 */
async function loadSchoolDays(start, end) {
  const rows = await prisma.studentAttendance.groupBy({
    by: ["date"],
    where: { date: { gte: start, lt: end } },
  });
  return rows.map((r) => dayKey(r.date)).sort();
}

/**
 * Bitta sinf bo'yicha davomat hisoboti — "nega bu sinf past" degan savolga
 * javob: sinf yig'indisi, qoldirishlar tarkibi va O'QUVCHILAR kesimi
 * (eng past foizdagilar birinchi).
 *
 * Hisob asosiy hisobotdagi sinf jadvali bilan BIR XIL (`classDayEntries`):
 * jadvaldagi kunlik qatorga bosib kirilganda raqamlar mos kelishi shart.
 *
 * @param {string} classId
 * @param {{period?: "day"|"month"|"year", date?: string,
 *          month?: number|string, year?: number|string}} [options]
 *   `day`   — `date` ("YYYY-MM-DD", default bugun)
 *   `month` — `month` + `year` (default joriy oy)
 *   `year`  — `year` (kalendar yili: o'quv yili tushunchasi yo'q, `education.md` §1)
 */
async function getClassReport(classId, options = {}) {
  if (!isValidId(classId)) throw new NotFoundError("Sinf topilmadi");

  const period = options.period || "day";
  if (!CLASS_REPORT_PERIODS.includes(period)) {
    throw new BadRequestError(`Noto'g'ri davr: ${period}`);
  }
  const range = resolveClassPeriod(period, options);

  const [classDoc, resolver, scope] = await Promise.all([
    prisma.class.findUnique({
      where: { id: classId },
      select: { id: true, name: true },
    }),
    buildExpectedResolver(),
    loadArchivedStudentScope(),
  ]);
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");

  const memberIds = [...resolver.classMembers(classId)];

  const [records, dayKeys] = await Promise.all([
    // Faqat shu sinfga tegishli yozuvlar: a'zolarning (qaysi sinf nomidan
    // bo'lmasin) va shu sinf nomidan belgilanganlarning
    prisma.studentAttendance.findMany({
      where: {
        date: { gte: range.start, lt: range.end },
        OR: [{ classId }, { studentId: { in: memberIds } }],
        // Arxivlangan — sinfdan ham, hisobotdan ham chiqqan (`loadArchivedStudentScope`)
        ...scope,
      },
      select: {
        studentId: true,
        classId: true,
        status: true,
        date: true,
        absenceReason: true,
        excuseReason: true,
      },
    }),
    // Kunlik hisobot tanlangan kunni yozuvi bo'lmasa ham ko'rsatadi
    // (kunlik karta bilan bir xil: hali belgilanmagan bugun — 0%)
    period === "day"
      ? Promise.resolve([range.date])
      : loadSchoolDays(range.start, range.end),
  ]);

  const recordsByDay = new Map();
  for (const rec of records) {
    const key = dayKey(rec.date);
    if (!recordsByDay.has(key)) recordsByDay.set(key, []);
    recordsByDay.get(key).push(rec);
  }

  const summary = emptyCounts();
  const perStudent = new Map();
  // Kesim: oylikda kun, yillikda oy bo'yicha
  const buckets = new Map();
  let schoolDays = 0;

  for (const key of dayKeys) {
    const dayIndex = indexDay(recordsByDay.get(key) || []);
    const entries = classDayEntries(classId, key, resolver, dayIndex);
    if (!entries.length) continue;
    schoolDays++;

    let bucket = null;
    if (period !== "day") {
      const bucketKey = period === "month" ? key : key.slice(0, 7);
      if (!buckets.has(bucketKey)) buckets.set(bucketKey, emptyCounts());
      bucket = buckets.get(bucketKey);
    }

    for (const [studentId, record] of entries) {
      tallyEntry(summary, record);
      if (bucket) tallyEntry(bucket, record);

      if (!perStudent.has(studentId)) {
        perStudent.set(studentId, {
          studentId,
          ...emptyCounts(),
          streak: 0,
          maxStreak: 0,
          record: null,
        });
      }
      const s = perStudent.get(studentId);
      tallyEntry(s, record);
      s.record = record;

      // Ketma-ketlik faqat shu o'quvchi KUTILGAN kunlar bo'yicha: darsi
      // bo'lmagan kun zanjirni uzmaydi ham, cho'zmaydi ham
      const came = record && (record.status === "present" || record.status === "late");
      s.streak = came ? 0 : s.streak + 1;
      if (s.streak > s.maxStreak) s.maxStreak = s.streak;
    }
  }

  finalizeCounts(summary);
  const missedTotal = summary.expected - summary.came;

  // Ism-familiya (sinfdan chiqqan bo'lsa ham) va sabab nomlari
  const studentIds = [...perStudent.keys()];
  const reasonIds = [
    ...new Set(
      period === "day"
        ? [...perStudent.values()].map((s) => s.record?.absenceReason).filter(Boolean)
        : [],
    ),
  ];
  const [users, reasons] = await Promise.all([
    studentIds.length
      ? prisma.user.findMany({
          where: { id: { in: studentIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [],
    reasonIds.length
      ? prisma.absenceReason.findMany({
          where: { id: { in: reasonIds } },
          select: { id: true, title: true },
        })
      : [],
  ]);
  const nameMap = new Map(
    users.map((u) => [u.id, `${u.lastName || ""} ${u.firstName || ""}`.trim() || "-"]),
  );
  const reasonMap = new Map(reasons.map((r) => [r.id, r.title]));
  const memberSet = resolver.classMembers(classId);

  const students = [...perStudent.values()].map(({ streak, record, ...s }) => {
    finalizeCounts(s);
    const missed = s.expected - s.came;
    const row = {
      ...s,
      name: nameMap.get(s.studentId) || "-",
      // Joriy a'zo emas — shu sinf nomidan belgilangan, keyin chiqib ketgan
      isMember: memberSet.has(s.studentId),
      missed,
      missedShare: shareOf(missed, missedTotal),
    };
    if (period === "day") {
      row.status = record?.status || null;
      row.reasonTitle = record?.absenceReason
        ? reasonMap.get(record.absenceReason) || null
        : null;
      row.excuseReason = record?.excuseReason || null;
    }
    return row;
  });

  if (period === "day") {
    students.sort(
      (a, b) =>
        DAY_STATUS_ORDER[a.status || "unmarked"] - DAY_STATUS_ORDER[b.status || "unmarked"] ||
        a.name.localeCompare(b.name, "uz"),
    );
  } else {
    // ⚠️ SINF FOIZIGA TA'SIR bo'yicha (qoldirgan kunlar soni), shaxsiy foiz
    // bo'yicha EMAS: savol "sinf kimning hisobiga past". Oy oxirida kelib
    // 6 kundan 3 kunini qoldirgan bola 50% bilan ro'yxat boshiga chiqardi,
    // holbuki sinf foiziga ta'siri 40 kun qoldirgan boladan o'n barobar kam.
    students.sort(
      (a, b) =>
        b.missed - a.missed ||
        (a.percent ?? 101) - (b.percent ?? 101) ||
        a.name.localeCompare(b.name, "uz"),
    );
  }

  // Qoldirishlar jamlanishi: ro'yxat boshidagi nechta o'quvchi qoldirilgan
  // kunlarning yarmini beradi va ularsiz sinf foizi qancha bo'lardi.
  // "Sinf past" ko'pincha 2–3 bolaning hisobiga — raqam shuni ochib beradi.
  let concentration = null;
  if (period !== "day" && missedTotal > 0) {
    const leaders = [];
    let covered = 0;
    for (const s of students) {
      if (covered * 2 >= missedTotal || s.missed === 0) break;
      covered += s.missed;
      leaders.push(s);
    }
    const leadersExpected = leaders.reduce((sum, s) => sum + s.expected, 0);
    const leadersCame = leaders.reduce((sum, s) => sum + s.came, 0);

    concentration = {
      students: leaders.length,
      missedStudents: students.filter((s) => s.missed > 0).length,
      share: shareOf(covered, missedTotal),
      percentWithout: attendancePercent({
        came: summary.came - leadersCame,
        expected: summary.expected - leadersExpected,
      }),
    };
  }

  let byDay;
  let byMonth;
  if (period === "month") {
    byDay = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, counts]) => ({ date, ...finalizeCounts(counts) }));
  }
  if (period === "year") {
    // Kelajak oylar kiritilmaydi — ularda "ma'lumot yo'q" qatori shovqin
    const today = getTodayNormalized();
    const lastMonth =
      range.year < today.getUTCFullYear()
        ? 12
        : range.year === today.getUTCFullYear()
          ? today.getUTCMonth() + 1
          : 0;
    byMonth = Array.from({ length: lastMonth }, (_, i) => {
      const bucketKey = `${range.year}-${String(i + 1).padStart(2, "0")}`;
      const counts = finalizeCounts(buckets.get(bucketKey) || emptyCounts());
      return {
        month: i + 1,
        monthLabel: formatMonthKey(range.year * 100 + i + 1),
        ...counts,
      };
    });
  }

  return {
    classInfo: { id: classDoc.id, name: classDoc.name },
    period,
    periodLabel: range.label,
    date: range.date ?? null,
    month: range.month ?? null,
    year: range.year ?? null,
    summary: {
      ...summary,
      schoolDays,
      students: students.length,
      missed: missedTotal,
      // Qoldirishlar tarkibi — foiz nima hisobiga tushganini ko'rsatadi
      absentShare: shareOf(summary.absent, missedTotal),
      excusedShare: shareOf(summary.excused, missedTotal),
      unmarkedShare: shareOf(summary.unmarked, missedTotal),
    },
    concentration,
    students,
    ...(byDay ? { byDay } : {}),
    ...(byMonth ? { byMonth } : {}),
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
  getClassReport,
  getStaffReport,
};
