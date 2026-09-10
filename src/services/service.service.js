/**
 * QO'SHIMCHA XIZMATLAR (yotoqxona, ovqat, transport, ...) — katalog +
 * o'quvchiga biriktirish.
 *
 * Xizmat summasi o'quvchining oylik hisob-fakturasiga tarif narxi USTIGA
 * QO'SHILADI (`invoiceBuilder.computeMonthlyAmount` → base = tarif + xizmatlar).
 * Alohida hisob-faktura YO'Q — kalit (o'quvchi, oy) o'zgarmaydi, to'lov
 * taqsimoti/depozit/reconcile ga tegilmaydi.
 *
 * KATALOG FILIALDA (tarifdan farqli): yotoqxona bir filialda bor, boshqasida
 * yo'q; narxi ham filialniki. Versiyalanmaydi — narx o'zgarsa maydon
 * yangilanadi va to'lanmagan fakturalar AVTOMATIK qayta hisoblanadi
 * (to'langanlari muhrlangan).
 *
 * Biriktirish — StudentDiscount naqshi: davr (oy aniqligida), bir o'quvchida
 * bir vaqtda BIR NECHTA xizmat bo'lishi mumkin va HAMMASI qo'shiladi, lekin
 * BITTA xizmat bir oyni ikki marta qamramasin — kesishuv tekshiruvi MAJBURIY.
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
  parseMonthKey,
  parseOptionalMonthKey,
  formatMonthKey,
  formatMonthRange,
  coveringMonthWhere,
  overlappingPeriodWhere,
  prevMonth,
} = require("../helpers/month.helpers");
const { parseAmount, formatAmount, Decimal } = require("../helpers/money.helpers");
const logger = require("../utils/logger");

const STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  isArchived: true,
};

// ─────────────────────────────────────────────
// Yordamchilar
// ─────────────────────────────────────────────

/**
 * Xizmat/biriktirma o'zgargach o'quvchining TO'LANMAGAN hisob-fakturalarini
 * avtomatik qayta shakllantiradi (best-effort — asosiy amalni to'xtatmaydi).
 * To'langan oylar muhrlangan: regen ularga tegmaydi.
 */
