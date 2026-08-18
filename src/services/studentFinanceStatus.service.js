/**
 * O'quvchining moliyaviy holati — DAVR jadvali (StudentTariff bilan bir xil
 * shakl): `[startMonth, endMonth]` oralig'ida qaysi holat amal qilgan.
 *
 * QATOR YO'Q = FAOL. Faqat istisnolar (muzlatish/chetlatish) yoziladi, shuning
 * uchun jadval kichik qoladi va cron'ning "shu oyni qamragan qatorlar" so'rovi
 * butun maktab uchun bitta arzon so'rovga aylanadi.
 *
 * Muzlatilgan/chetlatilgan oyda hisob-faktura shakllanmaydi. Ammo ALLAQACHON
 * shakllangan hisob-faktura avtomatik bekor qilinmaydi — qaytarilmaslik
 * qoidasi. Buni admin qaror qabul qila oladigan paytda ko'rishi uchun
 * yaratishda `warnings` qaytariladi.
 */

const prisma = require("../config/prisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const {
  currentMonthKey,
  prevMonth,
  parseMonthKey,
  parseOptionalMonthKey,
  formatMonthKey,
  formatMonthRange,
  coveringMonthWhere,
  overlappingPeriodWhere,
} = require("../helpers/month.helpers");

const STATUSES = ["active", "frozen"];

// Hisob-faktura shakllanmaydigan holatlar.
//
// "Chetlatilgan" OLIB TASHLANDI: maktabdan ketish endi StudentEnrollment
// davrini yopish bilan qayd etiladi (kun aniqligida, sababi toifasi bilan).
// Bu yerdagi `frozen` esa DAVR ICHIDAGI vaqtinchalik istisno: o'quvchi
// ro'yxatda qoladi, lekin o'sha oyga majburiyat yozilmaydi va qaytganda
// proratsiya QILINMAYDI.
const NON_BILLABLE = new Set(["frozen"]);

const STATUS_LABELS = {
  active: "Faol",
  frozen: "Muzlatilgan",
};

const STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  isArchived: true,
};

// ─────────────────────────────────────────────
// Tekshiruvlar
// ─────────────────────────────────────────────

const parseStatus = (value) => {
  const status = String(value || "").trim();
  if (!STATUSES.includes(status)) {
    throw new BadRequestError(
      `Holat noto'g'ri. Mumkin: ${STATUSES.map((s) => STATUS_LABELS[s]).join(", ")}`,
    );
  }
  return status;
};

const assertStudent = async (studentId) => {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { ...STUDENT_SELECT, role: true },
  });

  if (!student || student.role !== ROLES.STUDENT) {
    throw new NotFoundError("O'quvchi topilmadi");
  }

  return student;
};

const parsePeriod = (startValue, endValue) => {
  const startMonth = parseMonthKey(startValue, "Boshlanish oyi");
  const endMonth = parseOptionalMonthKey(endValue, "Tugash oyi");

  if (endMonth != null && endMonth < startMonth) {
    throw new BadRequestError(
      "Tugash oyi boshlanish oyidan oldin bo'lishi mumkin emas",
    );
  }

  return { startMonth, endMonth };
};

/**
 * Bir o'quvchida davrlar kesishmasligi. Tekshiruv yozuv bilan bitta
 * tranzaksiyada; poyga holatidagi kafolat — @@unique([studentId, startMonth]).
 */
const assertNoStatusOverlap = async (tx, studentId, period, excludeId = null) => {
  const conflict = await tx.studentFinanceStatus.findFirst({
    where: {
      studentId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      ...overlappingPeriodWhere(period.startMonth, period.endMonth),
    },
    orderBy: { startMonth: "asc" },
  });

  if (!conflict) return;

  if (conflict.startMonth === period.startMonth) {
    throw new BadRequestError(
      `${formatMonthKey(period.startMonth)} oyidan boshlanadigan holat allaqachon bor — yangisini qo'shish o'rniga o'shani tahrirlang`,
    );
  }

  throw new BadRequestError(
    `Bu davr uchun o'quvchida boshqa holat belgilangan (${formatMonthRange(
      conflict.startMonth,
      conflict.endMonth,
    )}). Tugash oyini ko'rsating yoki o'sha yozuvni tahrirlang.`,
  );
};

const rethrowDuplicate = (error, message) => {
  if (error?.code === "P2002") throw new BadRequestError(message);
  throw error;
};

