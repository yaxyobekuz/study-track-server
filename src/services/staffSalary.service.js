/**
 * XODIM OYLIGI — QOIDA (davr bilan biriktirish).
 *
 * `studentTariff.service.js` bilan bir xil shakl: `[startMonth, endMonth?]`
 * davri, kesishuv taqiqlanadi, "eng kech boshlangani yutadi" naqshi.
 *
 * ⚠️ TARIFDAN FARQI: summa SHU YERDA saqlanadi. Tarif — katalog (ko'p
 * o'quvchiga bitta narx, versiyalar bilan), xodim oyligi esa har kimda
 * o'ziniki. Shuning uchun `TariffVersion` ga o'xshash qatlam kerak emas:
 * oylik o'zgarsa yangi DAVR ochiladi.
 *
 * ⚠️ OY ANIQLIGIDA, kun proratsiyasi YO'Q. "Fiksa" — qat'iy summa. Oy
 * o'rtasida ishga kirgan xodim uchun `startMonth` keyingi oydan qo'yiladi.
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
} = require("../helpers/month.helpers");
const { parseAmount, formatAmount, Decimal } = require("../helpers/money.helpers");
const { computeLessonHoursForStaff } = require("./lessonHours.service");

const STAFF_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  role: true,
  isArchived: true,
};

const TYPE_LABELS = {
  fixed: "Fiksa",
  kpi: "KPI (dars soati)",
  mixed: "Fiksa + KPI",
};

/** `type` ni komponentlardan hosil qiladi. */
const deriveSalaryType = (fixed, perHour) => {
  const hasFixed = fixed.greaterThan(0);
  const hasKpi = perHour.greaterThan(0);
  if (hasFixed && hasKpi) return "mixed";
  if (hasKpi) return "kpi";
  return "fixed";
};

/** Komponent summasini o'qiydi (bo'sh → 0, manfiy taqiqlangan). */
const parseComponent = (value, label) => {
  if (value === undefined || value === null || value === "") return new Decimal(0);
  return parseAmount(value, label);
};

const serializeSalary = (row, { staff, kpiPreview } = {}) => ({
  ...row,
  fixedAmount: formatAmount(row.fixedAmount),
  perHourRate: formatAmount(row.perHourRate),
  typeLabel: TYPE_LABELS[row.type] ?? row.type,
  periodLabel: formatMonthRange(row.startMonth, row.endMonth),
  startMonthLabel: formatMonthKey(row.startMonth),
  endMonthLabel: row.endMonth ? formatMonthKey(row.endMonth) : null,
  isOpen: row.endMonth == null,
  staff: staff ?? null,
  staffName: staff
    ? `${staff.firstName} ${staff.lastName ?? ""}`.trim()
    : "Noma'lum",
  ...(kpiPreview ? { kpiPreview } : {}),
});

/**
 * Xodim mavjudligini tekshiradi.
 *
 * ⚠️ O'QUVCHIGA oylik biriktirib bo'lmaydi — bu chiqim tomoni. Tekshiruv
 * bo'lmasa, o'quvchiga oylik yozib qo'yish mumkin bo'lardi va u ham
 * hisob-faktura oladigan, ham oylik oladigan holatga tushardi.
 */
const assertStaff = async (staffId) => {
  if (!staffId) throw new BadRequestError("Xodim tanlanmagan");

  const staff = await prisma.user.findUnique({
    where: { id: staffId },
    select: STAFF_SELECT,
  });

  if (!staff) throw new NotFoundError("Xodim topilmadi");
  if (staff.role === ROLES.STUDENT) {
    throw new BadRequestError("O'quvchiga oylik biriktirib bo'lmaydi");
  }

  return staff;
};

