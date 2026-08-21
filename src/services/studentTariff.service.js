/**
 * O'quvchiga tarif biriktirish.
 *
 * Biriktirish narxni saqlamaydi — faqat "qaysi tarif, qaysi oylardan qaysi
 * oygacha". Summa `tariffResolution.service.js` da hal qilinadi. Shu sababli
 * tarif narxi ko'tarilganda bu jadvalga umuman tegilmaydi.
 *
 * `endMonth = null` → butun o'qish davri.
 * `startMonth === endMonth` → faqat o'sha oy uchun.
 */

const prisma = require("../config/prisma");
// Tarif KATALOGI platformada (barcha filiallarga umumiy), BIRIKTIRISH esa
// shu filialda. Ikkalasi xotirada Map orqali birlashtiriladi — SQL join yo'q.
const platformPrisma = require("../config/platformPrisma");
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
const { formatAmount } = require("../helpers/money.helpers");
const { resolveManyForMonth } = require("./tariffResolution.service");

const STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  isArchived: true,
};

const TARIFF_SELECT = {
  id: true,
  name: true,
  isActive: true,
  isArchived: true,
};

// ─────────────────────────────────────────────
// Umumiy tekshiruvlar
// ─────────────────────────────────────────────

/**
 * O'quvchi mavjudmi va rostdan ham o'quvchimi?
 * (O'quvchi alohida model emas — `User` + role.)
 */
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