/**
 * Yangi hisoblanmaydigan davrga tushib qolgan, ALLAQACHON shakllangan
 * hisob-fakturalar haqida ogohlantirish.
 *
 * Bu funksiyaning butun mazmuni — qaytarilmaslik qoidasini admin hali harakat
 * qila oladigan paytda ko'rsatish, uch hafta keyin hisobotda emas.
 */
const collectInvoiceWarnings = async (studentId, status, period) => {
  if (!NON_BILLABLE.has(status)) return [];

  const invoices = await prisma.monthlyInvoice.findMany({
    where: {
      studentId,
      status: { not: "cancelled" },
      month: {
        gte: period.startMonth,
        ...(period.endMonth != null ? { lte: period.endMonth } : {}),
      },
    },
    select: { month: true },
    orderBy: { month: "asc" },
  });

  if (invoices.length === 0) return [];

  const months = invoices.map((i) => formatMonthKey(i.month)).join(", ");
  return [
    `${months} uchun hisob-faktura allaqachon shakllantirilgan — u avtomatik bekor qilinmaydi`,
  ];
};

// ─────────────────────────────────────────────
// O'qish
// ─────────────────────────────────────────────

const serializeStatus = (row, { student } = {}) => ({
  ...row,
  statusLabel: STATUS_LABELS[row.status] ?? row.status,
  startMonthLabel: formatMonthKey(row.startMonth),
  endMonthLabel: formatMonthKey(row.endMonth),
  student: student ?? null,
});

/**
 * Bir nechta o'quvchining berilgan oydagi amaldagi holati.
 *
 * Hisob-faktura generatori shu bilan filtrlaydi. BARCHA qamragan qatorlar
 * olinadi (faqat frozen emas): aks holda kechroq boshlangan `active`
 * qator e'tiborsiz qolib, o'quvchi noto'g'ri bloklanardi.
 *
 * @param {number} month - YYYYMM
 * @param {{studentIds?: string[]}} options
 * @returns {Promise<Map<string, object>>} studentId → qator (yo'q bo'lsa yozuv yo'q = faol)
 */
const resolveStatusesForMonth = async (month, { studentIds } = {}) => {
  const rows = await prisma.studentFinanceStatus.findMany({
    where: {
      ...(studentIds?.length ? { studentId: { in: studentIds } } : {}),
      ...coveringMonthWhere(month),
    },
    // Buzilgan ma'lumotda ham aniq qoida: eng kech boshlangani yutadi —
    // resolveManyForMonth bilan aynan bir xil.
    orderBy: { startMonth: "desc" },
  });

  const byStudent = new Map();
  for (const row of rows) {
    if (!byStudent.has(row.studentId)) byStudent.set(row.studentId, row);
  }

  return byStudent;
};

/**
 * Bitta o'quvchining berilgan oydagi holati (qator bo'lmasa — faol).
 * @param {string} studentId
 * @param {number} month
 * @returns {Promise<{status: string, statusLabel: string, row: object|null}>}
 */
const resolveStatusForStudent = async (studentId, month) => {
  const row = await prisma.studentFinanceStatus.findFirst({
    where: { studentId, ...coveringMonthWhere(month) },
    orderBy: { startMonth: "desc" },
  });

  const status = row?.status ?? "active";
  return { status, statusLabel: STATUS_LABELS[status], row: row ?? null };
};

const resolveStudentIdFilter = async (query) => {
  const search = query.search?.trim();
  if (!query.classId && !search) return null;

  const students = await prisma.user.findMany({
    where: {
      role: ROLES.STUDENT,
      ...(query.classId ? { classes: { some: { classId: query.classId } } } : {}),
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: "insensitive" } },
              { lastName: { contains: search, mode: "insensitive" } },
              { username: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: { id: true },
  });

  return students.map((s) => s.id);
};

/**
 * Holat yozuvlari ro'yxati (sahifalangan).
 * @param {object} req
 * @returns {Promise<object>}
 */