/** Davrni o'qiydi va tekshiradi (`studentTariff` bilan bir xil qoida). */
const parsePeriod = (startInput, endInput) => {
  const startMonth = startInput
    ? parseMonthKey(startInput, "Boshlanish oyi")
    : currentMonthKey();
  const endMonth = parseOptionalMonthKey(endInput, "Tugash oyi");

  if (endMonth != null && endMonth < startMonth) {
    throw new BadRequestError("Tugash oyi boshlanish oyidan oldin bo'lishi mumkin emas");
  }

  return { startMonth, endMonth };
};

const assertNoOverlap = async (tx, staffId, period, excludeId = null) => {
  const conflict = await tx.staffSalary.findFirst({
    where: {
      staffId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      ...overlappingPeriodWhere(period.startMonth, period.endMonth),
    },
    orderBy: { startMonth: "asc" },
  });

  if (conflict) {
    throw new BadRequestError(
      `Bu xodimda shu davr uchun oylik allaqachon belgilangan (${formatMonthRange(
        conflict.startMonth,
        conflict.endMonth,
      )})`,
    );
  }
};

/**
 * Berilgan oyda xodimning oyligi qancha.
 *
 * ⚠️ Kesishuv bo'lmasligi service darajasida kafolatlangan, lekin eski
 * ma'lumot uchun himoya qavati: eng KECH boshlangani yutadi (tarif
 * doktrinasi bilan bir xil).
 *
 * @param {string} staffId
 * @param {number} month - YYYYMM
 * @returns {Promise<object|null>}
 */
const resolveSalaryForMonth = async (staffId, month) => {
  const row = await prisma.staffSalary.findFirst({
    where: { staffId, ...coveringMonthWhere(month) },
    orderBy: { startMonth: "desc" },
  });

  return row ?? null;
};

/**
 * Bir oyda oylik oladigan BARCHA xodimlar — shakllantirish uchun.
 * So'rovlar soni xodimlar soniga BOG'LIQ EMAS: bitta so'rov.
 *
 * @param {number} month
 * @returns {Promise<Map<string, object>>} staffId → qoida
 */
const resolveSalariesForMonth = async (month) => {
  const rows = await prisma.staffSalary.findMany({
    where: coveringMonthWhere(month),
    orderBy: { startMonth: "asc" },
  });

  // Kesishuv bo'lsa eng KECH boshlangani yutadi — `asc` tartibda oxirgisi
  const byStaff = new Map();
  for (const row of rows) byStaff.set(row.staffId, row);

  return byStaff;
};

/** Qoidalar ro'yxati (sahifalangan). */
const getSalaries = async (req) => {
  const { page, limit, skip } = getPaginationParams(req);
  const { query } = req;

  const where = {};
  if (query.staffId) where.staffId = query.staffId;
  if (query.activeOnly === "true") {
    Object.assign(where, coveringMonthWhere(currentMonthKey()));
  }

  const [rows, total] = await Promise.all([
    prisma.staffSalary.findMany({
      where,
      orderBy: [{ startMonth: "desc" }, { createdAt: "desc" }],
      skip,
      take: limit,
    }),
    prisma.staffSalary.count({ where }),
  ]);

  const staff = rows.length
    ? await prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.staffId))] } },
        select: STAFF_SELECT,
      })
    : [];
  const staffMap = new Map(staff.map((s) => [s.id, s]));

  return formatPaginationResponse(
    rows.map((row) => serializeSalary(row, { staff: staffMap.get(row.staffId) })),
    total,
    page,
    limit,
  );
};

/** Bitta xodimning oylik tarixi. */
const getStaffHistory = async (staffId) => {
  const staff = await assertStaff(staffId);
  const month = currentMonthKey();

  const rows = await prisma.staffSalary.findMany({
    where: { staffId },
    orderBy: { startMonth: "desc" },
  });

  const current = rows.find(
    (r) => r.startMonth <= month && (r.endMonth == null || r.endMonth >= month),
  );

  // Joriy qoida KPI olsa — shu oy uchun dars soati va taxminiy summani ko'rsatamiz
  let currentKpiPreview = null;
  if (current && new Decimal(current.perHourRate).greaterThan(0)) {
    currentKpiPreview = await buildKpiPreview(staffId, month, current.perHourRate);
  }

  return {
    staff,
    currentMonth: month,
    currentMonthLabel: formatMonthKey(month),
    current: current
      ? serializeSalary(current, { staff, kpiPreview: currentKpiPreview })
      : null,
    items: rows.map((row) => serializeSalary(row, { staff })),
  };
};