const autoRegen = async (studentIds, fromMonth) => {
  try {
    const { regenerateForStudents } = require("./invoice.service");
    await regenerateForStudents(studentIds, { fromMonth });
  } catch (error) {
    logger.warn(`[auto-regen] ${error.message}`);
  }
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

const assertService = async (serviceId, { forAssign = false } = {}) => {
  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!service) throw new NotFoundError("Xizmat topilmadi");

  if (forAssign && service.isArchived) {
    throw new BadRequestError("Arxivlangan xizmatni biriktirib bo'lmaydi");
  }

  return service;
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

/** null/"" → null (katalog narxi), aks holda musbat summa. */
const parseCustomAmount = (value) => {
  if (value == null || String(value).trim() === "") return null;
  return parseAmount(value, "Individual narx");
};

/**
 * BIR XIL xizmat bir o'quvchida ikki marta qamramasin. Turli xizmatlar
 * kesishishi QONUNIY (yotoqxona + ovqat) — filtr `serviceId` bo'yicha.
 */
const assertNoServiceOverlap = async (
  tx,
  studentId,
  serviceId,
  period,
  excludeId = null,
) => {
  const conflict = await tx.studentService.findFirst({
    where: {
      studentId,
      serviceId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      ...overlappingPeriodWhere(period.startMonth, period.endMonth),
    },
    orderBy: { startMonth: "asc" },
  });

  if (!conflict) return;

  throw new BadRequestError(
    `Bu xizmat o'quvchiga shu davr uchun allaqachon biriktirilgan (${formatMonthRange(
      conflict.startMonth,
      conflict.endMonth,
    )}). Tugash oyini ko'rsating yoki o'sha yozuvni tahrirlang.`,
  );
};

const rethrowDuplicate = (error, message) => {
  if (error?.code === "P2002") throw new BadRequestError(message);
  throw error;
};

const serializeService = (service, { assignedCount } = {}) => ({
  id: service.id,
  name: service.name,
  monthlyAmount: formatAmount(service.monthlyAmount),
  note: service.note,
  isArchived: service.isArchived,
  createdAt: service.createdAt,
  ...(assignedCount !== undefined ? { assignedCount } : {}),
});

const serializeAssignment = (row, { student, service } = {}) => ({
  id: row.id,
  studentId: row.studentId,
  serviceId: row.serviceId,
  startMonth: row.startMonth,
  endMonth: row.endMonth,
  periodLabel: formatMonthRange(row.startMonth, row.endMonth),
  customAmount: row.customAmount != null ? formatAmount(row.customAmount) : null,
  note: row.note,
  createdAt: row.createdAt,
  ...(service
    ? {
        service: {
          id: service.id,
          name: service.name,
          monthlyAmount: formatAmount(service.monthlyAmount),
          isArchived: service.isArchived,
        },
        // Amal qiladigan oylik summa: individual narx yoki katalog narxi
        effectiveAmount: formatAmount(row.customAmount ?? service.monthlyAmount),
      }
    : {}),
  ...(student
    ? {
        student: {
          id: student.id,
          fullName: `${student.firstName} ${student.lastName ?? ""}`.trim(),
          username: student.username,
        },
      }
    : {}),
});

// ─────────────────────────────────────────────
// Hal qilish (invoiceBuilder uchun)
// ─────────────────────────────────────────────

/**
 * Ko'p o'quvchining berilgan oydagi xizmatlari.
 * `resolveDiscountsForMonth` bilan bir xil shakl: IKKITA so'rov, qolgani
 * xotirada. Arxivlangan xizmat ham hisoblanadi — mavjud biriktirish uchun
 * narx hal qilinaveradi (tarif arxivi doktrinasi).
 *
 * @param {number} month - YYYYMM
 * @param {{studentIds?: string[]}} options
 * @returns {Promise<Map<string, Array<{id, name, amount, assignmentId}>>>}
 */
const resolveServicesForMonth = async (month, { studentIds } = {}) => {
  const rows = await prisma.studentService.findMany({
    where: {
      ...(studentIds?.length ? { studentId: { in: studentIds } } : {}),
      ...coveringMonthWhere(month),
    },
    orderBy: { startMonth: "desc" },
  });

  const byStudent = new Map();
  if (rows.length === 0) return byStudent;

  const catalog = await prisma.service.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.serviceId))] } },
  });
  const catalogMap = new Map(catalog.map((s) => [s.id, s]));

  for (const row of rows) {
    const service = catalogMap.get(row.serviceId);
    if (!service) continue; // katalog qatori yo'q — jimgina o'tkazib yuboriladi

    if (!byStudent.has(row.studentId)) byStudent.set(row.studentId, []);
    const list = byStudent.get(row.studentId);

    // DEDUP: bir xizmat ikki qator bilan qamragan bo'lsa (ma'lumot buzilgan),
    // u BIR MARTA hisoblanadi — xato ikki baravarga o'smaydi.
    if (list.some((s) => s.id === service.id)) continue;

    list.push({
      id: service.id,
      name: service.name,
      // Individual narx katalogdan ustun (StudentTariff.customAmount uslubi)
      amount: formatAmount(row.customAmount ?? service.monthlyAmount),
      assignmentId: row.id,
    });
  }

  return byStudent;
};

/** Bitta o'quvchining berilgan oydagi xizmatlari (regenerate/getMyFinance). */
const resolveServicesForStudent = async (studentId, month) => {
  const map = await resolveServicesForMonth(month, { studentIds: [studentId] });
  return map.get(studentId) ?? [];
};

// ─────────────────────────────────────────────
// Katalog CRUD
// ─────────────────────────────────────────────

const getServices = async ({ includeArchived = false } = {}) => {
  const services = await prisma.service.findMany({
    where: includeArchived ? {} : { isArchived: false },
    orderBy: { createdAt: "asc" },
  });

  if (services.length === 0) return [];

  // Joriy oyni qamragan biriktirishlar soni — katalog kartasida ko'rinadi
  const now = currentMonthKey();
  const rows = await prisma.studentService.groupBy({
    by: ["serviceId"],
    where: { serviceId: { in: services.map((s) => s.id) }, ...coveringMonthWhere(now) },
    _count: { studentId: true },
  });
  const counts = new Map(rows.map((r) => [r.serviceId, r._count.studentId]));

  return services.map((s) =>
    serializeService(s, { assignedCount: counts.get(s.id) ?? 0 }),
  );
};