/** Tarif mavjudmi? (soft ref — FK tekshirmaydi.) */
const assertTariff = async (tariffId, { forAssignment = false } = {}) => {
  const tariff = await platformPrisma.tariff.findUnique({
    where: { id: tariffId },
    select: TARIFF_SELECT,
  });

  if (!tariff) throw new NotFoundError("Tarif topilmadi");

  if (forAssignment && tariff.isArchived) {
    throw new BadRequestError("Arxivlangan tarifni biriktirib bo'lmaydi");
  }

  return tariff;
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
 * Bir o'quvchida bir oyga bitta tarif. Tekshiruv yozuv bilan bitta
 * tranzaksiyada; poyga holatidagi kafolat — @@unique([studentId, startMonth]).
 */
const assertNoAssignmentOverlap = async (tx, studentId, period, excludeId = null) => {
  const conflict = await tx.studentTariff.findFirst({
    where: {
      studentId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      ...overlappingPeriodWhere(period.startMonth, period.endMonth),
    },
    orderBy: { startMonth: "asc" },
  });

  if (conflict) {
    throw new BadRequestError(
      `O'quvchida bu davr uchun boshqa tarif biriktirilgan (${formatMonthRange(
        conflict.startMonth,
        conflict.endMonth,
      )})`,
    );
  }
};

const rethrowDuplicate = (error, message) => {
  if (error?.code === "P2002") throw new BadRequestError(message);
  throw error;
};

/**
 * Biriktirish oyi uchun tarifda narx bormi? Yo'q bo'lsa bloklamaydi —
 * ogohlantirish qaytaradi. Narxdan oldin biriktirish qonuniy tartib.
 */
const collectWarnings = async (tariffId, startMonth) => {
  const version = await platformPrisma.tariffVersion.findFirst({
    where: { tariffId, ...coveringMonthWhere(startMonth) },
  });

  return version
    ? []
    : [
        `Tanlangan tarifda ${formatMonthKey(startMonth)} oyi uchun narx belgilanmagan`,
      ];
};

// ─────────────────────────────────────────────
// O'qish
// ─────────────────────────────────────────────

const serializeAssignment = (assignment, { student, tariff, resolved } = {}) => ({
  ...assignment,
  startMonthLabel: formatMonthKey(assignment.startMonth),
  endMonthLabel: formatMonthKey(assignment.endMonth),
  student: student ?? null,
  tariff: tariff ?? null,
  resolvedAmount: resolved?.total ?? null,
  resolvedReason: resolved?.reason ?? null,
});

/**
 * Filtrda `studentId: { in: [...] }` kerak bo'ladigan hollar (sinf yoki
 * ism bo'yicha qidiruv) uchun o'quvchi id'larini oldindan yig'adi.
 * @returns {Promise<string[]|null>} null — bunday filtr yo'q
 */
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
 * Biriktirishlar ro'yxati. `month` berilsa — o'sha oyga hal qilingan summa
 * ham qo'shiladi (sahifadagi qatorlar uchun 2 qo'shimcha so'rov).
 *
 * @param {object} req - query: page, limit, studentId, tariffId, classId, month, activeOnly, search
 * @returns {Promise<object>} paginated response
 */
const getAssignments = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const month = query.month ? parseMonthKey(query.month, "Oy") : currentMonthKey();

  const filter = {};
  if (query.studentId) filter.studentId = query.studentId;
  if (query.tariffId) filter.tariffId = query.tariffId;
  if (query.activeOnly === "true") Object.assign(filter, coveringMonthWhere(month));

  const studentIdFilter = await resolveStudentIdFilter(query);
  if (studentIdFilter) {
    // `studentId` ham berilgan bo'lsa — kesishma olinadi, aks holda
    // sinf/qidiruv filtri jim e'tiborsiz qolardi.
    const ids = query.studentId
      ? studentIdFilter.filter((id) => id === query.studentId)
      : studentIdFilter;

    // Hech kim topilmasa — bo'sh sahifa.
    if (ids.length === 0) {
      return { ...formatPaginationResponse([], 0, page, limit), month };
    }

    filter.studentId = { in: ids };
  }

  const [rows, total] = await Promise.all([
    prisma.studentTariff.findMany({
      where: filter,
      orderBy: [{ startMonth: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    prisma.studentTariff.count({ where: filter }),
  ]);

  const studentIds = [...new Set(rows.map((r) => r.studentId))];
  const tariffIds = [...new Set(rows.map((r) => r.tariffId))];

  const [students, tariffs, resolution] = await Promise.all([
    studentIds.length
      ? prisma.user.findMany({
          where: { id: { in: studentIds } },
          select: STUDENT_SELECT,
        })
      : [],
    tariffIds.length
      ? platformPrisma.tariff.findMany({
          where: { id: { in: tariffIds } },
          select: TARIFF_SELECT,
        })
      : [],
    studentIds.length
      ? resolveManyForMonth(month, { studentIds })
      : { byStudent: new Map() },
  ]);

  // O'quvchi/tarif o'chirilgan bo'lishi mumkin — soft ref, `null` qaytadi
  // va UI shuni ko'tara olishi kerak (premium.service.js uslubi).
  const studentMap = new Map(students.map((s) => [s.id, s]));
  const tariffMap = new Map(tariffs.map((t) => [t.id, t]));

  const items = rows.map((row) =>
    serializeAssignment(row, {
      student: studentMap.get(row.studentId) || null,
      tariff: tariffMap.get(row.tariffId) || null,
      // Summa faqat shu qator o'sha oyni qamrasa mos keladi.
      resolved:
        row.startMonth <= month && (row.endMonth == null || row.endMonth >= month)
          ? resolution.byStudent.get(row.studentId)
          : null,
    }),
  );

  return { ...formatPaginationResponse(items, total, page, limit), month };
};

/**
 * Bitta o'quvchining butun tarif tarixi.
 * @param {string} studentId
 * @returns {Promise<object>}
 */
const getStudentHistory = async (studentId) => {
  const student = await assertStudent(studentId);

  const rows = await prisma.studentTariff.findMany({
    where: { studentId },
    orderBy: { startMonth: "desc" },
  });

  const tariffIds = [...new Set(rows.map((r) => r.tariffId))];
  const tariffs = tariffIds.length
    ? await platformPrisma.tariff.findMany({
        where: { id: { in: tariffIds } },
        select: TARIFF_SELECT,
      })
    : [];
  const tariffMap = new Map(tariffs.map((t) => [t.id, t]));

  // Har bir davr uchun o'sha davrda amal qilgan narxlar (bitta biriktirish
  // ichida narx bir necha marta o'zgargan bo'lishi mumkin — tarix shuni
  // ko'rsatishi kerak).
  const versions = tariffIds.length
    ? await platformPrisma.tariffVersion.findMany({
        where: { tariffId: { in: tariffIds } },
        orderBy: { startMonth: "asc" },
      })
    : [];

  const items = rows.map((row) => {
    const periodVersions = versions
      .filter(
        (v) =>
          v.tariffId === row.tariffId &&
          (row.endMonth == null || v.startMonth <= row.endMonth) &&
          (v.endMonth == null || v.endMonth >= row.startMonth),
      )
      .map((v) => ({
        id: v.id,
        startMonth: v.startMonth,
        endMonth: v.endMonth,
        monthlyAmount: formatAmount(v.monthlyAmount),
      }));

    return {
      ...serializeAssignment(row, {
        student,
        tariff: tariffMap.get(row.tariffId) || null,
      }),
      priceHistory: periodVersions,
    };
  });

  return { student, items };
};

/**
 * Bitta biriktirish.
 * @param {string} id
 * @returns {Promise<object>}
 */
const getAssignmentById = async (id) => {
  const assignment = await prisma.studentTariff.findUnique({ where: { id } });
  if (!assignment) throw new NotFoundError("Biriktirish topilmadi");

  const [student, tariff] = await Promise.all([
    prisma.user.findUnique({
      where: { id: assignment.studentId },
      select: STUDENT_SELECT,
    }),
    platformPrisma.tariff.findUnique({
      where: { id: assignment.tariffId },
      select: TARIFF_SELECT,
    }),
  ]);

  return serializeAssignment(assignment, { student, tariff });
};

// ─────────────────────────────────────────────
// Yozish
// ─────────────────────────────────────────────

/**
 * Tarif biriktiradi.
 * @param {object} data - { studentId, tariffId, startMonth, endMonth, note }
 * @param {string} userId
 * @returns {Promise<object>} { ...assignment, warnings: string[] }
 */
const createAssignment = async (data, userId) => {
  if (!data.studentId) throw new BadRequestError("O'quvchi tanlanmagan");
  if (!data.tariffId) throw new BadRequestError("Tarif tanlanmagan");

  const period = parsePeriod(data.startMonth, data.endMonth);
  const [student, tariff] = await Promise.all([
    assertStudent(data.studentId),
    assertTariff(data.tariffId, { forAssignment: true }),
  ]);

  try {
    const assignment = await prisma.$transaction(async (tx) => {
      await assertNoAssignmentOverlap(tx, data.studentId, period);

      return tx.studentTariff.create({
        data: {
          studentId: data.studentId,
          tariffId: data.tariffId,
          ...period,
          note: data.note?.trim() || "",
          createdBy: userId,
        },
      });
    });

    const warnings = await collectWarnings(data.tariffId, period.startMonth);

    return { ...serializeAssignment(assignment, { student, tariff }), warnings };
  } catch (error) {
    return rethrowDuplicate(
      error,
      `O'quvchida ${formatMonthKey(period.startMonth)} oyidan boshlanadigan biriktirish allaqachon bor`,
    );
  }
};

/**
 * Biriktirishni tahrirlaydi. Amaldagi biriktirishning tarifi va boshlanish
 * oyi o'zgarmas — tarifni almashtirish uchun `changeTariff` bor (u eskisini
 * yopib, yangisini keyingi davrdan ochadi).
 *
 * @param {string} id
 * @param {object} data - { startMonth, endMonth, tariffId, note }
 * @returns {Promise<object>}
 */
const updateAssignment = async (id, data) => {
  const assignment = await prisma.studentTariff.findUnique({ where: { id } });
  if (!assignment) throw new NotFoundError("Biriktirish topilmadi");

  const now = currentMonthKey();
  const isInEffect = assignment.startMonth <= now;
  const payload = {};

  if (data.note !== undefined) payload.note = data.note?.trim() || "";

  if (data.tariffId !== undefined && data.tariffId !== assignment.tariffId) {
    if (isInEffect) {
      throw new BadRequestError(
        "Amaldagi biriktirishning tarifini o'zgartirib bo'lmaydi. Yangi oydan boshlab yangi tarif biriktiring.",
      );
    }
    await assertTariff(data.tariffId, { forAssignment: true });
    payload.tariffId = data.tariffId;
  }

  const wantsPeriodChange =
    data.startMonth !== undefined || data.endMonth !== undefined;

  if (wantsPeriodChange) {
    const period = parsePeriod(
      data.startMonth !== undefined ? data.startMonth : assignment.startMonth,
      data.endMonth !== undefined ? data.endMonth : assignment.endMonth,
    );

    if (isInEffect) {
      if (period.startMonth !== assignment.startMonth) {
        throw new BadRequestError(
          "Amaldagi biriktirishning boshlanish oyini o'zgartirib bo'lmaydi",
        );
      }
      const minEnd = Math.max(now, assignment.startMonth);
      if (period.endMonth != null && period.endMonth < minEnd) {
        throw new BadRequestError(
          `Amaldagi biriktirishni ${formatMonthKey(minEnd)} dan oldin yopib bo'lmaydi`,
        );
      }
    }

    payload.startMonth = period.startMonth;
    payload.endMonth = period.endMonth;
  }

  if (Object.keys(payload).length === 0) {
    return serializeAssignment(assignment);
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (payload.startMonth !== undefined || payload.endMonth !== undefined) {
        await assertNoAssignmentOverlap(
          tx,
          assignment.studentId,
          {
            startMonth: payload.startMonth ?? assignment.startMonth,
            endMonth:
              payload.endMonth !== undefined
                ? payload.endMonth
                : assignment.endMonth,
          },
          id,
        );
      }

      return tx.studentTariff.update({ where: { id }, data: payload });
    });

    return getAssignmentById(updated.id);
  } catch (error) {
    return rethrowDuplicate(
      error,
      "O'quvchida shu oydan boshlanadigan biriktirish allaqachon bor",
    );
  }
};

/**
 * Biriktirishni ko'rsatilgan oyda yopadi (o'quvchi ketdi / tarifdan chiqdi).
 * @param {string} id
 * @param {number|string} endMonth
 * @returns {Promise<object>}
 */
const closeAssignment = async (id, endMonth) =>
  updateAssignment(id, { endMonth: parseMonthKey(endMonth, "Tugash oyi") });

/**
 * Tarifni almashtirish — eskisini `fromMonth - 1` da yopib, yangisini
 * `fromMonth` dan ochadi. Bitta tranzaksiyada: ikki alohida so'rov qilinsa,
 * oraliqda o'quvchi tarifsiz qolib ketardi.
 *
 * @param {string} id
 * @param {object} data - { tariffId, fromMonth }
 * @param {string} userId
 * @returns {Promise<object>} { closed, created, warnings }
 */
const changeTariff = async (id, data, userId) => {
  const assignment = await prisma.studentTariff.findUnique({ where: { id } });
  if (!assignment) throw new NotFoundError("Biriktirish topilmadi");

  if (!data.tariffId) throw new BadRequestError("Yangi tarif tanlanmagan");

  const fromMonth = parseMonthKey(data.fromMonth, "Boshlanish oyi");
  const now = currentMonthKey();

  // Eski biriktirish `fromMonth - 1` da yopiladi — ya'ni joriy yoki o'tgan
  // oydan boshlash allaqachon o'tgan davrni kesib tashlash demakdir.
  if (fromMonth <= now) {
    throw new BadRequestError(
      `Tarifni almashtirish ${formatMonthKey(now)} dan keyingi oydan boshlanishi kerak`,
    );
  }

  if (fromMonth <= assignment.startMonth) {
    throw new BadRequestError(
      `Yangi tarif ${formatMonthKey(assignment.startMonth)} dan keyingi oydan boshlanishi kerak`,
    );
  }
  if (assignment.endMonth != null && fromMonth > assignment.endMonth) {
    throw new BadRequestError(
      "Yangi tarif joriy biriktirish davridan tashqarida boshlanmoqda",
    );
  }
  if (data.tariffId === assignment.tariffId) {
    throw new BadRequestError("Yangi tarif joriy tarif bilan bir xil");
  }

  const [student, tariff] = await Promise.all([
    assertStudent(assignment.studentId),
    assertTariff(data.tariffId, { forAssignment: true }),
  ]);

  const newPeriod = { startMonth: fromMonth, endMonth: assignment.endMonth };

  try {
    const result = await prisma.$transaction(async (tx) => {
      const closed = await tx.studentTariff.update({
        where: { id },
        data: { endMonth: prevMonth(fromMonth) },
      });

      await assertNoAssignmentOverlap(tx, assignment.studentId, newPeriod, id);

      const created = await tx.studentTariff.create({
        data: {
          studentId: assignment.studentId,
          tariffId: data.tariffId,
          ...newPeriod,
          note: data.note?.trim() || "",
          createdBy: userId,
        },
      });

      return { closed, created };
    });

    const warnings = await collectWarnings(data.tariffId, fromMonth);

    return {
      closed: serializeAssignment(result.closed, { student }),
      created: serializeAssignment(result.created, { student, tariff }),
      warnings,
    };
  } catch (error) {
    return rethrowDuplicate(
      error,
      `O'quvchida ${formatMonthKey(fromMonth)} oyidan boshlanadigan biriktirish allaqachon bor`,
    );
  }
};

/**
 * Ommaviy biriktirish (sinf yoki tanlangan o'quvchilar).
 * Bitta o'quvchidagi xato butun paketni to'xtatmaydi — u `skipped` ga tushadi.
 *
 * @param {object} data - { studentIds, classId, tariffId, startMonth, endMonth, note }
 * @param {string} userId
 * @returns {Promise<{created: object[], skipped: object[], warnings: string[]}>}
 */
const bulkAssign = async (data, userId) => {
  if (!data.tariffId) throw new BadRequestError("Tarif tanlanmagan");

  const period = parsePeriod(data.startMonth, data.endMonth);
  const tariff = await assertTariff(data.tariffId, { forAssignment: true });

  let studentIds = Array.isArray(data.studentIds) ? [...new Set(data.studentIds)] : [];

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
      const assignment = await prisma.$transaction(async (tx) => {
        await assertNoAssignmentOverlap(tx, studentId, period);
        return tx.studentTariff.create({
          data: {
            studentId,
            tariffId: data.tariffId,
            ...period,
            note: data.note?.trim() || "",
            createdBy: userId,
          },
        });
      });
      created.push(assignment);
    } catch (error) {
      skipped.push({
        studentId,
        reason:
          error?.code === "P2002"
            ? "Bu oydan boshlanadigan biriktirish allaqachon bor"
            : error.message,
      });
    }
  }

  const warnings = await collectWarnings(data.tariffId, period.startMonth);

  return {
    tariff,
    created: created.map((a) => serializeAssignment(a, { tariff })),
    skipped,
    warnings,
  };
};

/**
 * Biriktirishni o'chiradi — faqat hali boshlanmagan (kelajakdagi) yozuvni.
 * O'tgan davrni o'chirish moliyaviy tarixni yo'q qiladi; uning o'rniga
 * biriktirish yopiladi.
 *
 * @param {string} id
 * @returns {Promise<{message: string}>}
 */
const deleteAssignment = async (id) => {
  const assignment = await prisma.studentTariff.findUnique({ where: { id } });
  if (!assignment) throw new NotFoundError("Biriktirish topilmadi");

  if (assignment.startMonth <= currentMonthKey()) {
    throw new BadRequestError(
      "O'tgan yoki joriy oyni qamragan biriktirishni o'chirib bo'lmaydi. Uni yoping.",
    );
  }

  await prisma.studentTariff.delete({ where: { id } });

  return { message: "Biriktirish o'chirildi" };
};

module.exports = {
  getAssignments,
  getStudentHistory,
  getAssignmentById,
  createAssignment,
  updateAssignment,
  closeAssignment,
  changeTariff,
  bulkAssign,
  deleteAssignment,
};