/**
 * Dars soati preview'i (KPI summasini oldindan ko'rsatish uchun).
 * @param {string} staffId
 * @param {number} month - YYYYMM
 * @param {*} perHourRate - stavka (Decimal/string/number); berilsa KPI summasi ham
 */
const buildKpiPreview = async (staffId, month, perHourRate) => {
  const info = await computeLessonHoursForStaff(staffId, month);
  const rate = perHourRate != null ? new Decimal(perHourRate) : null;
  return {
    month,
    monthLabel: formatMonthKey(month),
    hours: info.hours,
    weeklyHours: info.weeklyHours,
    weeklyLessons: info.weeklyLessons,
    monthlyLessons: info.monthlyLessons,
    perHourRate: rate ? formatAmount(rate) : null,
    kpiAmount: rate ? formatAmount(rate.times(info.hours)) : null,
  };
};

/**
 * Xodimning berilgan oydagi dars soatini qaytaradi (forma preview'i uchun).
 * @param {string} staffId
 * @param {*} monthInput - YYYYMM (bo'sh → joriy oy)
 */
const getLessonHoursPreview = async (staffId, monthInput) => {
  const staff = await assertStaff(staffId);
  const month = monthInput ? parseMonthKey(monthInput, "Oy") : currentMonthKey();
  const preview = await buildKpiPreview(staffId, month, null);
  return { staff, ...preview };
};

/**
 * Oylik biriktirish. Ikki komponent bo'lishi mumkin (kamida bittasi > 0):
 *   fixedAmount — qat'iy oylik
 *   perHourRate — 1 dars soatiga to'lov (KPI)
 * `type` ulardan hosila.
 *
 * @param {object} data - { staffId, fixedAmount, perHourRate, startMonth, endMonth, note }
 *   (eski mijoz uchun `amount` = `fixedAmount` sifatida qabul qilinadi)
 * @param {string} userId
 */
const createSalary = async (data, userId) => {
  const staff = await assertStaff(data.staffId);

  const fixedAmount = parseComponent(data.fixedAmount ?? data.amount, "Fiksa oylik");
  const perHourRate = parseComponent(data.perHourRate, "1 dars soati narxi");

  if (fixedAmount.lessThanOrEqualTo(0) && perHourRate.lessThanOrEqualTo(0)) {
    throw new BadRequestError(
      "Kamida bittasi — fiksa oylik yoki KPI stavkasi — noldan katta bo'lishi kerak",
    );
  }

  const type = deriveSalaryType(fixedAmount, perHourRate);
  const period = parsePeriod(data.startMonth, data.endMonth);

  const created = await prisma.$transaction(async (tx) => {
    await assertNoOverlap(tx, staff.id, period);

    return tx.staffSalary.create({
      data: {
        staffId: staff.id,
        type,
        fixedAmount,
        perHourRate,
        ...period,
        note: data.note?.trim() || "",
        createdBy: userId,
      },
    });
  });

  return serializeSalary(created, { staff });
};

/**
 * Qoidani tahrirlash.
 *
 * ⚠️ Bu SHAKLLANGAN oylik majburiyatlarga ta'sir QILMAYDI — ular muhrlangan.
 * Tuzatish keyingi shakllantirishdan amal qiladi.
 */