const createService = async (data, userId) => {
  const name = data.name?.trim();
  if (!name) throw new BadRequestError("Xizmat nomi majburiy");

  const monthlyAmount = parseAmount(data.monthlyAmount, "Oylik summa");

  try {
    const service = await prisma.service.create({
      data: {
        name,
        monthlyAmount,
        note: data.note?.trim() || "",
        createdBy: userId,
      },
    });
    return serializeService(service, { assignedCount: 0 });
  } catch (error) {
    return rethrowDuplicate(error, "Bu nomli xizmat allaqachon mavjud");
  }
};

const updateService = async (id, data) => {
  const service = await prisma.service.findUnique({ where: { id } });
  if (!service) throw new NotFoundError("Xizmat topilmadi");

  const payload = {};
  if (data.name !== undefined) {
    const name = data.name?.trim();
    if (!name) throw new BadRequestError("Xizmat nomi majburiy");
    payload.name = name;
  }
  if (data.note !== undefined) payload.note = data.note?.trim() || "";

  let priceChanged = false;
  if (data.monthlyAmount !== undefined) {
    const amount = parseAmount(data.monthlyAmount, "Oylik summa");
    priceChanged = !amount.equals(service.monthlyAmount);
    payload.monthlyAmount = amount;
  }

  if (Object.keys(payload).length === 0) return serializeService(service);

  let updated;
  try {
    updated = await prisma.service.update({ where: { id }, data: payload });
  } catch (error) {
    return rethrowDuplicate(error, "Bu nomli xizmat allaqachon mavjud");
  }

  // Narx o'zgardi → shu xizmatga biriktirilgan o'quvchilarning to'lanmagan
  // fakturalari avtomatik qayta hisoblanadi (individual narxlilarga ta'sir
  // yo'q, lekin regen skipIfUnchanged bilan zararsiz).
  if (priceChanged) {
    const now = currentMonthKey();
    const assignments = await prisma.studentService.findMany({
      where: {
        serviceId: id,
        startMonth: { lte: now },
        OR: [{ endMonth: null }, { endMonth: { gte: now } }],
      },
      select: { studentId: true },
    });
    await autoRegen([...new Set(assignments.map((a) => a.studentId))], now);
  }

  return serializeService(updated);
};

const setServiceArchived = async (id, isArchived) => {
  const service = await prisma.service.findUnique({ where: { id } });
  if (!service) throw new NotFoundError("Xizmat topilmadi");

  const updated = await prisma.service.update({
    where: { id },
    data: { isArchived: Boolean(isArchived) },
  });

  return serializeService(updated);
};

const deleteService = async (id) => {
  const service = await prisma.service.findUnique({ where: { id } });
  if (!service) throw new NotFoundError("Xizmat topilmadi");

  const assignmentCount = await prisma.studentService.count({
    where: { serviceId: id },
  });

  if (assignmentCount > 0) {
    throw new BadRequestError(
      `Bu xizmatga ${assignmentCount} ta biriktirish bor — o'chirib bo'lmaydi. Uni arxivlang.`,
    );
  }

  await prisma.service.delete({ where: { id } });

  return { message: "Xizmat o'chirildi" };
};

// ─────────────────────────────────────────────
// O'quvchilar ro'yxati (xizmatlari bilan)
// ─────────────────────────────────────────────

/**
 * BARCHA o'quvchilar + joriy oydagi xizmatlari. "Qo'shimcha xizmatlar"
 * sahifasining asosiy jadvali: o'quvchini tanlab xizmat biriktiriladi.
 *
 * @param {object} req - Express request ({ query: { page, limit, search, classId, serviceId, month } })
 */
