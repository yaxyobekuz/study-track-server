/**
 * O'quvchiga chegirma biriktirish — DAVR jadvali.
 *
 * ⚠️ StudentTariff bilan SHAKLI bir xil, MA'NOSI TESKARI.
 *
 * Tarifda kesishuv HAL QILINADI: `orderBy: { startMonth: "desc" }` va
 * birinchisi yutadi (tariffResolution.service.js:68) — ikkita biriktirish
 * kesishsa, natija baribir bitta narx.
 *
 * Chegirmada kesishuv QO'SHILADI. "Aka-uka 20%" [202609..202612] va yana
 * o'sha "Aka-uka 20%" [202610..] biriktirilsa, oktabr–dekabrda o'quvchi
 * 40% chegirma olardi va buni yil oxirigacha hech kim sezmasdi.
 *
 * Shuning uchun bu yerda uch qavatli himoya:
 *   1. Service darajasidagi kesishuv tekshiruvi (asosiy) — bir xil chegirma
 *      bir o'quvchida ikki marta qamramaydi;
 *   2. @@unique([studentId, discountId, startMonth]) — poyga backstop'i;
 *   3. Hal qilishda `discountId` bo'yicha dedup — ma'lumot buzilgan bo'lsa
 *      ham xato CHEKLANGAN qoladi (ikki baravar emas, bir marta).
 *
 * `isExclusive` chegirma (grant/homiylik) boshqasi bilan birga turolmaydi —
 * biriktirishda tekshiriladi.
 */

const prisma = require("../config/prisma");
// Chegirma KATALOGI platformada, biriktirishlar shu filialda.
const platformPrisma = require("../config/platformPrisma");
const {
  getPaginationParams,
  formatPaginationResponse,
} = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const {
  currentMonthKey,
  parseMonthKey,
  parseOptionalMonthKey,
  formatMonthKey,
  formatMonthRange,
  coveringMonthWhere,
  overlappingPeriodWhere,
} = require("../helpers/month.helpers");
const { serializeDiscount } = require("./discount.service");

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