const updateSalary = async (id, data) => {
  const row = await prisma.staffSalary.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Oylik qoidasi topilmadi");

  const payload = {};

  const wantsAmountChange =
    data.fixedAmount !== undefined ||
    data.amount !== undefined ||
    data.perHourRate !== undefined;

  if (wantsAmountChange) {
    const fixedAmount =
      data.fixedAmount !== undefined || data.amount !== undefined
        ? parseComponent(data.fixedAmount ?? data.amount, "Fiksa oylik")
        : new Decimal(row.fixedAmount);
    const perHourRate =
      data.perHourRate !== undefined
        ? parseComponent(data.perHourRate, "1 dars soati narxi")
        : new Decimal(row.perHourRate);

    if (fixedAmount.lessThanOrEqualTo(0) && perHourRate.lessThanOrEqualTo(0)) {
      throw new BadRequestError(
        "Kamida bittasi — fiksa oylik yoki KPI stavkasi — noldan katta bo'lishi kerak",
      );
    }

    payload.fixedAmount = fixedAmount;
    payload.perHourRate = perHourRate;
    payload.type = deriveSalaryType(fixedAmount, perHourRate);
  }

  if (data.note !== undefined) payload.note = data.note?.trim() || "";

  const wantsPeriodChange =
    data.startMonth !== undefined || data.endMonth !== undefined;

  if (wantsPeriodChange) {
    const period = parsePeriod(
      data.startMonth !== undefined ? data.startMonth : row.startMonth,
      data.endMonth !== undefined ? data.endMonth : row.endMonth,
    );
    Object.assign(payload, period);
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (wantsPeriodChange) {
      await assertNoOverlap(
        tx,
        row.staffId,
        { startMonth: payload.startMonth, endMonth: payload.endMonth },
        id,
      );
    }
    return tx.staffSalary.update({ where: { id }, data: payload });
  });

  const staff = await prisma.user.findUnique({
    where: { id: row.staffId },
    select: STAFF_SELECT,
  });

  return serializeSalary(updated, { staff });
};

/**
 * Qoidani yopish — xodim ketdi yoki oylik o'zgardi.
 * O'chirish O'RNIGA: shakllangan majburiyatlar unga ishora qiladi.
 */
const closeSalary = async (id, endMonthInput) => {
  const row = await prisma.staffSalary.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Oylik qoidasi topilmadi");

  const endMonth = endMonthInput
    ? parseMonthKey(endMonthInput, "Tugash oyi")
    : currentMonthKey();

  if (endMonth < row.startMonth) {
    throw new BadRequestError("Tugash oyi boshlanish oyidan oldin bo'lishi mumkin emas");
  }

  const updated = await prisma.staffSalary.update({
    where: { id },
    data: { endMonth },
  });

  return serializeSalary(updated);
};

/**
 * O'chirish — FAQAT hech qanday oylik majburiyat shakllanmagan bo'lsa.
 * Aks holda yopiladi (tarif biriktirmasi bilan bir xil qoida).
 */
const deleteSalary = async (id) => {
  const row = await prisma.staffSalary.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Oylik qoidasi topilmadi");

  const used = await prisma.payrollEntry.count({
    where: {
      staffId: row.staffId,
      month: {
        gte: row.startMonth,
        ...(row.endMonth != null ? { lte: row.endMonth } : {}),
      },
    },
  });

  if (used > 0) {
    throw new BadRequestError(
      `Bu davr uchun ${used} ta oylik majburiyati shakllantirilgan — ` +
        "o'chirib bo'lmaydi. Qoidani yoping.",
    );
  }

  await prisma.staffSalary.delete({ where: { id } });
  return { message: "Oylik qoidasi o'chirildi" };
};

module.exports = {
  STAFF_SELECT,
  TYPE_LABELS,
  deriveSalaryType,
  serializeSalary,
  assertStaff,
  resolveSalaryForMonth,
  resolveSalariesForMonth,
  getSalaries,
  getStaffHistory,
  getLessonHoursPreview,
  createSalary,
  updateSalary,
  closeSalary,
  deleteSalary,
};