const getStudentsWithServices = async (req) => {
  const { page, limit, skip } = getPaginationParams(req, 24);
  const query = req.query ?? {};
  const month =
    query.month != null && String(query.month).trim() !== ""
      ? parseMonthKey(query.month, "Oy")
      : currentMonthKey();

  const where = {
    role: ROLES.STUDENT,
    isArchived: false,
    ...(query.classId ? { classes: { some: { classId: query.classId } } } : {}),
    ...(query.search
      ? {
          OR: [
            { firstName: { contains: query.search, mode: "insensitive" } },
            { lastName: { contains: query.search, mode: "insensitive" } },
            { username: { contains: query.search, mode: "insensitive" } },
          ],
        }
      : {}),
    // Faqat shu xizmatga biriktirilganlar filtri
    ...(query.serviceId
      ? {
          // soft ref: User ↔ StudentService relation yo'q — id ro'yxati bilan
          id: {
            in: (
              await prisma.studentService.findMany({
                where: { serviceId: query.serviceId, ...coveringMonthWhere(month) },
                select: { studentId: true },
              })
            ).map((r) => r.studentId),
          },
        }
      : {}),
  };

  const [students, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        ...STUDENT_SELECT,
        classes: { select: { class: { select: { id: true, name: true } } } },
      },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  // Sahifadagi o'quvchilarning shu oydagi biriktirmalari (davr qatorlari)
  const assignments = students.length
    ? await prisma.studentService.findMany({
        where: {
          studentId: { in: students.map((s) => s.id) },
          ...coveringMonthWhere(month),
        },
        orderBy: { startMonth: "desc" },
      })
    : [];

  const catalog = assignments.length
    ? await prisma.service.findMany({
        where: { id: { in: [...new Set(assignments.map((a) => a.serviceId))] } },
      })
    : [];
  const catalogMap = new Map(catalog.map((s) => [s.id, s]));

  const byStudent = new Map();
  for (const row of assignments) {
    const service = catalogMap.get(row.serviceId);
    if (!service) continue;
    if (!byStudent.has(row.studentId)) byStudent.set(row.studentId, []);
    const list = byStudent.get(row.studentId);
    if (list.some((a) => a.serviceId === row.serviceId)) continue; // dedup
    list.push(serializeAssignment(row, { service }));
  }

  const items = students.map((student) => {
    const services = byStudent.get(student.id) ?? [];
    const servicesTotal = services.reduce(
      (sum, a) => sum.plus(a.effectiveAmount),
      new Decimal(0),
    );

    return {
      id: student.id,
      fullName: `${student.firstName} ${student.lastName ?? ""}`.trim(),
      username: student.username,
      className: student.classes[0]?.class?.name ?? null,
      services,
      servicesTotal: formatAmount(servicesTotal),
    };
  });

  return {
    ...formatPaginationResponse(items, total, page, limit),
    month,
    monthLabel: formatMonthKey(month),
  };
};

// ─────────────────────────────────────────────
// Biriktirish CRUD
// ─────────────────────────────────────────────

const createAssignment = async (data, userId) => {
  if (!data.studentId) throw new BadRequestError("O'quvchi tanlanmagan");
  if (!data.serviceId) throw new BadRequestError("Xizmat tanlanmagan");

  const period = parsePeriod(data.startMonth ?? currentMonthKey(), data.endMonth);
  const [student, service] = await Promise.all([
    assertStudent(data.studentId),
    assertService(data.serviceId, { forAssign: true }),
  ]);

  if (period.startMonth < currentMonthKey()) {
    throw new BadRequestError(
      "O'tgan oydan boshlanadigan xizmat biriktirib bo'lmaydi — o'tgan oylar muhrlangan",
    );
  }

  try {
    const row = await prisma.$transaction(async (tx) => {
      await assertNoServiceOverlap(tx, data.studentId, data.serviceId, period);

      return tx.studentService.create({
        data: {
          studentId: data.studentId,
          serviceId: data.serviceId,
          ...period,
          customAmount: parseCustomAmount(data.customAmount),
          note: data.note?.trim() || "",
          createdBy: userId,
        },
      });
    });

    // Xizmat qo'shildi → to'lanmagan oylar avtomatik qayta hisoblanadi
    await autoRegen([data.studentId], period.startMonth);

    return serializeAssignment(row, { student, service });
  } catch (error) {
    return rethrowDuplicate(
      error,
      `Bu xizmat ${formatMonthKey(period.startMonth)} oyidan boshlab allaqachon biriktirilgan`,
    );
  }
};

/**
 * Biriktirmani tahrirlaydi. Amaldagi yozuvda faqat `endMonth` (joriy oydan
 * oldinga emas), `customAmount` va `note` — o'tgan oylar muhrlangan.
 */
