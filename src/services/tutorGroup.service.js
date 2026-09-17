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
 *
 * ⚠️ BIR NECHTA SINF BIRDANIGA biriktiriladi (`classIds`), lekin HAR SINFGA
 * ALOHIDA QATOR yoziladi: keyin har biri o'zicha tahrirlanadi, olib
 * tashlanadi va oylikda alohida ustama qatori bo'ladi. Ommaviy biriktirish
 * HAMMASI YOKI HECH NARSA: bitta sinf band bo'lsa hech qaysi yozilmaydi va
 * band sinflarning HAMMASI bitta xabarda aytiladi — "10 tadan 8 tasi
 * biriktirildi" degan yarim holat bo'lmaydi.
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

// Bitta so'rovda biriktiriladigan sinflar chegarasi ("hammasi" ham shunga sig'adi)
const MAX_CLASSES_PER_REQUEST = 200;

// Ko'p sinf: har biriga qulf + qator + audit — standart 5 soniya yetmasligi mumkin
const CREATE_TX_OPTIONS = { timeout: 30000, maxWait: 10000 };

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

/**
 * Sinflar ro'yxati: `classIds` (massiv) yoki eski `classId` (bitta).
 * Takrorlar olib tashlanadi — bitta sinf ikki marta kelsa ikki qator yozilmasin.
 *
 * @param {{ classIds?: string[], classId?: string }} data
 * @returns {string[]}
 */