const assertDiscount = async (discountId, { forAssign = false } = {}) => {
  const discount = await platformPrisma.discount.findUnique({ where: { id: discountId } });
  if (!discount) throw new NotFoundError("Chegirma topilmadi");

  if (forAssign && (discount.isArchived || !discount.isActive)) {
    throw new BadRequestError("Arxivlangan yoki nofaol chegirmani biriktirib bo'lmaydi");
  }

  return discount;
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
 * BIR XIL chegirma bir o'quvchida ikki marta qamramasin.
 *
 * Turli chegirmalar kesishishi QONUNIY (aka-uka + a'lochi) — shuning uchun
 * filtr `discountId` bo'yicha toraytirilgan, StudentFinanceStatus'dagi kabi
 * butun o'quvchi bo'yicha emas.
 */
const assertNoDiscountOverlap = async (
  tx,
  studentId,
  discountId,
  period,
  excludeId = null,
) => {
  const conflict = await tx.studentDiscount.findFirst({
    where: {
      studentId,
      discountId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      ...overlappingPeriodWhere(period.startMonth, period.endMonth),
    },
    orderBy: { startMonth: "asc" },
  });

  if (!conflict) return;

  throw new BadRequestError(
    `Bu chegirma o'quvchiga shu davr uchun allaqachon biriktirilgan (${formatMonthRange(
      conflict.startMonth,
      conflict.endMonth,
    )}). Tugash oyini ko'rsating yoki o'sha yozuvni tahrirlang.`,
  );
};

/**
 * `isExclusive` qoidasi: grant chegirmasi boshqa chegirma bilan bir vaqtda
 * amal qila olmaydi. Ikkala yo'nalish ham tekshiriladi — yangisi eksklyuziv
 * bo'lsa ham, mavjudi eksklyuziv bo'lsa ham.
 */
const assertExclusivity = async (tx, studentId, discount, period, excludeId = null) => {
  const others = await tx.studentDiscount.findMany({
    where: {
      studentId,
      discountId: { not: discount.id },
      ...(excludeId ? { id: { not: excludeId } } : {}),
      ...overlappingPeriodWhere(period.startMonth, period.endMonth),
    },
  });

  if (others.length === 0) return;

  if (discount.isExclusive) {
    throw new BadRequestError(
      `"${discount.name}" boshqa chegirmalar bilan birga berilmaydi, lekin o'quvchida shu davrda ${others.length} ta chegirma bor`,
    );
  }

  // Katalog PLATFORMADA — filial tranzaksiyasi (tx) unga kira olmaydi va
  // kirishi SHART EMAS: bu o'zgarmas qoidalar ro'yxatini o'qish, biriktirish
  // qatorining o'zi bilan bir xil izolyatsiyani talab qilmaydi.
  const catalog = await platformPrisma.discount.findMany({
    where: { id: { in: others.map((o) => o.discountId) }, isExclusive: true },
    select: { name: true },
  });

  if (catalog.length > 0) {
    throw new BadRequestError(
      `O'quvchida shu davrda "${catalog[0].name}" chegirmasi bor — u boshqa chegirmalar bilan birga berilmaydi`,
    );
  }
};

const rethrowDuplicate = (error, message) => {
  if (error?.code === "P2002") throw new BadRequestError(message);
  throw error;
};

// ─────────────────────────────────────────────
// Hal qilish (generator uchun)
// ─────────────────────────────────────────────

/**
 * Ko'p o'quvchining berilgan oydagi chegirmalari.
 *
 * `resolveManyForMonth` bilan bir xil shakl: o'quvchilar soniga qaramay
 * IKKITA so'rov (biriktirishlar, so'ng katalog), qolgani xotirada.
 *
 * @param {number} month - YYYYMM
 * @param {{studentIds?: string[]}} options
 * @returns {Promise<Map<string, Array<{id, name, type, value, isExclusive}>>>}
 */
const resolveDiscountsForMonth = async (month, { studentIds } = {}) => {
  const rows = await prisma.studentDiscount.findMany({
    where: {
      ...(studentIds?.length ? { studentId: { in: studentIds } } : {}),
      ...coveringMonthWhere(month),
    },
    orderBy: { startMonth: "desc" },
  });

  const byStudent = new Map();
  if (rows.length === 0) return byStudent;

  const catalog = await platformPrisma.discount.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.discountId))] } },
  });
  const catalogMap = new Map(catalog.map((d) => [d.id, d]));

  for (const row of rows) {
    const discount = catalogMap.get(row.discountId);
    if (!discount) continue; // katalog qatori yo'q — jimgina o'tkazib yuboriladi

    if (!byStudent.has(row.studentId)) byStudent.set(row.studentId, []);
    const list = byStudent.get(row.studentId);

    // DEDUP: bir xil chegirma ikki qator bilan qamragan bo'lsa (ma'lumot
    // buzilgan), u BIR MARTA hisoblanadi — xato ikki baravarga o'smaydi.
    if (list.some((d) => d.id === discount.id)) continue;

    list.push({
      id: discount.id,
      name: discount.name,
      type: discount.type,
      value: discount.value,
      isExclusive: discount.isExclusive,
      assignmentId: row.id,
    });
  }

  return byStudent;
};

/**
 * Bitta o'quvchining berilgan oydagi chegirmalari.
 * @param {string} studentId
 * @param {number} month
 * @returns {Promise<Array<object>>}
 */
const resolveDiscountsForStudent = async (studentId, month) => {
  const map = await resolveDiscountsForMonth(month, { studentIds: [studentId] });
  return map.get(studentId) ?? [];
};

// ─────────────────────────────────────────────
// O'qish
// ─────────────────────────────────────────────