const getStatuses = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const month = query.month ? parseMonthKey(query.month, "Oy") : currentMonthKey();

  const filter = {};
  if (query.studentId) filter.studentId = query.studentId;
  if (query.status) filter.status = parseStatus(query.status);
  if (query.activeOnly === "true") Object.assign(filter, coveringMonthWhere(month));

  const studentIdFilter = await resolveStudentIdFilter(query);
  if (studentIdFilter) {
    const ids = query.studentId
      ? studentIdFilter.filter((id) => id === query.studentId)
      : studentIdFilter;

    if (ids.length === 0) {
      return { ...formatPaginationResponse([], 0, page, limit), month };
    }
    filter.studentId = { in: ids };
  }

  const [rows, total] = await Promise.all([
    prisma.studentFinanceStatus.findMany({
      where: filter,
      orderBy: [{ startMonth: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    prisma.studentFinanceStatus.count({ where: filter }),
  ]);

  const studentIds = [...new Set(rows.map((r) => r.studentId))];
  const students = studentIds.length
    ? await prisma.user.findMany({
        where: { id: { in: studentIds } },
        select: STUDENT_SELECT,
      })
    : [];
  const studentMap = new Map(students.map((s) => [s.id, s]));

  const items = rows.map((row) =>
    serializeStatus(row, { student: studentMap.get(row.studentId) || null }),
  );

  return { ...formatPaginationResponse(items, total, page, limit), month };
};

/**
 * Bitta o'quvchining holat tarixi + joriy holati.
 * @param {string} studentId
 * @returns {Promise<object>}
 */
const getStudentStatusHistory = async (studentId) => {
  const student = await assertStudent(studentId);
  const month = currentMonthKey();

  const [rows, current] = await Promise.all([
    prisma.studentFinanceStatus.findMany({
      where: { studentId },
      orderBy: { startMonth: "desc" },
    }),
    resolveStatusForStudent(studentId, month),
  ]);

  return {
    student,
    month,
    monthLabel: formatMonthKey(month),
    currentStatus: {
      status: current.status,
      statusLabel: current.statusLabel,
      startMonth: current.row?.startMonth ?? null,
      endMonth: current.row?.endMonth ?? null,
      reason: current.row?.reason ?? "",
    },
    items: rows.map((row) => serializeStatus(row, { student })),
  };
};

const getStatusById = async (id) => {
  const row = await prisma.studentFinanceStatus.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Holat yozuvi topilmadi");

  const student = await prisma.user.findUnique({
    where: { id: row.studentId },
    select: STUDENT_SELECT,
  });

  return serializeStatus(row, { student });
};

// ─────────────────────────────────────────────
// Yozish
// ─────────────────────────────────────────────

/**
 * Holat yozuvi qo'shadi (muzlatish / chetlatish / faollashtirish).
 *
 * StudentTariff'dan farqli o'laroq JORIY oydan boshlash ruxsat etilgan:
 * `invoiceDayOfMonth = 5` bo'lganda 2-sanada muzlatish — qonuniy va tez-tez
 * uchraydigan amal, u o'sha oy hisob-fakturasini oldini olishi kerak.
 * O'TGAN oydan boshlash uchun `allowPast` (controller `finance.adjust` bilan
 * tekshiradi).
 *
 * @param {object} data - { studentId, status, startMonth, endMonth, reason }
 * @param {string} userId
 * @param {{allowPast?: boolean}} options
 * @returns {Promise<object>}
 */
const createStatus = async (data, userId, { allowPast = false } = {}) => {
  if (!data.studentId) throw new BadRequestError("O'quvchi tanlanmagan");

  const status = parseStatus(data.status);
  const period = parsePeriod(data.startMonth, data.endMonth);
  const student = await assertStudent(data.studentId);

  if (!allowPast && period.startMonth < currentMonthKey()) {
    throw new BadRequestError(
      "O'tgan oydan boshlanadigan holat qo'shish uchun alohida ruxsat kerak",
    );
  }

  try {
    const row = await prisma.$transaction(async (tx) => {
      await assertNoStatusOverlap(tx, data.studentId, period);

      return tx.studentFinanceStatus.create({
        data: {
          studentId: data.studentId,
          status,
          ...period,
          reason: data.reason?.trim() || "",
          createdBy: userId,
        },
      });
    });

    const warnings = await collectInvoiceWarnings(data.studentId, status, period);

    return { ...serializeStatus(row, { student }), warnings };
  } catch (error) {
    return rethrowDuplicate(
      error,
      `O'quvchida ${formatMonthKey(period.startMonth)} oyidan boshlanadigan holat allaqachon bor`,
    );
  }
};

/**
 * Holat yozuvini tahrirlaydi. Amaldagi yozuvda `status` va `startMonth`
 * o'zgarmas — faqat `endMonth` (oldinga) va `reason`.
 *
 * @param {string} id
 * @param {object} data
 * @param {{allowPast?: boolean}} options
 * @returns {Promise<object>}
 */
const updateStatus = async (id, data, { allowPast = false } = {}) => {
  const row = await prisma.studentFinanceStatus.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Holat yozuvi topilmadi");

  const now = currentMonthKey();
  const isInEffect = row.startMonth <= now;
  const payload = {};

  if (data.reason !== undefined) payload.reason = data.reason?.trim() || "";

  if (data.status !== undefined) {
    const status = parseStatus(data.status);
    if (isInEffect && !allowPast && status !== row.status) {
      throw new BadRequestError(
        "Amaldagi holatni o'zgartirib bo'lmaydi. Yangi oydan boshlab yangi holat qo'shing.",
      );
    }
    payload.status = status;
  }

  const wantsPeriodChange =
    data.startMonth !== undefined || data.endMonth !== undefined;

  if (wantsPeriodChange) {
    const period = parsePeriod(
      data.startMonth !== undefined ? data.startMonth : row.startMonth,
      data.endMonth !== undefined ? data.endMonth : row.endMonth,
    );

    if (isInEffect && !allowPast) {
      if (period.startMonth !== row.startMonth) {
        throw new BadRequestError(
          "Amaldagi holatning boshlanish oyini o'zgartirib bo'lmaydi",
        );
      }
      const minEnd = Math.max(now, row.startMonth);
      if (period.endMonth != null && period.endMonth < minEnd) {
        throw new BadRequestError(
          `Amaldagi holatni ${formatMonthKey(minEnd)} dan oldin yopib bo'lmaydi`,
        );
      }
    }

    payload.startMonth = period.startMonth;
    payload.endMonth = period.endMonth;
  }

  if (Object.keys(payload).length === 0) return serializeStatus(row);

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (payload.startMonth !== undefined || payload.endMonth !== undefined) {
        await assertNoStatusOverlap(
          tx,
          row.studentId,
          {
            startMonth: payload.startMonth ?? row.startMonth,
            endMonth:
              payload.endMonth !== undefined ? payload.endMonth : row.endMonth,
          },
          id,
        );
      }

      return tx.studentFinanceStatus.update({ where: { id }, data: payload });
    });

    return getStatusById(updated.id);
  } catch (error) {
    return rethrowDuplicate(
      error,
      "O'quvchida shu oydan boshlanadigan holat allaqachon bor",
    );
  }
};