const parseClassIds = (data) => {
  const raw = data.classIds !== undefined ? data.classIds : data.classId ? [data.classId] : [];
  if (!Array.isArray(raw)) throw new BadRequestError("Sinflar ro'yxati noto'g'ri");

  const ids = [...new Set(raw.map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (ids.length === 0) throw new BadRequestError("Kamida bitta sinfni tanlang");
  if (ids.length > MAX_CLASSES_PER_REQUEST) {
    throw new BadRequestError(`Bir martada ${MAX_CLASSES_PER_REQUEST} tadan ko'p sinf biriktirib bo'lmaydi`);
  }
  ids.forEach((id) => assertId(id, "Sinf"));
  return ids;
};

const byClassName = (a, b) => (a.className ?? "").localeCompare(b.className ?? "", "uz");

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
 * Bir nechta sinf qulfi — HAR DOIM `id` bo'yicha o'sish tartibida: ikki
 * parallel ommaviy biriktirish kesishgan sinflarni teskari tartibda olsa,
 * bir-birini kutib deadlock bo'lardi.
 */
const lockClasses = async (tx, classIds) => {
  for (const classId of [...classIds].sort()) {
    await lockClass(tx, classId);
  }
};

/**
 * Sinf(lar) shu davrda boshqa (yoki shu) tyutorga biriktirilmaganini
 * tekshiradi. Qulf ICHIDA va `tx` bilan chaqiriladi.
 *
 * Band sinflarning HAMMASI bitta xabarda aytiladi: birinchisida to'xtasa,
 * odam har safar bitta sinfni olib tashlab qayta urinardi.
 */
const assertNoOverlap = async (tx, { classIds, tutorId, startMonth, endMonth, excludeIds = [] }) => {
  const clashes = await tx.tutorGroup.findMany({
    where: {
      classId: { in: classIds },
      ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}),
      ...overlappingPeriodWhere(startMonth, endMonth),
    },
    include: { class: CLASS_SELECT },
    orderBy: [{ startMonth: "asc" }, { id: "asc" }],
  });
  if (clashes.length === 0) return;

  // Har sinf uchun eng erta to'qnashuv yetadi
  const firstByClass = new Map();
  for (const clash of clashes) {
    if (!firstByClass.has(clash.classId)) firstByClass.set(clash.classId, clash);
  }
  const busy = [...firstByClass.values()]
    .map((clash) => ({ ...clash, className: clash.class?.name ?? "Sinf" }))
    .sort(byClassName);

  const otherIds = [...new Set(busy.filter((c) => c.tutorId !== tutorId).map((c) => c.tutorId))];
  const others = otherIds.length
    ? await tx.user.findMany({
        where: { id: { in: otherIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const otherMap = new Map(others.map((u) => [u.id, u]));
  const details = { reason: "tutor_group_overlap", classIds: busy.map((c) => c.classId) };

  if (busy.length === 1) {
    const [clash] = busy;
    const period = formatMonthRange(clash.startMonth, clash.endMonth);
    if (clash.tutorId === tutorId) {
      throw new ConflictError(
        `${clash.className} sinfi bu tyutorga allaqachon biriktirilgan (${period})`,
        details,
      );
    }
    throw new ConflictError(
      `${clash.className} sinfi ${period} davrida ` +
        `${fullName(otherMap.get(clash.tutorId)) || "boshqa tyutor"} ga biriktirilgan. ` +
        `Bir oyda bir sinfga bitta tyutor — boshqa oydan boshlang yoki avval u yerdan olib tashlang`,
      details,
    );
  }

  const lines = busy.map((clash) => {
    const holder =
      clash.tutorId === tutorId
        ? "shu tyutorda"
        : fullName(otherMap.get(clash.tutorId)) || "boshqa tyutor";
    return `${clash.className} (${holder}, ${formatMonthRange(clash.startMonth, clash.endMonth)})`;
  });
  throw new ConflictError(
    `${busy.length} ta sinf bu davrda band: ${lines.join("; ")}. Bir oyda bir sinfga ` +
      `bitta tyutor — ularni tanlovdan olib tashlang yoki boshqa oydan boshlang. ` +
      `Hech qaysi sinf biriktirilmadi`,
    details,
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
 * Biriktirish oynasi uchun sinflar: o'quvchilar soni va tanlangan davrda
 * kimga biriktirilgani (band bo'lsa oldindan ko'rinsin).
 *
 * `isAvailable` — `assertNoOverlap` bilan AYNI shart (faol sinf + davrda
 * hech kimda yo'q): oyna shu bayroq bo'yicha belgilashga ruxsat beradi,
 * server esa baribir qulf ichida qayta tekshiradi.
 *
 * @param {{ tutorId?: string, month?: string|number, endMonth?: string|number }} query
 */
const getClassOptions = async ({ tutorId, month, endMonth } = {}) => {
  const fromMonth = month ? parseMonthKey(month, "Oy") : currentMonthKey();
  // Tugash oyi hali yozilayotgan bo'lishi mumkin — boshlanishdan oldingisi
  // e'tiborga olinmaydi (saqlashda `createGroup` baribir rad etadi)
  const requestedEnd = parseOptionalMonthKey(endMonth, "Tugash oyi");
  const toMonth = requestedEnd != null && requestedEnd >= fromMonth ? requestedEnd : null;

  const [classes, holders] = await Promise.all([
    prisma.class.findMany({
      select: { id: true, name: true, isActive: true },
      orderBy: { name: "asc" },
    }),
    prisma.tutorGroup.findMany({
      where: overlappingPeriodWhere(fromMonth, toMonth),
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
    endMonth: toMonth,
    periodLabel: formatMonthRange(fromMonth, toMonth),
    items: classes.map((c) => {
      const classHolders = holdersByClass.get(c.id) ?? [];
      return {
        id: c.id,
        name: c.name,
        isActive: c.isActive,
        studentCount: counts.get(c.id) ?? 0,
        holders: classHolders,
        isAvailable: c.isActive && classHolders.length === 0,
      };
    }),
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
 * Bir nechta sinf tanlansa har sinf ALOHIDA hisoblanadi (oylikda ham alohida
 * ustama qatori bo'ladi) va jami — ularning yig'indisi:
 *   jami = Σ (groupAmount + perStudentAmount × sinf o'quvchilari)
 *
 * @param {{ classIds?: string[], classId?: string, perStudentAmount?: *, groupAmount?: * }} data
 */
const previewAmount = async (data = {}) => {
  const classIds = parseClassIds(data);
  const perStudentAmount = parseAmount(
    data.perStudentAmount === "" || data.perStudentAmount == null ? 0 : data.perStudentAmount,
    "Bitta o'quvchi uchun summa",
  );
  const groupAmount = parseAmount(
    data.groupAmount === "" || data.groupAmount == null ? 0 : data.groupAmount,
    "Guruh uchun summa",
  );

  const [classes, counts] = await Promise.all([
    prisma.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } }),
    countStudentsByClass(classIds),
  ]);

  const lines = classes
    .map((c) => {
      const studentCount = counts.get(c.id) ?? 0;
      return {
        classId: c.id,
        className: c.name,
        studentCount,
        studentsAmount: computeTutorGroupAmount({ perStudentAmount, groupAmount: 0 }, studentCount),
        groupAmount: computeTutorGroupAmount({ perStudentAmount: 0, groupAmount }, studentCount),
        amount: computeTutorGroupAmount({ perStudentAmount, groupAmount }, studentCount),
      };
    })
    .sort(byClassName);

  return {
    classCount: lines.length,
    studentCount: lines.reduce((sum, line) => sum + line.studentCount, 0),
    perStudentAmount: formatAmount(perStudentAmount),
    groupAmount: formatAmount(groupAmount),
    studentsAmount: formatAmount(sumAmounts(lines.map((line) => line.studentsAmount))),
    groupsAmount: formatAmount(sumAmounts(lines.map((line) => line.groupAmount))),
    amount: formatAmount(sumAmounts(lines.map((line) => line.amount))),
    items: lines.map((line) => ({
      classId: line.classId,
      className: line.className,
      studentCount: line.studentCount,
      amount: formatAmount(line.amount),
    })),
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
 * Tyutorga bitta yoki bir nechta guruh (sinf) biriktiradi — AYNI stavka va
 * davr bilan, har sinfga alohida qator.
 *
 * ⚠️ HAMMASI YOKI HECH NARSA: bitta tranzaksiya, sinflar `id` tartibida
 * qulflanadi, band sinflarning hammasi bitta xabarda qaytadi.
 *
 * @param {object} data - { tutorId, classIds (yoki classId), perStudentAmount, groupAmount, startMonth?, endMonth?, note? }
 * @param {string} actorId
 */
const createGroup = async (data = {}, actorId) => {
  const current = currentMonthKey();

  const classIds = parseClassIds(data);
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
  const classes = await prisma.class.findMany({
    where: { id: { in: classIds } },
    select: { id: true, name: true, isActive: true },
    orderBy: { name: "asc" },
  });
  if (classes.length !== classIds.length) {
    throw new NotFoundError(
      classIds.length === 1
        ? "Sinf topilmadi"
        : `Tanlangan sinflardan ${classIds.length - classes.length} tasi topilmadi — oynani yangilang`,
    );
  }
  const inactive = classes.filter((c) => !c.isActive);
  if (inactive.length > 0) {
    throw new BadRequestError(
      classIds.length === 1
        ? "Faol bo'lmagan sinfni biriktirib bo'lmaydi"
        : `Faol bo'lmagan sinfni biriktirib bo'lmaydi: ${inactive.map((c) => c.name).join(", ")}`,
    );
  }

  const rows = await prisma.$transaction(async (tx) => {
    await lockClasses(tx, classIds);
    await assertNoOverlap(tx, { classIds, tutorId: tutor.id, startMonth, endMonth });

    const created = [];
    for (const cls of classes) {
      created.push(
        await tx.tutorGroup.create({
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
        }),
      );
    }

    // Har qatorga o'z audit yozuvi: keyingi tahrir/olib tashlash ham qator bo'yicha
    await payrollAudit.recordMany(
      created.map((row) => ({
        actorId,
        action: "tutorGroup.create",
        targetType: "tutorGroup",
        targetId: row.id,
        summary:
          `${fullName(tutor)} — ${row.class?.name ?? "Sinf"} guruhi biriktirildi ` +
          `(o'quvchiga ${formatAmount(perStudentAmount)}, guruhga ${formatAmount(groupAmount)})`,
        newValue: auditSnapshot(row),
      })),
      tx,
    );
    return created;
  }, CREATE_TX_OPTIONS);

  logger.info(
    `[tutor] Guruh biriktirildi: tutor=${tutor.id} classes=${classIds.join(",")} ` +
      `perStudent=${formatAmount(perStudentAmount)} group=${formatAmount(groupAmount)} ` +
      `start=${startMonth} end=${endMonth ?? "-"} actor=${actorId}`,
  );

  // Faqat guruhi bor tyutor shu biriktirish bilan oylik oladiganga aylanadi —
  // "hammaga" ushlab qolish unga ham yoyilsin (`finance.md` §10). Xato
  // tashlamaydi: biriktirish allaqachon saqlangan.
  await require("./payrollDeduction.service").extendAllScopeDeductionsSafe([tutor.id]);

  const [counts, warnings] = await Promise.all([
    countStudentsByClass(classIds),
    sealedWarnings(tutor.id, startMonth),
  ]);

  const groups = rows
    .map((row) => serializeGroup(row, { studentCount: counts.get(row.classId) ?? 0, current }))
    .sort(byClassName);

  return {
    groups,
    count: groups.length,
    warnings,
    message:
      groups.length === 1
        ? `${groups[0].className} guruhi biriktirildi`
        : `${groups.length} ta guruh biriktirildi`,
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
        classIds: [row.classId],
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
          classIds: [row.classId],
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