const serializeAssignment = (row, { student, discount } = {}) => ({
  ...row,
  startMonthLabel: formatMonthKey(row.startMonth),
  endMonthLabel: formatMonthKey(row.endMonth),
  periodLabel: formatMonthRange(row.startMonth, row.endMonth),
  isActive:
    row.startMonth <= currentMonthKey() &&
    (row.endMonth == null || row.endMonth >= currentMonthKey()),
  student: student ?? null,
  discount: discount ? serializeDiscount(discount) : null,
});

/**
 * Biriktirishlar ro'yxati (sahifalangan).
 * @param {object} req - query: page, limit, studentId, discountId, activeOnly, month
 * @returns {Promise<object>}
 */
const getAssignments = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const month = query.month ? parseMonthKey(query.month, "Oy") : currentMonthKey();

  const filter = {};
  if (query.studentId) filter.studentId = query.studentId;
  if (query.discountId) filter.discountId = query.discountId;
  if (query.activeOnly === "true") Object.assign(filter, coveringMonthWhere(month));

  const [rows, total] = await Promise.all([
    prisma.studentDiscount.findMany({
      where: filter,
      orderBy: [{ startMonth: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    prisma.studentDiscount.count({ where: filter }),
  ]);

  // O'quvchi va katalog alohida yuklanadi — soft ref'da join yo'q
  const [students, discounts] = await Promise.all([
    rows.length
      ? prisma.user.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.studentId))] } },
          select: STUDENT_SELECT,
        })
      : [],
    rows.length
      ? platformPrisma.discount.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.discountId))] } },
        })
      : [],
  ]);

  const studentMap = new Map(students.map((s) => [s.id, s]));
  const discountMap = new Map(discounts.map((d) => [d.id, d]));

  const items = rows.map((row) =>
    serializeAssignment(row, {
      student: studentMap.get(row.studentId) || null,
      discount: discountMap.get(row.discountId) || null,
    }),
  );

  return { ...formatPaginationResponse(items, total, page, limit), month };
};

/**
 * Bitta o'quvchining chegirma tarixi + joriy oydagi amaldagilari.
 * @param {string} studentId
 * @returns {Promise<object>}
 */
const getStudentDiscounts = async (studentId) => {
  const student = await assertStudent(studentId);
  const month = currentMonthKey();

  const rows = await prisma.studentDiscount.findMany({
    where: { studentId },
    orderBy: { startMonth: "desc" },
  });

  const discounts = rows.length
    ? await platformPrisma.discount.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.discountId))] } },
      })
    : [];
  const discountMap = new Map(discounts.map((d) => [d.id, d]));

  const items = rows.map((row) =>
    serializeAssignment(row, { student, discount: discountMap.get(row.discountId) || null }),
  );

  return {
    student,
    month,
    monthLabel: formatMonthKey(month),
    current: items.filter((i) => i.isActive),
    items,
  };
};

const getAssignmentById = async (id) => {
  const row = await prisma.studentDiscount.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Chegirma biriktiruvi topilmadi");

  const [student, discount] = await Promise.all([
    prisma.user.findUnique({ where: { id: row.studentId }, select: STUDENT_SELECT }),
    platformPrisma.discount.findUnique({ where: { id: row.discountId } }),
  ]);

  return serializeAssignment(row, { student, discount });
};

// ─────────────────────────────────────────────
// Yozish
// ─────────────────────────────────────────────

/**
 * Chegirma biriktiradi.
 *
 * StudentFinanceStatus kabi joriy oydan boshlash ruxsat etilgan — chegirma
 * berish tez-tez oy o'rtasida hal qilinadi. O'TGAN oy uchun `allowPast`
 * (controller `discounts.assign` ustiga `finance.adjust` talab qiladi).
 *
 * @param {object} data - { studentId, discountId, startMonth, endMonth, note }
 * @param {string} userId
 * @param {{allowPast?: boolean}} options
 * @returns {Promise<object>}
 */