/**
 * Holat davrini ko'rsatilgan oyda yopadi (masalan muzlatishdan qaytarish).
 * @param {string} id
 * @param {number|string} endMonth
 * @returns {Promise<object>}
 */
const closeStatus = async (id, endMonth) =>
  updateStatus(id, { endMonth: parseMonthKey(endMonth, "Tugash oyi") });

/**
 * Holatni almashtirish — eskisini `fromMonth - 1` da yopib, yangisini
 * `fromMonth` dan ochadi. Bitta tranzaksiyada: ikki alohida so'rov qilinsa,
 * oraliqda o'quvchi holatsiz qolib ketardi.
 *
 * @param {string} id
 * @param {object} data - { status, fromMonth, reason }
 * @param {string} userId
 * @returns {Promise<object>}
 */
const changeStatus = async (id, data, userId) => {
  const row = await prisma.studentFinanceStatus.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Holat yozuvi topilmadi");

  const status = parseStatus(data.status);
  const fromMonth = parseMonthKey(data.fromMonth, "Boshlanish oyi");

  if (fromMonth <= row.startMonth) {
    throw new BadRequestError(
      `Yangi holat ${formatMonthKey(row.startMonth)} dan keyingi oydan boshlanishi kerak`,
    );
  }
  if (row.endMonth != null && fromMonth > row.endMonth) {
    throw new BadRequestError("Yangi holat joriy davrdan tashqarida boshlanmoqda");
  }
  if (status === row.status) {
    throw new BadRequestError("Yangi holat joriy holat bilan bir xil");
  }

  const student = await assertStudent(row.studentId);
  const newPeriod = { startMonth: fromMonth, endMonth: row.endMonth };

  try {
    const result = await prisma.$transaction(async (tx) => {
      const closed = await tx.studentFinanceStatus.update({
        where: { id },
        data: { endMonth: prevMonth(fromMonth) },
      });

      await assertNoStatusOverlap(tx, row.studentId, newPeriod, id);

      const created = await tx.studentFinanceStatus.create({
        data: {
          studentId: row.studentId,
          status,
          ...newPeriod,
          reason: data.reason?.trim() || "",
          createdBy: userId,
        },
      });

      return { closed, created };
    });

    const warnings = await collectInvoiceWarnings(row.studentId, status, newPeriod);

    return {
      closed: serializeStatus(result.closed, { student }),
      created: serializeStatus(result.created, { student }),
      warnings,
    };
  } catch (error) {
    return rethrowDuplicate(
      error,
      `O'quvchida ${formatMonthKey(fromMonth)} oyidan boshlanadigan holat allaqachon bor`,
    );
  }
};

