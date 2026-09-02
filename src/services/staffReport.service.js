const prisma = require("../config/prisma");
// Rollar katalogi PLATFORMADA — barcha filiallarga umumiy
const platformPrisma = require("../config/platformPrisma");
const { getTodayNormalized } = require("./attendance.service");
const { formatMonthKey, formatMonthShort } = require("../helpers/month.helpers");

// Xodim — o'quvchidan boshqa HAR KIM. Owner ham xodim: "Xodimlar" ro'yxati
// (`user.service.js` dagi `role === "staff"` guruhi) uni ko'rsatadi, shuning
// uchun hisobot ham uni sanaydi — aks holda "Jami xodimlar" ro'yxatdagi
// qatorlar soniga to'g'ri kelmasdi.
const STAFF_WHERE = { role: { not: "student" } };

// Toshkent — UTC+5, DST yo'q. Instant maydonlar (`createdAt`, `archivedAt`,
// `dueDate`) uchun oy chegarasi DEVOR-SOATIDA olinadi: 1-sentabr 02:00
// (Toshkent) UTC'da hali 31-avgust bo'lib turadi va shu odam avgustga
// qo'shilib ketardi.
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

// "Shtat dinamikasi" diagrammasidagi oylar soni
const TREND_MONTHS = 6;

// Reyting jadvallarining uzunligi — ekranga sig'adigan, lekin ma'noli kesim
const TOP_LIMIT = 10;

// Yon paneldagi qisqa reytinglar (davomat) — kartaga sig'adigani
const SHORT_LIMIT = 5;

/** Yakuniy (endi o'zgarmaydigan) topshiriq statuslari. */
const TASK_TERMINAL_STATUSES = ["completed", "stopped"];

/** YYYYMM → o'sha oyning Toshkentdagi boshlanish instanti (UTC'da). */
const monthStartInstant = (monthKey) =>
  new Date(
    Date.UTC(Math.trunc(monthKey / 100), (monthKey % 100) - 1, 1) -
      TASHKENT_OFFSET_MS,
  );

/** YYYYMM oy kaliti arifmetikasi (202612 + 1 !== 202701). */
const shiftMonthKey = (monthKey, delta) => {
  const index = Math.trunc(monthKey / 100) * 12 + ((monthKey % 100) - 1) + delta;
  return Math.trunc(index / 12) * 100 + (index % 12) + 1;
};

/** Foiz, bitta kasr xonasi bilan. Maxraj 0 bo'lsa — `null` ("ma'lum emas"). */
const percentOf = (part, total) =>
  total ? Math.round((part / total) * 1000) / 10 : null;

/**
 * Davomat foizi = (keldi + kech keldi) / belgilangan yozuvlar.
 * `attendanceReport.service.js` bilan bir xil formula — ikki hisobotda
 * bir xil xodim uchun har xil raqam chiqmasligi kerak.
 */
const attendancePercent = ({ present, late, absent, excused }) =>
  percentOf(present + late, present + late + absent + excused);