const createAssignment = async (data, userId, { allowPast = false } = {}) => {
  if (!data.studentId) throw new BadRequestError("O'quvchi tanlanmagan");
  if (!data.discountId) throw new BadRequestError("Chegirma tanlanmagan");

  const period = parsePeriod(data.startMonth, data.endMonth);
  const [student, discount] = await Promise.all([
    assertStudent(data.studentId),
    assertDiscount(data.discountId, { forAssign: true }),
  ]);

  if (!allowPast && period.startMonth < currentMonthKey()) {
    throw new BadRequestError(
      "O'tgan oydan boshlanadigan chegirma biriktirish uchun alohida ruxsat kerak",
    );
  }

  try {
    const row = await prisma.$transaction(async (tx) => {
      await assertNoDiscountOverlap(tx, data.studentId, data.discountId, period);
      await assertExclusivity(tx, data.studentId, discount, period);

      return tx.studentDiscount.create({
        data: {
          studentId: data.studentId,
          discountId: data.discountId,
          ...period,
          note: data.note?.trim() || "",
          createdBy: userId,
        },
      });
    });

    const warnings = await collectInvoiceWarnings(data.studentId, period);

    return { ...serializeAssignment(row, { student, discount }), warnings };
  } catch (error) {
    return rethrowDuplicate(
      error,
      `Bu chegirma ${formatMonthKey(period.startMonth)} oyidan boshlab allaqachon biriktirilgan`,
    );
  }
};

/**
 * ALLAQACHON shakllangan hisob-fakturalar haqida ogohlantirish.
 *
 * Hisob-faktura summasi MUHRLANGAN: kech qo'shilgan chegirma o'tgan oyni
 * arzonlashtirmaydi. Admin buni hali harakat qila oladigan paytda
 * ko'rishi kerak (`POST /invoices/:id/regenerate` bor).
 */
const collectInvoiceWarnings = async (studentId, period) => {
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
    `${months} uchun hisob-faktura allaqachon shakllantirilgan — ularning summasi o'zgarmaydi. ` +
      "Kerak bo'lsa hisob-fakturani qayta shakllantiring.",
  ];
};

/**
 * Biriktirishni tahrirlaydi. Amaldagi yozuvda `discountId` va `startMonth`
 * o'zgarmas — faqat `endMonth` (oldinga) va `note`.
 *
 * @param {string} id
 * @param {object} data
 * @param {{allowPast?: boolean}} options
 * @returns {Promise<object>}
 */
const updateAssignment = async (id, data, { allowPast = false } = {}) => {
  const row = await prisma.studentDiscount.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Chegirma biriktiruvi topilmadi");

  const now = currentMonthKey();
  const isInEffect = row.startMonth <= now;
  const payload = {};

  if (data.note !== undefined) payload.note = data.note?.trim() || "";

  if (data.discountId !== undefined && data.discountId !== row.discountId) {
    if (isInEffect && !allowPast) {
      throw new BadRequestError(
        "Amaldagi biriktirishning chegirmasini almashtirib bo'lmaydi. Uni yopib, yangisini qo'shing.",
      );
    }
    await assertDiscount(data.discountId, { forAssign: true });
    payload.discountId = data.discountId;
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
          "Amaldagi biriktirishning boshlanish oyini o'zgartirib bo'lmaydi",
        );
      }
      const minEnd = Math.max(now, row.startMonth);
      if (period.endMonth != null && period.endMonth < minEnd) {
        throw new BadRequestError(
          `Amaldagi chegirmani ${formatMonthKey(minEnd)} dan oldin yopib bo'lmaydi`,
        );
      }
    }

    payload.startMonth = period.startMonth;
    payload.endMonth = period.endMonth;
  }

  if (Object.keys(payload).length === 0) return getAssignmentById(id);

  try {
    await prisma.$transaction(async (tx) => {
      if (payload.startMonth !== undefined || payload.discountId !== undefined) {
        const period = {
          startMonth: payload.startMonth ?? row.startMonth,
          endMonth: payload.endMonth !== undefined ? payload.endMonth : row.endMonth,
        };
        const discountId = payload.discountId ?? row.discountId;

        await assertNoDiscountOverlap(tx, row.studentId, discountId, period, id);

        const discount = await platformPrisma.discount.findUnique({ where: { id: discountId } });
        await assertExclusivity(tx, row.studentId, discount, period, id);
      }

      return tx.studentDiscount.update({ where: { id }, data: payload });
    });

    return getAssignmentById(id);
  } catch (error) {
    return rethrowDuplicate(
      error,
      "Bu chegirma shu oydan boshlab allaqachon biriktirilgan",
    );
  }
};

