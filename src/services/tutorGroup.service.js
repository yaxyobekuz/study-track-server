/**
 * TYUTOR GURUHLARI — tyutorga sinf (guruh) biriktirish, SHU biriktirish uchun
 * qo'shimcha oylik stavkalari va guruh manzarasi (o'quvchilar, davomat, baho).
 *
 *   qo'shimcha oylik = groupAmount + perStudentAmount × o'quvchilar soni
 *
 * ⚠️ FORMULA BU YERDA YOZILMAYDI — `computeTutorGroupAmount`
 * (`salaryRules.helpers.js`). Oylik dvigateli (`payrollEngine`) uni USTAMA
 * qatori sifatida qo'shadi va majburiyatga muhrlaydi; bu servis faqat
 * qoidani (kim, qaysi sinf, qancha, qaysi davr) saqlaydi va ko'rsatadi.
 *
 * ⚠️ TYUTOR — ROL BELGISI (`Role.isTutor`), rol kaliti EMAS: rollar dinamik,
 * kalitni kodga qotirsak boshqacha nomlangan rol egasi jimgina guruhsiz qolardi.
 *
 * ⚠️ BIR OYDA BIR SINFGA BITTA TYUTOR. Kesishuv sinf bo'yicha advisory lock
 * ichida tekshiriladi: ikki parallel so'rov bitta sinfni ikki kishiga yozsa,
 * bitta sinf uchun ikki qo'shimcha oylik to'lanardi.
 *
 * ⚠️ DAVR QOIDASI (`staffContract` bilan bir xil): o'tgan oydan boshlangan
 * biriktirishning summasi o'zgarsa, eski qator oldingi oyda yopiladi va joriy
 * oydan yangi qator ochiladi — o'tgan oylar eski summada qoladi. Muhrlangan
 * majburiyatga TEGILMAYDI, faqat ogohlantiriladi.
 */

const prisma = require("../config/prisma");
const platformPrisma = require("../config/platformPrisma");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const { hasRole } = require("../utils/permissions");
const { isValidId } = require("../utils/objectId");
const logger = require("../utils/logger");
const { Decimal, parseAmount, formatAmount, sumAmounts } = require("../helpers/money.helpers");
const { computeTutorGroupAmount } = require("../helpers/salaryRules.helpers");
const {
  currentMonthKey,
  currentDayDate,
  parseMonthKey,
  parseOptionalMonthKey,
  formatMonthKey,
  formatMonthRange,
  coveringMonthWhere,
  overlappingPeriodWhere,
  prevMonth,
  nextMonth,
  monthInstantRange,
} = require("../helpers/month.helpers");
const payrollAudit = require("./payrollAudit.service");

const NOTE_MAX = 500;

const CLASS_SELECT = { select: { id: true, name: true, isActive: true } };

const STATUS_LABELS = {
  planned: "Rejada",
  active: "Amalda",
  ended: "Tugagan",
};

const ATTENDANCE_LABELS = {
  present: "Keldi",
  late: "Kech keldi",
  absent: "Kelmadi",
  excused: "Sababli",
};

// Olib tashlash qaysi oydan kuchga kiradi
const REMOVE_EFFECTIVE = ["current", "next"];

const fullName = (u) => (u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() : "");

// ─────────────────────────────────────────────
// Tyutor roli va o'quvchilar soni
// ─────────────────────────────────────────────

/** Tyutor belgisi qo'yilgan rollar kalitlari (platforma, barcha filiallarga umumiy). */
const loadTutorRoleValues = async () => {
  const rows = await platformPrisma.role.findMany({
    where: { isTutor: true },
    select: { value: true },
  });
  return rows.map((r) => r.value);
};

/**
 * Odam tyutormi — asosiy YOKI qo'shimcha roli bo'yicha (`hasRole`).
 * @param {{role: string, extraRoles?: string[]}} user
 * @param {string[]} tutorRoles - `loadTutorRoleValues()` natijasi
 */
const isTutorUser = (user, tutorRoles) =>
  Boolean(user) && user.role !== ROLES.STUDENT && tutorRoles.length > 0 && hasRole(user, tutorRoles);

/**
 * Sinflardagi o'quvchilar soni — BITTA guruhlangan so'rov.
 *
 * Arxivlangan o'quvchi sanalmaydi: sinflar ro'yxatidagi raqam bilan AYNAN bir
 * xil qoida (`class.service.getAllClasses`). Aks holda tyutor kartasida bir
 * son, sinflar sahifasida boshqa son turardi.
 *
 * @param {string[]} classIds
 * @returns {Promise<Map<string, number>>}
 */