/** `select` ishlatilgan so'rovda `fullName` virtuali kelmaydi — qo'lda yig'amiz. */
const fullNameOf = (user) =>
  `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.username || "—";

/** Instant → Toshkent devor-soati bo'yicha YYYYMM. */
const monthKeyOfInstant = (value) => {
  const shifted = new Date(new Date(value).getTime() + TASHKENT_OFFSET_MS);
  return shifted.getUTCFullYear() * 100 + shifted.getUTCMonth() + 1;
};

/**
 * BITTA OYNING KESIMI — jarima, topshiriq va davomat.
 *
 * Joriy va OLDINGI oy uchun ayni shu funksiya chaqiriladi: radar
 * diagrammasidagi "o'tgan oyga nisbatan" chizig'i ham xuddi shu formulalar
 * bilan hisoblanishi kerak, aks holda ikki chiziq solishtirib bo'lmaydigan
 * bo'lib qolardi.
 *
 * @param {number} monthKey - YYYYMM
 * @param {Map<string, object>} staffMap - xodim id → { name, role, roleLabel }
 * @param {boolean} withAttendance
 */
async function loadMonthSlice(monthKey, staffMap, withAttendance) {
  const y = Math.trunc(monthKey / 100);
  const m = monthKey % 100;

  // Instant maydonlar uchun — Toshkent devor-soati bo'yicha oy chegarasi
  const start = monthStartInstant(monthKey);
  const end = monthStartInstant(shiftMonthKey(monthKey, 1));
  const now = new Date();

  // Davomat uchun — `Attendance.date` UTC yarim tunga normallashtirilgan
  // kun koordinatasi, shuning uchun uning chegarasi surilmaydi
  const dayStart = new Date(Date.UTC(y, m - 1, 1));
  const dayEnd = new Date(Date.UTC(y, m, 1));

  const [penaltyRows, taskRows, overdueRows, attendanceRows] = await Promise.all([
    // Jarimalar — faqat TASDIQLANGANLARI: kutilayotgani hali fakt emas
    prisma.penalty.groupBy({
      by: ["userId", "type"],
      where: { status: "approved", createdAt: { gte: start, lt: end } },
      _count: { _all: true },
      _sum: { points: true, fineAmount: true },
    }),
    prisma.task.groupBy({
      by: ["assignee", "status"],
      where: { createdAt: { gte: start, lt: end } },
      _count: { _all: true },
    }),
    // Muddati o'tgan — status bo'yicha ajratib bo'lmaydi (u "pending"
    // bo'lib qolaveradi), shuning uchun alohida kesim
    prisma.task.groupBy({
      by: ["assignee"],
      where: {
        createdAt: { gte: start, lt: end },
        dueDate: { lt: now },
        status: { notIn: TASK_TERMINAL_STATUSES },
      },
      _count: { _all: true },
    }),
    withAttendance
      ? prisma.attendance.groupBy({
          by: ["userId", "status"],
          where: { date: { gte: dayStart, lt: dayEnd } },
          _count: { _all: true },
        })
      : [],
  ]);

  // ── Jarimalar ─────────────────────────────────
  const penalties = {
    count: 0,
    points: 0,
    fine: 0,
    reductionCount: 0,
    reductionPoints: 0,
    staffWithPenalty: 0,
    top: [],
  };
  const penaltyPerUser = new Map();
  for (const row of penaltyRows) {
    // Jarima o'quvchiga ham beriladi — bu hisobot faqat xodimniki
    const info = staffMap.get(row.userId);
    if (!info) continue;

    const count = row._count._all;
    const points = row._sum.points || 0;

    if (row.type === "reduction") {
      penalties.reductionCount += count;
      penalties.reductionPoints += points;
      continue;
    }

    penalties.count += count;
    penalties.points += points;
    penalties.fine += row._sum.fineAmount || 0;

    penaltyPerUser.set(row.userId, {
      ...info,
      count,
      points,
      fine: row._sum.fineAmount || 0,
    });
  }
  penalties.staffWithPenalty = penaltyPerUser.size;
  penalties.top = [...penaltyPerUser.values()]
    .sort((a, b) => b.points - a.points || b.count - a.count)
    .slice(0, TOP_LIMIT);

  // ── Topshiriqlar ──────────────────────────────
  const tasks = {
    assigned: 0,
    completed: 0,
    overdue: 0,
    active: 0,
    stopped: 0,
    staffWithTasks: 0,
    top: [],
  };
  const taskPerUser = new Map();
  const ensureTaskRow = (userId) => {
    if (!taskPerUser.has(userId)) {
      taskPerUser.set(userId, {
        ...staffMap.get(userId),
        assigned: 0,
        completed: 0,
        overdue: 0,
        stopped: 0,
      });
    }
    return taskPerUser.get(userId);
  };

  for (const row of taskRows) {
    if (!staffMap.has(row.assignee)) continue;

    const count = row._count._all;
    const userRow = ensureTaskRow(row.assignee);
    userRow.assigned += count;
    tasks.assigned += count;

    if (row.status === "completed") {
      userRow.completed += count;
      tasks.completed += count;
    } else if (row.status === "stopped") {
      userRow.stopped += count;
      tasks.stopped += count;
    } else {
      tasks.active += count;
    }
  }
  for (const row of overdueRows) {
    if (!staffMap.has(row.assignee)) continue;
    const count = row._count._all;
    ensureTaskRow(row.assignee).overdue += count;
    tasks.overdue += count;
  }

  // To'xtatilgan topshiriq maxrajdan CHIQADI: uni admin bekor qilgan, ya'ni
  // bajarilmagani xodimning intizomi haqida gapirmaydi.
  tasks.completionRate = percentOf(tasks.completed, tasks.assigned - tasks.stopped);
  tasks.staffWithTasks = taskPerUser.size;

  const taskRanked = [...taskPerUser.values()].map((row) => ({
    ...row,
    // Bahoning maxraji — to'xtatilganlarsiz, ya'ni xodim javob beradigan qism
    counted: row.assigned - row.stopped,
    rate: percentOf(row.completed, row.assigned - row.stopped),
  }));

  // `top` — HAJM bo'yicha ("kim ko'p ish oldi"), jadval uchun
  tasks.top = [...taskRanked]
    .sort((a, b) => b.assigned - a.assigned || b.completed - a.completed)
    .slice(0, TOP_LIMIT);

  // `best` — SIFAT bo'yicha ("kim yaxshi bajardi"), reyting uchun. Alohida
  // ro'yxat SHART: `top` hajm bo'yicha 10 taga kesilgan, uni frontendda
  // foizga qayta saralash "eng ko'p ish olgan o'ntaning ichidagi eng
  // yaxshisi" degan boshqa savolga javob berardi.
  //
  // Hajm chegarasi davomat reytingidagi qoidaning aynan o'zi: bitta
  // topshiriqni bajargan odam 100% bilan reytingni egallab olmasligi kerak.
  const maxCounted = taskRanked.reduce((max, row) => Math.max(max, row.counted), 0);
  const minCounted = Math.max(1, Math.ceil(maxCounted / 2));
  tasks.best = taskRanked
    .filter((row) => row.rate != null && row.counted >= minCounted)
    .sort((a, b) => b.rate - a.rate || b.counted - a.counted)
    .slice(0, SHORT_LIMIT);

  // ── Davomat ───────────────────────────────────
  let attendance = null;
  let attendanceByUser = new Map();
  if (withAttendance) {
    const summary = { present: 0, late: 0, absent: 0, excused: 0 };
    const perUser = new Map();

    for (const row of attendanceRows) {
      const info = staffMap.get(row.userId);
      if (!info) continue;
      if (summary[row.status] === undefined) continue;

      const count = row._count._all;
      summary[row.status] += count;

      if (!perUser.has(row.userId)) {
        perUser.set(row.userId, { ...info, present: 0, late: 0, absent: 0, excused: 0 });
      }
      perUser.get(row.userId)[row.status] += count;
    }

    const rows = [...perUser.values()].map((row) => ({
      ...row,
      total: row.present + row.late + row.absent + row.excused,
      percent: attendancePercent(row),
    }));

    // Bir-ikkita yozuvi bor xodim reytingni egallab olmasligi uchun: eng ko'p
    // belgilangan xodimning yarmicha yozuvi bo'lganlar hisobga olinadi
    const maxRecords = rows.reduce((max, row) => Math.max(max, row.total), 0);
    const minRecords = Math.max(1, Math.ceil(maxRecords / 2));
    const ranked = rows.filter((row) => row.total >= minRecords && row.percent != null);

    attendance = {
      ...summary,
      marked: summary.present + summary.late + summary.absent + summary.excused,
      percent: attendancePercent(summary),
      top: [...ranked]
        .sort((a, b) => b.percent - a.percent || b.total - a.total || a.late - b.late)
        .slice(0, SHORT_LIMIT),
      lowest: [...ranked]
        .filter((row) => row.percent < 100)
        .sort((a, b) => a.percent - b.percent || b.absent - a.absent)
        .slice(0, SHORT_LIMIT),
      // O'z vaqtida kelish — davomatdan ALOHIDA o'lchov: kelgan, lekin
      // kechikkan odam davomatda "keldi", intizomda esa emas
      punctuality: percentOf(summary.present, summary.present + summary.late),
    };
    // Reytingga tushmagan xodimlarning foizi ham kerak (staj jadvali) —
    // shuning uchun to'liq xarita alohida qaytariladi, payload'ga kirmaydi
    attendanceByUser = new Map(rows.map((row) => [row.userId, row.percent]));
  }

  return { penalties, tasks, attendance, attendanceByUser };
}

/**
 * Xodimlar bo'limining "Hisobotlar" tabi uchun HR manzarasi.
 *
 * Bu davomat hisobotining takrori EMAS: u vaqtga (kim qachon keldi-ketdi)
 * qaraydi, bu esa SHTATGA — tarkib, oqim, jarima va topshiriq intizomi.
 * Davomat bu yerda faqat yig'ma blok sifatida qatnashadi va u ham
 * `attendance.reports` ruxsati bo'lganda ochiladi.
 *
 * Tarkib ko'rsatkichlari JORIY holatga tegishli ("hozir nechta xodim bor"),
 * oqim/jarima/topshiriq/davomat esa TANLANGAN oyga. Radar diagrammasi
 * uchun oldingi oy kesimi ham hisoblanadi.
 *
 * @param {number|string} month - 1..12
 * @param {number|string} year
 * @param {object} [options]
 * @param {boolean} [options.withAttendance=false] - davomat bloki qo'shilsinmi
 */
async function getStaffReport(month, year, { withAttendance = false } = {}) {
  const m = parseInt(month, 10);
  const y = parseInt(year, 10);
  const monthKey = y * 100 + m;
  const prevKey = shiftMonthKey(monthKey, -1);

  const now = new Date();
  const isCurrentMonth = monthKeyOfInstant(now) === monthKey;

  const [staff, roles, subjectRows, subjectLinks] = await Promise.all([
    // Xodimlar soni kichik (o'quvchilardan farqli), shuning uchun butun
    // ro'yxat bir marta o'qiladi: tarkib, oqim, staj va ism-xarita —
    // hammasi shu bitta so'rovdan chiqadi.
    prisma.user.findMany({
      where: STAFF_WHERE,
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        role: true,
        gender: true,
        isActive: true,
        isArchived: true,
        archivedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    platformPrisma.role.findMany({ select: { value: true, name: true } }),
    // Fan katalogi va biriktirishlar — ikkalasi ham kichik jadval, shuning
    // uchun to'liq o'qib, kesimlar JS'da yig'iladi (groupBy dan keyin ism
    // uchun yana ikkita so'rov kerak bo'lardi)
    prisma.subject.findMany({
      select: { id: true, name: true, isActive: true },
      orderBy: { name: "asc" },
    }),
    prisma.userSubject.findMany({ select: { userId: true, subjectId: true } }),
  ]);

  // Rol yorlig'i serverdan keladi: `/roles` owner-only, ya'ni HR ruxsati
  // bor oddiy xodim frontendda rol nomini ololmaydi.
  const roleLabels = Object.fromEntries(roles.map((r) => [r.value, r.name]));
  // Owner katalogda ham bor, lekin butun tizimda u "Ega" deb ataladi
  roleLabels.owner = "Ega";
  const labelOf = (role) => roleLabels[role] || role;

  const staffMap = new Map(
    staff.map((u) => [
      u.id,
      {
        userId: u.id,
        name: fullNameOf(u),
        role: u.role,
        roleLabel: labelOf(u.role),
      },
    ]),
  );

  // Joriy va oldingi oy — parallel. Bugungi kesim faqat joriy oy ochilganda
  // kerak: o'tgan oyni ko'rayotgan odamga "bugun kim keldi" ma'nosiz.
  const [current, previousSlice, todayRows] = await Promise.all([
    loadMonthSlice(monthKey, staffMap, withAttendance),
    loadMonthSlice(prevKey, staffMap, withAttendance),
    withAttendance && isCurrentMonth
      ? prisma.attendance.groupBy({
          by: ["status"],
          where: { date: getTodayNormalized() },
          _count: { _all: true },
        })
      : [],
  ]);

  // ── Tarkib (joriy holat) ──────────────────────
  const activeStaff = staff.filter((u) => !u.isArchived);
  const composition = {
    total: activeStaff.length,
    active: activeStaff.filter((u) => u.isActive).length,
    inactive: activeStaff.filter((u) => !u.isActive).length,
    archived: staff.length - activeStaff.length,
    male: activeStaff.filter((u) => u.gender === "male").length,
    female: activeStaff.filter((u) => u.gender === "female").length,
    genderUnknown: activeStaff.filter((u) => !u.gender).length,
  };
  composition.activePercent = percentOf(composition.active, composition.total);
  composition.roleCount = new Set(activeStaff.map((u) => u.role)).size;
  // Arxiv bilan birga — doiraviy diagrammaning maxraji. Foiz FRONTENDDA
  // hisoblanmasligi uchun ulushlar ham shu yerdan chiqadi: aks holda bitta
  // ekranda "Faol 83.3%" (arxiv bilan) va "100% faollik" (arxivsiz) yonma-yon
  // turib, ikkalasi ham "faol ulushi" deb o'qilardi.
  composition.listedTotal = staff.length;
  composition.statusShare = {
    active: percentOf(composition.active, composition.listedTotal),
    inactive: percentOf(composition.inactive, composition.listedTotal),
    archived: percentOf(composition.archived, composition.listedTotal),
  };

  // ── Rol bo'yicha taqsimot ─────────────────────
  const roleCounts = new Map();
  for (const user of staff) {
    if (!roleCounts.has(user.role)) {
      roleCounts.set(user.role, { total: 0, active: 0, archived: 0 });
    }
    const row = roleCounts.get(user.role);
    if (user.isArchived) row.archived += 1;
    else {
      row.total += 1;
      if (user.isActive) row.active += 1;
    }
  }
  const byRole = [...roleCounts.entries()]
    .map(([role, counts]) => ({
      role,
      label: labelOf(role),
      ...counts,
      percent: percentOf(counts.total, composition.total),
    }))
    // Hammasi arxivlangan rol taqsimotda turmaydi: uning ulushi 0% va
    // diagrammada bo'sh sektor bo'lib qolardi (arxiv soni kartalarda bor)
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));

  // ── Oqim va shtat dinamikasi ──────────────────
  //
  // Oy oxiridagi shtat soni: o'sha paytgacha yaratilgan va hali
  // arxivlanmagan xodimlar. Diagramma shu chiziqni ko'rsatadi — bitta
  // oyning "qo'shildi/ketdi" raqami o'z-o'zicha tendensiyani bermaydi.
  const headcountAt = (instant) =>
    staff.filter(
      (u) => u.createdAt < instant && (!u.archivedAt || u.archivedAt >= instant),
    ).length;

  const trend = [];
  for (let i = TREND_MONTHS - 1; i >= 0; i -= 1) {
    const key = shiftMonthKey(monthKey, -i);
    trend.push({
      monthKey: key,
      label: formatMonthKey(key),
      short: formatMonthShort(key),
      joined: 0,
      left: 0,
      headcount: headcountAt(monthStartInstant(shiftMonthKey(key, 1))),
    });
  }
  const trendIndex = new Map(trend.map((row) => [row.monthKey, row]));

  for (const user of staff) {
    const joinedRow = trendIndex.get(monthKeyOfInstant(user.createdAt));
    if (joinedRow) joinedRow.joined += 1;

    if (user.archivedAt) {
      const leftRow = trendIndex.get(monthKeyOfInstant(user.archivedAt));
      if (leftRow) leftRow.left += 1;
    }
  }

  const currentFlow = trendIndex.get(monthKey);
  const previousFlow = trendIndex.get(prevKey) ?? null;
  const flow = {
    joined: currentFlow.joined,
    left: currentFlow.left,
    net: currentFlow.joined - currentFlow.left,
    trend,
  };

  // ── Oldingi oy bilan taqqoslash ───────────────
  const prevHeadcount = headcountAt(monthStartInstant(monthKey));
  const previous = {
    total: prevHeadcount,
    totalChangePercent: prevHeadcount
      ? Math.round(((currentFlow.headcount - prevHeadcount) / prevHeadcount) * 1000) / 10
      : null,
    attendancePercent: previousSlice.attendance?.percent ?? null,
    taskCompletionRate: previousSlice.tasks.completionRate,
    penaltyCount: previousSlice.penalties.count,
  };

  // ── Radar ko'rsatkichlari ─────────────────────
  //
  // Har biri HAQIQIY nisbat, 0..100 shkalada — o'ylab topilgan "ball" emas.
  // Davomat qatori faqat ruxsat bo'lganda qo'shiladi.
  const disciplineOf = (slice) =>
    percentOf(composition.total - slice.penalties.staffWithPenalty, composition.total);
  const stabilityOf = (leftCount) =>
    percentOf(composition.total - leftCount, composition.total);

  // ⚠️ Har bir o'lchov OYDAN OYGA o'zgarishi shart. "Faol xodimlar ulushi"
  // ataylab yo'q: `isActive` da tarix yo'q, ya'ni uning "o'tgan oyi" joriy
  // qiymatning nusxasi bo'lib, radar'da soxta taqqoslash chizardi.
  const indicators = [
    ...(withAttendance
      ? [
          {
            key: "attendance",
            label: "Davomat",
            shortLabel: "Davomat",
            current: current.attendance?.percent ?? null,
            previous: previousSlice.attendance?.percent ?? null,
          },
          {
            key: "punctuality",
            label: "O'z vaqtida kelish",
            shortLabel: "O'z vaqtida",
            current: current.attendance?.punctuality ?? null,
            previous: previousSlice.attendance?.punctuality ?? null,
          },
        ]
      : []),
    {
      key: "tasks",
      label: "Topshiriq bajarilishi",
      shortLabel: "Topshiriq",
      current: current.tasks.completionRate,
      previous: previousSlice.tasks.completionRate,
    },
    {
      key: "discipline",
      label: "Jarimasiz xodimlar",
      shortLabel: "Jarimasiz",
      current: disciplineOf(current),
      previous: disciplineOf(previousSlice),
    },
    {
      key: "stability",
      label: "Shtat barqarorligi",
      shortLabel: "Barqarorlik",
      current: stabilityOf(currentFlow.left),
      previous: stabilityOf(previousFlow?.left ?? 0),
    },
  ];

  // ── Bugungi davomat (faqat joriy oy) ──────────
  let today = null;
  if (withAttendance && isCurrentMonth) {
    today = { present: 0, late: 0, absent: 0, excused: 0 };
    for (const row of todayRows) {
      if (today[row.status] !== undefined) today[row.status] += row._count._all;
    }
    today.marked = today.present + today.late + today.absent + today.excused;
    today.notMarked = Math.max(0, composition.total - today.marked);
    today.percent = attendancePercent(today);
  }
  if (current.attendance) current.attendance.today = today;

  // ── Tezkor statistika ─────────────────────────
  //
  // Qaysi qatorlar chiqishi RUXSATGA va tanlangan oyga bog'liq, shuning
  // uchun ro'yxatni server yig'adi. Frontend faqat kalitga ikonka biriktiradi.
  const quickStats = [
    ...(today
      ? [
          {
            key: "todayAttended",
            label: "Bugun ishga kelganlar",
            value: today.present + today.late,
            percent: percentOf(today.present + today.late, composition.total),
            tone: "good",
          },
          {
            key: "todayLate",
            label: "Bugun kech qolganlar",
            value: today.late,
            percent: percentOf(today.late, composition.total),
            tone: today.late > 0 ? "warn" : "good",
          },
          {
            key: "todayNotMarked",
            label: "Bugun belgilanmagan",
            value: today.notMarked,
            percent: percentOf(today.notMarked, composition.total),
            tone: today.notMarked > 0 ? "neutral" : "good",
          },
        ]
      : []),
    {
      key: "withTasks",
      label: "Topshiriq berilgan xodimlar",
      value: current.tasks.staffWithTasks,
      percent: percentOf(current.tasks.staffWithTasks, composition.total),
      tone: "neutral",
    },
    {
      key: "withPenalty",
      label: "Jarima olgan xodimlar",
      value: current.penalties.staffWithPenalty,
      percent: percentOf(current.penalties.staffWithPenalty, composition.total),
      tone: current.penalties.staffWithPenalty > 0 ? "bad" : "good",
    },
    {
      key: "joined",
      label: "Bu oy ishga qabul qilinganlar",
      value: flow.joined,
      percent: percentOf(flow.joined, composition.total),
      tone: "neutral",
    },
    {
      key: "left",
      label: "Bu oy arxivlanganlar",
      value: flow.left,
      percent: percentOf(flow.left, composition.total),
      tone: flow.left > 0 ? "warn" : "good",
    },
  ];

  // ── Fanlar: kim nimadan dars beradi ───────────
  //
  // ⚠️ Ikki xil "o'qituvchi" tushunchasi ATAYLAB ajratilgan:
  //   · fanga biriktirilgan HAR KIM dars beradi — rahbar ham fan olishi
  //     mumkin, shuning uchun `bySubject` roli bo'yicha filtrlanmaydi;
  //   · "fansiz o'qituvchi" esa faqat `teacher` rolidagilar uchun kamchilik —
  //     tozalovchida fan bo'lmagani muammo emas.
  // Arxivlangan xodim hech qayerda sanalmaydi: u fanni "qoplamaydi".
  const activeIds = new Set(activeStaff.map((u) => u.id));
  const activeLinks = subjectLinks.filter((link) => activeIds.has(link.userId));

  const teachersOfSubject = new Map();
  const subjectsOfTeacher = new Map();
  for (const link of activeLinks) {
    if (!teachersOfSubject.has(link.subjectId)) {
      teachersOfSubject.set(link.subjectId, []);
    }
    teachersOfSubject.get(link.subjectId).push(link.userId);

    if (!subjectsOfTeacher.has(link.userId)) {
      subjectsOfTeacher.set(link.userId, []);
    }
    subjectsOfTeacher.get(link.userId).push(link.subjectId);
  }

  const subjectNames = new Map(subjectRows.map((row) => [row.id, row.name]));

  const bySubject = subjectRows
    .map((row) => {
      const ids = teachersOfSubject.get(row.id) ?? [];
      return {
        subjectId: row.id,
        name: row.name,
        isActive: row.isActive,
        teacherCount: ids.length,
        teachers: ids
          .map((id) => staffMap.get(id))
          .filter(Boolean)
          .map(({ userId, name, roleLabel }) => ({ userId, name, roleLabel }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    })
    .sort(
      (a, b) => b.teacherCount - a.teacherCount || a.name.localeCompare(b.name),
    );

  // Qamrov faqat AMALDAGI fanlar bo'yicha: o'chirilgan fan o'quv rejasida
  // yo'q, uning o'qituvchisizligi kamchilik emas
  const activeSubjects = bySubject.filter((row) => row.isActive);
  const uncovered = activeSubjects.filter((row) => row.teacherCount === 0);

  const teacherStaff = activeStaff.filter((u) => u.role === "teacher");
  const withoutSubject = teacherStaff.filter((u) => !subjectsOfTeacher.has(u.id));

  // Nisbat hisoblari uchun kesimlar (yuqoridagi izohga qarang)
  const activeSubjectIds = new Set(
    subjectRows.filter((row) => row.isActive).map((row) => row.id),
  );
  const teacherIds = new Set(teacherStaff.map((u) => u.id));
  const linksOnActiveSubjects = activeLinks.filter((link) =>
    activeSubjectIds.has(link.subjectId),
  );
  const teacherLinks = linksOnActiveSubjects.filter((link) =>
    teacherIds.has(link.userId),
  );

  const multiSubjectAll = [...subjectsOfTeacher.entries()].filter(
    ([, ids]) => ids.length > 1,
  );
  const multiSubject = multiSubjectAll
    .map(([userId, ids]) => ({
      ...staffMap.get(userId),
      subjectCount: ids.length,
      subjects: ids
        .map((id) => subjectNames.get(id))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    }))
    .filter((row) => row.userId)
    .sort((a, b) => b.subjectCount - a.subjectCount || a.name.localeCompare(b.name))
    .slice(0, TOP_LIMIT);

  const subjects = {
    totalSubjects: activeSubjects.length,
    coveredSubjects: activeSubjects.length - uncovered.length,
    uncoveredSubjects: uncovered.length,
    teacherTotal: teacherStaff.length,
    teachersWithSubject: teacherStaff.filter((u) => subjectsOfTeacher.has(u.id))
      .length,
    teachersWithoutSubject: withoutSubject.length,
    // O'rtachalar — "bitta fanga nechta odam" degan savolning ikki tomoni.
    //
    // ⚠️ Har bir nisbatning SURATI VA MAXRAJI bir xil to'plam ustida
    // bo'lishi shart. Ilgari ikkalasining ham surati `activeLinks` edi va
    // natijada:
    //   · fanga o'rtacha — suratda O'CHIRILGAN fanlarning biriktirishlari
    //     ham turardi, maxrajda esa faqat amaldagi fanlar;
    //   · o'qituvchiga o'rtacha — suratda direktor/mudirning fanlari ham
    //     turardi, maxrajda esa faqat `teacher` rolidagilar.
    // Ikkala raqam ham yuqoriga qarab yolg'on ko'rsatardi.
    avgTeachersPerSubject: activeSubjects.length
      ? Math.round((linksOnActiveSubjects.length / activeSubjects.length) * 10) / 10
      : null,
    avgSubjectsPerTeacher: teacherStaff.length
      ? Math.round((teacherLinks.length / teacherStaff.length) * 10) / 10
      : null,
    coveragePercent: percentOf(
      activeSubjects.length - uncovered.length,
      activeSubjects.length,
    ),
    bySubject,
    uncovered: uncovered.map(({ subjectId, name }) => ({ subjectId, name })),
    unassignedTeachers: withoutSubject
      .slice(0, TOP_LIMIT)
      .map((u) => staffMap.get(u.id)),
    multiSubject,
    multiSubjectTotal: multiSubjectAll.length,
  };

  // ── Staj: eng uzoq ishlayotganlar ─────────────
  // To'liq oylar: 20-avgustda kirgan odam 1-sentabrda hali bir oy ishlamagan
  const monthsSince = (from) => {
    let months =
      (now.getUTCFullYear() - from.getUTCFullYear()) * 12 +
      (now.getUTCMonth() - from.getUTCMonth());
    if (now.getUTCDate() < from.getUTCDate()) months -= 1;
    return Math.max(0, months);
  };

  const tenure = [...activeStaff]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, TOP_LIMIT)
    .map((user) => ({
      ...staffMap.get(user.id),
      joinedAt: user.createdAt,
      months: monthsSince(user.createdAt),
      attendancePercent: current.attendanceByUser.get(user.id) ?? null,
    }));

  return {
    month: m,
    year: y,
    isCurrentMonth,
    composition,
    previous,
    byRole,
    flow,
    penalties: current.penalties,
    tasks: current.tasks,
    attendance: current.attendance,
    indicators,
    quickStats,
    subjects,
    tenure,
  };
}

module.exports = { getStaffReport };