const updateAssignment = async (id, data) => {
  const row = await prisma.studentService.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Xizmat biriktiruvi topilmadi");

  const now = currentMonthKey();
  const isInEffect = row.startMonth <= now;
  const payload = {};

  if (data.note !== undefined) payload.note = data.note?.trim() || "";
  if (data.customAmount !== undefined) {
    payload.customAmount = parseCustomAmount(data.customAmount);
  }

  const wantsPeriodChange =
    data.startMonth !== undefined || data.endMonth !== undefined;

  if (wantsPeriodChange) {
    const period = parsePeriod(
      data.startMonth !== undefined ? data.startMonth : row.startMonth,
      data.endMonth !== undefined ? data.endMonth : row.endMonth,
    );

    if (isInEffect) {
      if (period.startMonth !== row.startMonth) {
        throw new BadRequestError(
          "Amaldagi biriktirishning boshlanish oyini o'zgartirib bo'lmaydi",
        );
      }
      // Yopish eng erta O'TGAN OYda: joriy oydan boshlab xizmat olib
      // tashlanadi (to'lanmagan faktura qayta hisoblanadi), undan oldingi
      // oylar esa muhrlangan tarixdir.
      const minEnd = Math.max(prevMonth(now), row.startMonth);
      if (period.endMonth != null && period.endMonth < minEnd) {
        throw new BadRequestError(
          `Bu biriktirishni ${formatMonthKey(minEnd)} dan oldin yopib bo'lmaydi`,
        );
      }
    }

    payload.startMonth = period.startMonth;
    payload.endMonth = period.endMonth;
  }

  if (Object.keys(payload).length === 0) return getAssignmentById(id);

  try {
    await prisma.$transaction(async (tx) => {
      if (payload.startMonth !== undefined) {
        await assertNoServiceOverlap(
          tx,
          row.studentId,
          row.serviceId,
          {
            startMonth: payload.startMonth ?? row.startMonth,
            endMonth: payload.endMonth !== undefined ? payload.endMonth : row.endMonth,
          },
          id,
        );
      }

      return tx.studentService.update({ where: { id }, data: payload });
    });

    // Davr/narx o'zgardi → to'lanmagan oylar qayta hisoblanadi
    await autoRegen([row.studentId], row.startMonth);

    return getAssignmentById(id);
  } catch (error) {
    return rethrowDuplicate(
      error,
      "Bu xizmat shu oydan boshlab allaqachon biriktirilgan",
    );
  }
};

const getAssignmentById = async (id) => {
  const row = await prisma.studentService.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Xizmat biriktiruvi topilmadi");

  const [student, service] = await Promise.all([
    prisma.user.findUnique({ where: { id: row.studentId }, select: STUDENT_SELECT }),
    prisma.service.findUnique({ where: { id: row.serviceId } }),
  ]);

  return serializeAssignment(row, { student, service });
};

/** Xizmatni yopadi — o'quvchi xizmatdan chiqdi. */
const closeAssignment = async (id, endMonth) =>
  updateAssignment(id, { endMonth: parseMonthKey(endMonth, "Tugash oyi") });

/**
 * Biriktirmani o'chiradi — joriy yoki kelajak oydan boshlanganini.
 * (Joriy oyga ruxsat bor: "hozir xato qo'shdim" holati. To'lanmagan faktura
 * qayta hisoblanadi; to'langani baribir o'zgarmaydi.)
 */
const deleteAssignment = async (id) => {
  const row = await prisma.studentService.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Xizmat biriktiruvi topilmadi");

  const now = currentMonthKey();
  if (row.startMonth < now) {
    throw new BadRequestError(
      "O'tgan oyni qamragan biriktirishni o'chirib bo'lmaydi. Uni yoping.",
    );
  }

  await prisma.studentService.delete({ where: { id } });

  // Xizmat olib tashlandi → to'lanmagan faktura qayta hisoblanadi
  await autoRegen([row.studentId], row.startMonth);

  return { message: "Xizmat biriktiruvi o'chirildi" };
};

module.exports = {
  serializeService,
  serializeAssignment,
  resolveServicesForMonth,
  resolveServicesForStudent,
  getServices,
  createService,
  updateService,
  setServiceArchived,
  deleteService,
  getStudentsWithServices,
  createAssignment,
  updateAssignment,
  getAssignmentById,
  closeAssignment,
  deleteAssignment,
};