const countStudentsByClass = async (classIds) => {
  const ids = [...new Set(classIds)].filter(Boolean);
  if (ids.length === 0) return new Map();

  const rows = await prisma.userClass.groupBy({
    by: ["classId"],
    where: { classId: { in: ids }, user: { role: ROLES.STUDENT, isArchived: false } },
    _count: { userId: true },
  });
  return new Map(rows.map((r) => [r.classId, r._count.userId]));
};

/**
 * Oy uchun amaldagi tyutor guruhlari — oylik dvigateli konteksti uchun.
 *
 * @param {number} month - YYYYMM
 * @param {string[]} staffIds
 * @returns {Promise<{ groupMap: Map<string, Array>, studentCounts: Map<string, number> }>}
 */
const loadGroupsForPayroll = async (month, staffIds) => {
  if (!staffIds.length) return { groupMap: new Map(), studentCounts: new Map() };

  const rows = await prisma.tutorGroup.findMany({
    where: { tutorId: { in: staffIds }, ...coveringMonthWhere(month) },
    include: { class: CLASS_SELECT },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const groupMap = new Map();
  for (const row of rows) {
    if (!groupMap.has(row.tutorId)) groupMap.set(row.tutorId, []);
    groupMap.get(row.tutorId).push(row);
  }

  const studentCounts = await countStudentsByClass(rows.map((r) => r.classId));
  return { groupMap, studentCounts };
};

/**
 * Shu oydan boshlab guruhi bor tyutorlar — oylik oladiganlar ro'yxatiga
 * qo'shiladi. Lavozimi/toifasi yo'q tyutorning qo'shimcha oyligi jimgina
 * yo'qolmasligi uchun.
 *
 * @param {number} month - YYYYMM
 * @param {{ fromMonth?: boolean }} [options] - true → shu oy VA keyingi oylar
 * @returns {Promise<string[]>}
 */
const resolveTutorIdsForMonth = async (month, { fromMonth = false } = {}) => {
  const rows = await prisma.tutorGroup.findMany({
    where: fromMonth
      ? { OR: [{ endMonth: null }, { endMonth: { gte: month } }] }
      : coveringMonthWhere(month),
    select: { tutorId: true },
    distinct: ["tutorId"],
  });
  return rows.map((r) => r.tutorId);
};

// ─────────────────────────────────────────────
// Serializatsiya
// ─────────────────────────────────────────────

const statusOf = (row, current) => {
  if (row.startMonth > current) return "planned";
  if (row.endMonth != null && row.endMonth < current) return "ended";
  return "active";
};

const serializeGroup = (row, { studentCount = 0, current = currentMonthKey(), tutor = null } = {}) => {
  const status = statusOf(row, current);
  return {
    id: row.id,
    tutorId: row.tutorId,
    tutorName: tutor ? fullName(tutor) : undefined,
    classId: row.classId,
    className: row.class?.name ?? "",
    classIsActive: row.class?.isActive ?? true,
    perStudentAmount: formatAmount(row.perStudentAmount),
    groupAmount: formatAmount(row.groupAmount),
    studentCount,
    monthlyAmount: formatAmount(computeTutorGroupAmount(row, studentCount)),
    startMonth: row.startMonth,
    startMonthLabel: formatMonthKey(row.startMonth),
    endMonth: row.endMonth,
    endMonthLabel: row.endMonth != null ? formatMonthKey(row.endMonth) : null,
    periodLabel: formatMonthRange(row.startMonth, row.endMonth),
    status,
    statusLabel: STATUS_LABELS[status],
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

// ─────────────────────────────────────────────
// Tekshiruvlar
// ─────────────────────────────────────────────

const assertId = (id, label) => {
  if (!isValidId(id)) throw new BadRequestError(`${label} noto'g'ri`);
};

const parseNote = (value) => {
  const note = String(value ?? "").trim();
  if (note.length > NOTE_MAX) {
    throw new BadRequestError(`Izoh ${NOTE_MAX} belgidan oshmasligi kerak`);
  }
  return note;
};

/** Tyutor: mavjud, xodim, arxivlanmagan va tyutor roli bor. */
const loadTutor = async (tutorId) => {
  assertId(tutorId, "Tyutor");
  const [tutor, tutorRoles] = await Promise.all([
    prisma.user.findUnique({
      where: { id: tutorId },
      select: { id: true, firstName: true, lastName: true, role: true, extraRoles: true, isArchived: true },
    }),
    loadTutorRoleValues(),
  ]);

  if (!tutor) throw new NotFoundError("Xodim topilmadi");
  if (tutor.role === ROLES.STUDENT) {
    throw new BadRequestError("O'quvchiga guruh biriktirilmaydi");
  }
  if (tutor.isArchived) {
    throw new BadRequestError("Arxivlangan xodimga guruh biriktirilmaydi");
  }
  if (!isTutorUser(tutor, tutorRoles)) {
    throw new BadRequestError(
      "Bu xodimda tyutor roli yo'q. Xodimga tyutor rolini bering yoki Rollar " +
        "sahifasida rolga \"Tyutor\" belgisini qo'ying",
    );
  }
  return tutor;
};

/**
 * Bitta sinf bo'yicha biriktirishlarni ketma-ket qiladi (tranzaksiya
 * tugaganda qulf o'zi bo'shaydi). `$executeRaw`: `pg_advisory_xact_lock`
 * `void` qaytaradi (`scheduleWriteGuard.service.js` izohiga qarang).
 */
const lockClass = (tx, classId) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tutor_group:${classId}`}))`;

/**
 * Sinf shu davrda boshqa (yoki shu) tyutorga biriktirilmaganini tekshiradi.
 * Qulf ICHIDA va `tx` bilan chaqiriladi.
 */
const assertNoOverlap = async (tx, { classId, tutorId, startMonth, endMonth, excludeIds = [] }) => {
  const clash = await tx.tutorGroup.findFirst({
    where: {
      classId,
      ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}),
      ...overlappingPeriodWhere(startMonth, endMonth),
    },
    include: { class: CLASS_SELECT },
    orderBy: { startMonth: "asc" },
  });
  if (!clash) return;

  const className = clash.class?.name ?? "Sinf";
  const period = formatMonthRange(clash.startMonth, clash.endMonth);

  if (clash.tutorId === tutorId) {
    throw new ConflictError(`${className} sinfi bu tyutorga allaqachon biriktirilgan (${period})`);
  }

  const other = await tx.user.findUnique({
    where: { id: clash.tutorId },
    select: { firstName: true, lastName: true },
  });
  throw new ConflictError(
    `${className} sinfi ${period} davrida ${fullName(other) || "boshqa tyutor"} ga ` +
      `biriktirilgan. Bir oyda bir sinfga bitta tyutor — boshqa oydan boshlang ` +
      `yoki avval u yerdan olib tashlang`,
  );
};

/**
 * Muhrlangan oylik ogohlantirishi: o'zgarish allaqachon shakllangan
 * majburiyatga qo'shilmaydi (hisob-faktura doktrinasi).
 */
const sealedWarnings = async (tutorId, fromMonth) => {
  const entries = await prisma.payrollEntry.findMany({
    where: { staffId: tutorId, month: { gte: fromMonth }, status: { not: "cancelled" } },
    select: { month: true },
    orderBy: { month: "asc" },
  });
  if (entries.length === 0) return [];
  return [
    `${entries.map((e) => formatMonthKey(e.month)).join(", ")} oyligi allaqachon ` +
      `shakllangan — o'zgarish unga qo'shilmaydi. Kerak bo'lsa majburiyat bekor ` +
      `qilinib, oy qayta shakllantiriladi.`,
  ];
};

const auditSnapshot = (row) => ({
  classId: row.classId,
  className: row.class?.name ?? null,
  perStudentAmount: formatAmount(row.perStudentAmount),
  groupAmount: formatAmount(row.groupAmount),
  startMonth: row.startMonth,
  endMonth: row.endMonth,
  note: row.note,
});

// ─────────────────────────────────────────────
// O'qish
// ─────────────────────────────────────────────

/**
 * Xodimning tyutor guruhlari: amaldagi va rejadagilari (`groups`), tugaganlari
 * (`history`) va joriy oy yig'indisi.
 *
 * @param {string} staffId
 */
const getStaffGroups = async (staffId) => {
  assertId(staffId, "Xodim");
  const current = currentMonthKey();

  const [staff, tutorRoles, rows] = await Promise.all([
    prisma.user.findUnique({
      where: { id: staffId },
      select: { id: true, firstName: true, lastName: true, role: true, extraRoles: true, isArchived: true },
    }),
    loadTutorRoleValues(),
    prisma.tutorGroup.findMany({
      where: { tutorId: staffId },
      include: { class: CLASS_SELECT },
      orderBy: [{ startMonth: "desc" }, { createdAt: "desc" }],
    }),
  ]);
  if (!staff) throw new NotFoundError("Xodim topilmadi");

  const counts = await countStudentsByClass(rows.map((r) => r.classId));
  const items = rows.map((row) =>
    serializeGroup(row, { studentCount: counts.get(row.classId) ?? 0, current }),
  );

  const groups = items
    .filter((g) => g.status !== "ended")
    .sort((a, b) => a.className.localeCompare(b.className, "uz") || a.startMonth - b.startMonth);
  const history = items.filter((g) => g.status === "ended");
  const active = items.filter((g) => g.status === "active");

  return {
    staff: {
      id: staff.id,
      fullName: fullName(staff),
      isTutor: isTutorUser(staff, tutorRoles),
      isArchived: staff.isArchived,
    },
    month: current,
    monthLabel: formatMonthKey(current),
    groups,
    history,
    totals: {
      groupCount: active.length,
      studentCount: active.reduce((sum, g) => sum + g.studentCount, 0),
      monthlyAmount: formatAmount(sumAmounts(active.map((g) => g.monthlyAmount))),
    },
  };
};

/**
 * Biriktirish oynasi uchun sinflar: o'quvchilar soni va shu oydan boshlab
 * kimga biriktirilgani (band bo'lsa oldindan ko'rinsin).
 *
 * @param {{ tutorId?: string, month?: string|number }} query
 */
const getClassOptions = async ({ tutorId, month } = {}) => {
  const fromMonth = month ? parseMonthKey(month, "Oy") : currentMonthKey();

  const [classes, holders] = await Promise.all([
    prisma.class.findMany({
      select: { id: true, name: true, isActive: true },
      orderBy: { name: "asc" },
    }),
    prisma.tutorGroup.findMany({
      where: overlappingPeriodWhere(fromMonth, null),
      select: { classId: true, tutorId: true, startMonth: true, endMonth: true },
      orderBy: { startMonth: "asc" },
    }),
  ]);

  const [counts, tutors] = await Promise.all([
    countStudentsByClass(classes.map((c) => c.id)),
    holders.length
      ? prisma.user.findMany({
          where: { id: { in: [...new Set(holders.map((h) => h.tutorId))] } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [],
  ]);
  const tutorMap = new Map(tutors.map((t) => [t.id, t]));

  const holdersByClass = new Map();
  for (const h of holders) {
    if (!holdersByClass.has(h.classId)) holdersByClass.set(h.classId, []);
    holdersByClass.get(h.classId).push({
      tutorId: h.tutorId,
      tutorName: fullName(tutorMap.get(h.tutorId)) || "Noma'lum",
      periodLabel: formatMonthRange(h.startMonth, h.endMonth),
      isMine: Boolean(tutorId) && h.tutorId === tutorId,
    });
  }

  return {
    month: fromMonth,
    monthLabel: formatMonthKey(fromMonth),
    items: classes.map((c) => ({
      id: c.id,
      name: c.name,
      isActive: c.isActive,
      studentCount: counts.get(c.id) ?? 0,
      holders: holdersByClass.get(c.id) ?? [],
    })),
  };
};

/**
 * GURUH MANZARASI — o'quvchilar, bugungi davomat, oylik davomat va baholar,
 * qo'shimcha oylik.
 *
 * Davomat oylik ko'rsatkichlari davomat hisobotining O'ZIDAN olinadi
 * (`attendanceReport.getClassReport`) — "kutilgan kun" va foiz qoidasi bitta
 * joyda qoladi, tyutor ekranida boshqa foiz chiqmaydi.
 *
 * @param {string} groupId
 * @param {{ month?: string|number }} query
 * @param {{ id: string, onlyOwn: boolean }} viewer - tyutor faqat o'z guruhini ko'radi
 */
const getGroupOverview = async (groupId, { month } = {}, viewer) => {
  assertId(groupId, "Guruh");
  const current = currentMonthKey();
  const monthKey = month ? parseMonthKey(month, "Oy") : current;
  if (monthKey > current) {
    throw new BadRequestError("Kelajakdagi oy uchun ma'lumot yo'q");
  }

  const row = await prisma.tutorGroup.findUnique({
    where: { id: groupId },
    include: { class: CLASS_SELECT },
  });
  if (!row) throw new NotFoundError("Guruh topilmadi");
  if (viewer?.onlyOwn && row.tutorId !== viewer.id) {
    throw new ForbiddenError("Bu guruh sizga biriktirilmagan");
  }

  const { classId } = row;
  // Kechiktirilgan require: oylik dvigateli bu faylni yuklaydi, davomat
  // hisoboti esa unga kerak emas (og'ir bog'liqliklar zanjiri tortilmasin)
  const { getClassReport } = require("./attendanceReport.service");
  const { loadArchivedStudentScope } = require("./archivedStudentScope.service");

  const [tutor, students, report, scope, entry] = await Promise.all([
    prisma.user.findUnique({
      where: { id: row.tutorId },
      select: { id: true, firstName: true, lastName: true },
    }),
    prisma.user.findMany({
      where: { role: ROLES.STUDENT, isArchived: false, classes: { some: { classId } } },
      select: { id: true, firstName: true, lastName: true, username: true },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
    getClassReport(classId, {
      period: "month",
      month: monthKey % 100,
      year: Math.trunc(monthKey / 100),
    }),
    loadArchivedStudentScope(),
    prisma.payrollEntry.findFirst({
      where: { staffId: row.tutorId, month: monthKey, status: { not: "cancelled" } },
      select: { allowanceBreakdown: true },
    }),
  ]);

  const studentIds = students.map((s) => s.id);
  const today = currentDayDate();
  const { from, to } = monthInstantRange(monthKey);
  const gradeWhere = { studentId: { in: studentIds }, date: { gte: from, lte: to }, ...scope };

  const [todayRecords, gradesByStudent, gradesBySubject] = studentIds.length
    ? await Promise.all([
        prisma.studentAttendance.findMany({
          where: { date: today, studentId: { in: studentIds } },
          select: { studentId: true, status: true, excuseReason: true },
        }),
        prisma.grade.groupBy({
          by: ["studentId"],
          where: gradeWhere,
          _avg: { grade: true },
          _count: { _all: true },
        }),
        prisma.grade.groupBy({
          by: ["subjectId"],
          where: gradeWhere,
          _avg: { grade: true },
          _count: { _all: true },
        }),
      ])
    : [[], [], []];

  const subjects = gradesBySubject.length
    ? await prisma.subject.findMany({
        where: { id: { in: gradesBySubject.map((g) => g.subjectId) } },
        select: { id: true, name: true },
      })
    : [];
  const subjectMap = new Map(subjects.map((s) => [s.id, s.name]));

  const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
  const todayMap = new Map(todayRecords.map((r) => [r.studentId, r]));
  const gradeMap = new Map(gradesByStudent.map((g) => [g.studentId, g]));
  const reportMap = new Map((report.students || []).map((s) => [s.studentId, s]));

  // ── Bugun ──
  const todaySummary = { total: students.length, came: 0, present: 0, late: 0, absent: 0, excused: 0, unmarked: 0 };
  for (const s of students) {
    const status = todayMap.get(s.id)?.status;
    if (status && todaySummary[status] !== undefined) todaySummary[status] += 1;
    else todaySummary.unmarked += 1;
  }
  todaySummary.came = todaySummary.present + todaySummary.late;

  // ── Baho (butun guruh) ──
  let gradeSum = 0;
  let gradeCount = 0;
  for (const g of gradesByStudent) {
    gradeSum += (g._avg.grade ?? 0) * g._count._all;
    gradeCount += g._count._all;
  }

  // ── Qo'shimcha oylik: jonli va (bo'lsa) muhrlangan ──
  const studentCount = students.length;
  const sealedLine = Array.isArray(entry?.allowanceBreakdown)
    ? entry.allowanceBreakdown.find((line) => line?.type === "tutor" && line.tutorGroupId === row.id) ||
      entry.allowanceBreakdown.find((line) => line?.type === "tutor" && line.classId === classId)
    : null;

  const s = report.summary || {};

  return {
    group: serializeGroup(row, { studentCount, current, tutor }),
    tutor: tutor ? { id: tutor.id, fullName: fullName(tutor) } : null,
    month: monthKey,
    monthLabel: formatMonthKey(monthKey),
    isCurrentMonth: monthKey === current,
    today: {
      date: today.toISOString().slice(0, 10),
      summary: todaySummary,
    },
    attendance: {
      percent: s.percent ?? null,
      came: s.came ?? 0,
      expected: s.expected ?? 0,
      present: s.present ?? 0,
      late: s.late ?? 0,
      absent: s.absent ?? 0,
      excused: s.excused ?? 0,
      unmarked: s.unmarked ?? 0,
      schoolDays: s.schoolDays ?? 0,
      byDay: report.byDay ?? [],
    },
    grades: {
      average: gradeCount ? round2(gradeSum / gradeCount) : null,
      count: gradeCount,
      bySubject: gradesBySubject
        .map((g) => ({
          subjectId: g.subjectId,
          subjectName: subjectMap.get(g.subjectId) || "Fan",
          average: round2(g._avg.grade),
          count: g._count._all,
        }))
        .sort((a, b) => a.subjectName.localeCompare(b.subjectName, "uz")),
    },
    payroll: {
      liveAmount: formatAmount(computeTutorGroupAmount(row, studentCount)),
      sealed: sealedLine
        ? { amount: sealedLine.amount, studentCount: sealedLine.studentCount ?? null }
        : null,
    },
    students: students.map((st) => {
      const rec = todayMap.get(st.id);
      const monthRow = reportMap.get(st.id);
      const grade = gradeMap.get(st.id);
      return {
        id: st.id,
        fullName: `${st.lastName ?? ""} ${st.firstName ?? ""}`.trim(),
        username: st.username,
        today: {
          status: rec?.status ?? null,
          statusLabel: rec ? ATTENDANCE_LABELS[rec.status] ?? rec.status : "Belgilanmagan",
          excuseReason: rec?.excuseReason ?? null,
        },
        attendance: monthRow
          ? {
              percent: monthRow.percent,
              came: monthRow.came,
              expected: monthRow.expected,
              absent: monthRow.absent,
              late: monthRow.late,
              excused: monthRow.excused,
              missed: monthRow.missed,
              maxStreak: monthRow.maxStreak,
            }
          : null,
        grades: {
          average: grade ? round2(grade._avg.grade) : null,
          count: grade?._count._all ?? 0,
        },
      };
    }),
  };
};

/**
 * JONLI HISOB — biriktirish oynasi uchun, hech narsa yozilmaydi. Summa
 * frontendda hisoblanmasligi uchun (formula bitta joyda).
 *
 * @param {{ classId: string, perStudentAmount?: *, groupAmount?: * }} data
 */
const previewAmount = async (data = {}) => {
  assertId(data.classId, "Sinf");
  const perStudentAmount = parseAmount(
    data.perStudentAmount === "" || data.perStudentAmount == null ? 0 : data.perStudentAmount,
    "Bitta o'quvchi uchun summa",
  );
  const groupAmount = parseAmount(
    data.groupAmount === "" || data.groupAmount == null ? 0 : data.groupAmount,
    "Guruh uchun summa",
  );
  const counts = await countStudentsByClass([data.classId]);
  const studentCount = counts.get(data.classId) ?? 0;

  return {
    studentCount,
    perStudentAmount: formatAmount(perStudentAmount),
    groupAmount: formatAmount(groupAmount),
    studentsAmount: formatAmount(computeTutorGroupAmount({ perStudentAmount, groupAmount: 0 }, studentCount)),
    amount: formatAmount(computeTutorGroupAmount({ perStudentAmount, groupAmount }, studentCount)),
  };
};

/**
 * TYUTORNING O'Z GURUHLARI — xodim paneli. Ruxsat kaliti yo'q, id tokendan.
 * Tugagan biriktirishlar ko'rsatilmaydi: tyutor bugungi ishini ko'radi.
 *
 * @param {string} userId - HAR DOIM req.user.id
 */
const getMyGroups = async (userId) => {
  const data = await getStaffGroups(userId);
  return { ...data, history: undefined };
};

// ─────────────────────────────────────────────
// Yozish
// ─────────────────────────────────────────────

/**
 * Tyutorga guruh (sinf) biriktiradi.
 * @param {object} data - { tutorId, classId, perStudentAmount, groupAmount, startMonth?, endMonth?, note? }
 * @param {string} actorId
 */
const createGroup = async (data = {}, actorId) => {
  const current = currentMonthKey();

  assertId(data.classId, "Sinf");
  const perStudentAmount = parseAmount(data.perStudentAmount ?? 0, "Bitta o'quvchi uchun summa");
  const groupAmount = parseAmount(data.groupAmount ?? 0, "Guruh uchun summa");
  const startMonth = data.startMonth ? parseMonthKey(data.startMonth, "Boshlanish oyi") : current;
  if (startMonth < current) {
    throw new BadRequestError(
      `O'tgan oyga guruh biriktirib bo'lmaydi — eng erta ${formatMonthKey(current)}`,
    );
  }
  const endMonth = parseOptionalMonthKey(data.endMonth, "Tugash oyi");
  if (endMonth != null && endMonth < startMonth) {
    throw new BadRequestError("Tugash oyi boshlanish oyidan oldin bo'lishi mumkin emas");
  }
  const note = parseNote(data.note);

  const tutor = await loadTutor(data.tutorId);
  const cls = await prisma.class.findUnique({ where: { id: data.classId }, select: { id: true, name: true, isActive: true } });
  if (!cls) throw new NotFoundError("Sinf topilmadi");
  if (!cls.isActive) throw new BadRequestError("Faol bo'lmagan sinfni biriktirib bo'lmaydi");

  const row = await prisma.$transaction(async (tx) => {
    await lockClass(tx, cls.id);
    await assertNoOverlap(tx, { classId: cls.id, tutorId: tutor.id, startMonth, endMonth });

    const created = await tx.tutorGroup.create({
      data: {
        tutorId: tutor.id,
        classId: cls.id,
        perStudentAmount,
        groupAmount,
        startMonth,
        endMonth,
        note,
        createdBy: actorId,
      },
      include: { class: CLASS_SELECT },
    });

    await payrollAudit.record(
      {
        actorId,
        action: "tutorGroup.create",
        targetType: "tutorGroup",
        targetId: created.id,
        summary:
          `${fullName(tutor)} — ${cls.name} guruhi biriktirildi ` +
          `(o'quvchiga ${formatAmount(perStudentAmount)}, guruhga ${formatAmount(groupAmount)})`,
        newValue: auditSnapshot(created),
      },
      tx,
    );
    return created;
  });

  logger.info(
    `[tutor] Guruh biriktirildi: tutor=${tutor.id} class=${cls.id} ` +
      `perStudent=${formatAmount(perStudentAmount)} group=${formatAmount(groupAmount)} ` +
      `start=${startMonth} actor=${actorId}`,
  );

  const [counts, warnings] = await Promise.all([
    countStudentsByClass([cls.id]),
    sealedWarnings(tutor.id, startMonth),
  ]);

  return {
    group: serializeGroup(row, { studentCount: counts.get(cls.id) ?? 0, current }),
    warnings,
  };
};

/**
 * Biriktirishni tahrirlaydi: summalar, tugash oyi, izoh (boshlanmagan bo'lsa —
 * boshlanish oyi ham).
 *
 * ⚠️ O'tgan oydan boshlangan qatorning SUMMASI o'zgarsa — davr bo'linadi:
 * eski qator oldingi oyda yopiladi, joriy oydan yangi qator ochiladi.
 *
 * @param {string} id
 * @param {object} data - { perStudentAmount?, groupAmount?, startMonth?, endMonth?, note? }
 * @param {string} actorId
 */
const updateGroup = async (id, data = {}, actorId) => {
  assertId(id, "Guruh");
  const current = currentMonthKey();

  const row = await prisma.tutorGroup.findUnique({ where: { id }, include: { class: CLASS_SELECT } });
  if (!row) throw new NotFoundError("Guruh topilmadi");
  if (row.endMonth != null && row.endMonth < current) {
    throw new BadRequestError(
      "Bu biriktirish tugagan — uni tahrirlab bo'lmaydi. Kerak bo'lsa guruhni qayta biriktiring",
    );
  }

  const perStudentAmount =
    data.perStudentAmount !== undefined
      ? parseAmount(data.perStudentAmount, "Bitta o'quvchi uchun summa")
      : new Decimal(row.perStudentAmount);
  const groupAmount =
    data.groupAmount !== undefined
      ? parseAmount(data.groupAmount, "Guruh uchun summa")
      : new Decimal(row.groupAmount);
  const note = data.note !== undefined ? parseNote(data.note) : row.note;

  let startMonth = row.startMonth;
  if (data.startMonth != null && data.startMonth !== "") {
    const requested = parseMonthKey(data.startMonth, "Boshlanish oyi");
    if (requested !== row.startMonth) {
      if (row.startMonth < current) {
        throw new BadRequestError(
          "Boshlangan biriktirishning boshlanish oyini o'zgartirib bo'lmaydi",
        );
      }
      if (requested < current) {
        throw new BadRequestError(
          `O'tgan oydan boshlab bo'lmaydi — eng erta ${formatMonthKey(current)}`,
        );
      }
      startMonth = requested;
    }
  }

  let endMonth = row.endMonth;
  if (data.endMonth !== undefined) {
    endMonth = parseOptionalMonthKey(data.endMonth, "Tugash oyi");
    const minEnd = Math.max(startMonth, current);
    if (endMonth != null && endMonth < minEnd) {
      throw new BadRequestError(
        `Tugash oyi ${formatMonthKey(minEnd)} dan oldin bo'lishi mumkin emas. ` +
          `Guruhni to'xtatish uchun "Olib tashlash" dan foydalaning`,
      );
    }
  }

  const amountsChanged =
    !perStudentAmount.equals(row.perStudentAmount) || !groupAmount.equals(row.groupAmount);
  const periodChanged = startMonth !== row.startMonth || endMonth !== row.endMonth;
  const noteChanged = note !== row.note;

  const counts = await countStudentsByClass([row.classId]);
  const studentCount = counts.get(row.classId) ?? 0;

  if (!amountsChanged && !periodChanged && !noteChanged) {
    return { group: serializeGroup(row, { studentCount, current }), warnings: [], split: false };
  }

  // O'tgan oylar muhrlangan tarix — ularning summasi o'zgarmasin
  const split = amountsChanged && row.startMonth < current;

  const updated = await prisma.$transaction(async (tx) => {
    await lockClass(tx, row.classId);

    let result;
    if (split) {
      await assertNoOverlap(tx, {
        classId: row.classId,
        tutorId: row.tutorId,
        startMonth: current,
        endMonth,
        excludeIds: [row.id],
      });
      await tx.tutorGroup.update({ where: { id: row.id }, data: { endMonth: prevMonth(current) } });
      result = await tx.tutorGroup.create({
        data: {
          tutorId: row.tutorId,
          classId: row.classId,
          perStudentAmount,
          groupAmount,
          startMonth: current,
          endMonth,
          note,
          createdBy: actorId,
        },
        include: { class: CLASS_SELECT },
      });
    } else {
      if (periodChanged) {
        await assertNoOverlap(tx, {
          classId: row.classId,
          tutorId: row.tutorId,
          startMonth,
          endMonth,
          excludeIds: [row.id],
        });
      }
      result = await tx.tutorGroup.update({
        where: { id: row.id },
        data: { perStudentAmount, groupAmount, startMonth, endMonth, note },
        include: { class: CLASS_SELECT },
      });
    }

    await payrollAudit.record(
      {
        actorId,
        action: "tutorGroup.update",
        targetType: "tutorGroup",
        targetId: result.id,
        summary:
          `${row.class?.name ?? "Guruh"} — tyutor guruhi tahrirlandi` +
          (split ? ` (yangi summa ${formatMonthKey(current)} dan)` : ""),
        oldValue: auditSnapshot(row),
        newValue: auditSnapshot(result),
      },
      tx,
    );
    return result;
  });

  const warnings =
    amountsChanged || periodChanged
      ? await sealedWarnings(row.tutorId, Math.max(startMonth, current))
      : [];

  return {
    group: serializeGroup(updated, { studentCount, current }),
    warnings,
    split,
    message: split
      ? `Yangi summa ${formatMonthKey(current)} dan amal qiladi — o'tgan oylar eski summada qoladi`
      : "Saqlandi",
  };
};

/**
 * Guruhni tyutordan olib tashlaydi.
 *
 *   effective = "next"    — shu oy uchun hisoblanadi, keyingi oydan to'xtaydi
 *   effective = "current" — shu oydan boshlab hisoblanmaydi
 *
 * Hali kuchga kirmagan qator (kuchga kiradigan oydan oldin) — REJA, u
 * o'chiriladi: unga hech narsa tayanmaydi.
 *
 * @param {string} id
 * @param {{ effective?: "current"|"next" }} options
 * @param {string} actorId
 */
const removeGroup = async (id, { effective = "next" } = {}, actorId) => {
  assertId(id, "Guruh");
  if (!REMOVE_EFFECTIVE.includes(effective)) {
    throw new BadRequestError("Qaysi oydan olib tashlash noto'g'ri ko'rsatilgan");
  }
  const current = currentMonthKey();

  const row = await prisma.tutorGroup.findUnique({ where: { id }, include: { class: CLASS_SELECT } });
  if (!row) throw new NotFoundError("Guruh topilmadi");
  if (row.endMonth != null && row.endMonth < current) {
    throw new BadRequestError("Bu biriktirish allaqachon tugagan");
  }

  // Oxirgi hisoblanadigan oy; undan oldin boshlanmagan bo'lsa qator reja
  const lastMonth = effective === "current" ? prevMonth(current) : current;
  const deleteRow = row.startMonth > lastMonth;

  if (!deleteRow && row.endMonth === lastMonth) {
    return {
      deleted: false,
      message: `Bu guruh ${formatMonthKey(lastMonth)} oxirida allaqachon tugaydi`,
      warnings: [],
    };
  }

  await prisma.$transaction(async (tx) => {
    if (deleteRow) {
      await tx.tutorGroup.delete({ where: { id: row.id } });
    } else {
      await tx.tutorGroup.update({ where: { id: row.id }, data: { endMonth: lastMonth } });
    }

    await payrollAudit.record(
      {
        actorId,
        action: deleteRow ? "tutorGroup.delete" : "tutorGroup.close",
        targetType: "tutorGroup",
        targetId: row.id,
        summary: deleteRow
          ? `${row.class?.name ?? "Guruh"} — tyutor guruhi o'chirildi (hali kuchga kirmagan)`
          : `${row.class?.name ?? "Guruh"} — tyutor guruhi ${formatMonthKey(lastMonth)} oxirida yopildi`,
        oldValue: auditSnapshot(row),
      },
      tx,
    );
  });

  logger.info(
    `[tutor] Guruh olib tashlandi: group=${row.id} tutor=${row.tutorId} ` +
      `class=${row.classId} effective=${effective} deleted=${deleteRow} actor=${actorId}`,
  );

  // Joriy oy muhrlangan va shu oydan to'xtatilgan bo'lsa — ogohlantirish
  const warnings =
    effective === "current" ? await sealedWarnings(row.tutorId, current) : [];

  return {
    deleted: deleteRow,
    warnings,
    message: deleteRow
      ? "Guruh olib tashlandi"
      : effective === "current"
        ? `Guruh olib tashlandi: ${formatMonthKey(current)} dan qo'shimcha oylik hisoblanmaydi`
        : `Guruh ${formatMonthKey(current)} oxirigacha amal qiladi, ` +
          `${formatMonthKey(nextMonth(current))} dan hisoblanmaydi`,
  };
};

module.exports = {
  loadTutorRoleValues,
  isTutorUser,
  countStudentsByClass,
  loadGroupsForPayroll,
  resolveTutorIdsForMonth,
  getStaffGroups,
  getMyGroups,
  getClassOptions,
  getGroupOverview,
  previewAmount,
  createGroup,
  updateGroup,
  removeGroup,
};