/**
 * Chegirmani ko'rsatilgan oyda yopadi.
 * @param {string} id
 * @param {number|string} endMonth
 * @returns {Promise<object>}
 */
const closeAssignment = async (id, endMonth) =>
  updateAssignment(id, { endMonth: parseMonthKey(endMonth, "Tugash oyi") });

/**
 * Ommaviy biriktirish (sinf yoki tanlangan o'quvchilar).
 * Bitta o'quvchidagi xato butun paketni to'xtatmaydi.
 *
 * @param {object} data - { studentIds, classId, discountId, startMonth, endMonth, note }
 * @param {string} userId
 * @param {{allowPast?: boolean}} options
 * @returns {Promise<object>}
 */
const bulkAssign = async (data, userId, { allowPast = false } = {}) => {
  if (!data.discountId) throw new BadRequestError("Chegirma tanlanmagan");

  const period = parsePeriod(data.startMonth, data.endMonth);
  const discount = await assertDiscount(data.discountId, { forAssign: true });

  if (!allowPast && period.startMonth < currentMonthKey()) {
    throw new BadRequestError(
      "O'tgan oydan boshlanadigan chegirma biriktirish uchun alohida ruxsat kerak",
    );
  }

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

  if (studentIds.length === 0) throw new BadRequestError("O'quvchilar tanlanmagan");

  const created = [];
  const skipped = [];

  for (const studentId of studentIds) {
    try {
      const row = await prisma.$transaction(async (tx) => {
        await assertNoDiscountOverlap(tx, studentId, data.discountId, period);
        await assertExclusivity(tx, studentId, discount, period);

        return tx.studentDiscount.create({
          data: {
            studentId,
            discountId: data.discountId,
            ...period,
            note: data.note?.trim() || "",
            createdBy: userId,
          },
        });
      });
      created.push(serializeAssignment(row, { discount }));
    } catch (error) {
      skipped.push({
        studentId,
        reason:
          error?.code === "P2002"
            ? "Bu chegirma shu oydan boshlab allaqachon biriktirilgan"
            : error.message,
      });
    }
  }

  const invoiceCount = created.length
    ? await prisma.monthlyInvoice.count({
        where: {
          studentId: { in: created.map((r) => r.studentId) },
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
        `${invoiceCount} ta hisob-faktura bu davr uchun allaqachon shakllantirilgan — ularning summasi o'zgarmaydi`,
      ]
    : [];

  return { created, skipped, warnings };
};

/**
 * Biriktirishni o'chiradi — faqat hali boshlanmaganini.
 * @param {string} id
 * @returns {Promise<{message: string}>}
 */
const deleteAssignment = async (id) => {
  const row = await prisma.studentDiscount.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Chegirma biriktiruvi topilmadi");

  if (row.startMonth <= currentMonthKey()) {
    throw new BadRequestError(
      "O'tgan yoki joriy oyni qamragan biriktirishni o'chirib bo'lmaydi. Uni yoping.",
    );
  }

  await prisma.studentDiscount.delete({ where: { id } });

  return { message: "Chegirma biriktiruvi o'chirildi" };
};

module.exports = {
  serializeAssignment,
  resolveDiscountsForMonth,
  resolveDiscountsForStudent,
  getAssignments,
  getStudentDiscounts,
  getAssignmentById,
  createAssignment,
  updateAssignment,
  closeAssignment,
  bulkAssign,
  deleteAssignment,
};