/**
 * Ommaviy holat belgilash (sinf yoki tanlangan o'quvchilar).
 * Bitta o'quvchidagi xato butun paketni to'xtatmaydi.
 *
 * @param {object} data - { studentIds, classId, status, startMonth, endMonth, reason }
 * @param {string} userId
 * @param {{allowPast?: boolean}} options
 * @returns {Promise<object>}
 */
const bulkCreateStatus = async (data, userId, { allowPast = false } = {}) => {
  const status = parseStatus(data.status);
  const period = parsePeriod(data.startMonth, data.endMonth);

  if (!allowPast && period.startMonth < currentMonthKey()) {
    throw new BadRequestError(
      "O'tgan oydan boshlanadigan holat qo'shish uchun alohida ruxsat kerak",
    );
  }

  let studentIds = Array.isArray(data.studentIds)
    ? [...new Set(data.studentIds)]
    : [];

  if (data.classId) {
    const classStudents = await prisma.user.findMany({
      where: {
        role: ROLES.STUDENT,
        isArchived: false,
        classes: { some: { classId: data.classId } },
      },
      select: { id: true },
    });
    studentIds = [...new Set([...studentIds, ...classStudents.map((s) => s.id)])];
  }

  if (studentIds.length === 0) {
    throw new BadRequestError("O'quvchilar tanlanmagan");
  }

  const created = [];
  const skipped = [];

  for (const studentId of studentIds) {
    try {
      const row = await prisma.$transaction(async (tx) => {
        await assertNoStatusOverlap(tx, studentId, period);
        return tx.studentFinanceStatus.create({
          data: {
            studentId,
            status,
            ...period,
            reason: data.reason?.trim() || "",
            createdBy: userId,
          },
        });
      });
      created.push(serializeStatus(row));
    } catch (error) {
      skipped.push({
        studentId,
        reason:
          error?.code === "P2002"
            ? "Bu oydan boshlanadigan holat allaqachon bor"
            : error.message,
      });
    }
  }

  // Ommaviy amalda ogohlantirish oylar bo'yicha umumlashtiriladi — har bir
  // o'quvchi uchun alohida so'rov qilinmaydi.
  const affected = created.map((row) => row.studentId);
  const invoiceCount = NON_BILLABLE.has(status)
    ? await prisma.monthlyInvoice.count({
        where: {
          studentId: { in: affected },
          status: { not: "cancelled" },
          month: {
            gte: period.startMonth,
            ...(period.endMonth != null ? { lte: period.endMonth } : {}),
          },
        },
      })
    : 0;

  const warnings = invoiceCount
    ? [
        `${invoiceCount} ta hisob-faktura bu davr uchun allaqachon shakllantirilgan — ular avtomatik bekor qilinmaydi`,
      ]
    : [];

  return { created, skipped, warnings };
};

/**
 * Holat yozuvini o'chiradi — faqat hali boshlanmagan (kelajakdagi) yozuvni.
 * @param {string} id
 * @returns {Promise<{message: string}>}
 */
const deleteStatus = async (id) => {
  const row = await prisma.studentFinanceStatus.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Holat yozuvi topilmadi");

  if (row.startMonth <= currentMonthKey()) {
    throw new BadRequestError(
      "O'tgan yoki joriy oyni qamragan holatni o'chirib bo'lmaydi. Uni yoping.",
    );
  }

  await prisma.studentFinanceStatus.delete({ where: { id } });

  return { message: "Holat yozuvi o'chirildi" };
};

module.exports = {
  STATUSES,
  STATUS_LABELS,
  NON_BILLABLE,
  serializeStatus,
  resolveStatusesForMonth,
  resolveStatusForStudent,
  getStatuses,
  getStudentStatusHistory,
  getStatusById,
  createStatus,
  updateStatus,
  closeStatus,
  changeStatus,
  bulkCreateStatus,
  deleteStatus,
};
