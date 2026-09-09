/**
 * OYLIK ZAYAVKALARI — o'qituvchi/xodim o'zi uchun TOIFA o'zgartirish yoki
 * USTAMA haq so'raydi (hujjat biriktirib). Admin ko'rib chiqadi.
 *
 * Request→approve naqshi `attendance.service.js` dagi ExcuseRequest bilan bir
 * xil (ReviewStatus + reviewedBy + rejectionReason + attachments). Farqi —
 * TASDIQ oylikka TA'SIR QILADI:
 *   kind=category → user.salaryCategoryId almashadi (keyingi generatsiyada KPI
 *                   yangi toifa stavkasidan hisoblanadi)
 *   kind=bonus    → PayrollBonus yaratiladi (tasdiqlangan ustama)
 * Har ikkala amal PayrollAudit ga yoziladi.
 */

const prisma = require("../config/prisma");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");
const { parseAmount, formatAmount } = require("../helpers/money.helpers");
const {
  parseMonthKey,
  formatMonthKey,
  currentMonthKey,
} = require("../helpers/month.helpers");
const { formatDateTimeUz } = require("../helpers/date.helpers");
const {
  uploadPenaltyAttachments,
  deletePenaltyAttachments,
} = require("./file.service");
const payrollAudit = require("./payrollAudit.service");

const KINDS = ["category", "bonus"];
const BONUS_TYPES = ["fixed", "percent"];

const fullName = (u) =>
  u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || "—" : "—";

// ── Serializatsiya ──────────────────────────
const serialize = (row, { staff, category, reviewer } = {}) => ({
  id: row.id,
  staffId: row.staffId,
  staffName: fullName(staff),
  kind: row.kind,
  status: row.status,
  reason: row.reason ?? "",

  requestedCategoryId: row.requestedCategoryId ?? null,
  requestedCategoryName: category?.name ?? null,

  bonusLabel: row.bonusLabel ?? null,
  bonusType: row.bonusType ?? null,
  bonusValue: row.bonusValue != null ? formatAmount(row.bonusValue) : null,
  bonusStartMonth: row.bonusStartMonth ?? null,
  bonusStartMonthLabel: row.bonusStartMonth ? formatMonthKey(row.bonusStartMonth) : null,
  bonusEndMonth: row.bonusEndMonth ?? null,
  bonusEndMonthLabel: row.bonusEndMonth ? formatMonthKey(row.bonusEndMonth) : null,

  attachments: Array.isArray(row.attachments) ? row.attachments : [],

  reviewedBy: row.reviewedBy ?? null,
  reviewerName: reviewer ? fullName(reviewer) : null,
  reviewedAt: row.reviewedAt ?? null,
  reviewedAtLabel: row.reviewedAt ? formatDateTimeUz(row.reviewedAt) : null,
  rejectionReason: row.rejectionReason ?? null,

  createdAt: row.createdAt,
  createdAtLabel: formatDateTimeUz(row.createdAt),
});

/** Zayavkalarni bog'liq (staff, toifa, reviewer) ma'lumot bilan boyitadi. */
const attachRefs = async (rows) => {
  if (rows.length === 0) return [];
  const staffIds = new Set();
  const catIds = new Set();
  for (const r of rows) {
    staffIds.add(r.staffId);
    if (r.reviewedBy) staffIds.add(r.reviewedBy);
    if (r.requestedCategoryId) catIds.add(r.requestedCategoryId);
  }
  const [users, cats] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: [...staffIds] } },
      select: { id: true, firstName: true, lastName: true },
    }),
    catIds.size
      ? prisma.salaryCategory.findMany({
          where: { id: { in: [...catIds] } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  const userMap = new Map(users.map((u) => [u.id, u]));
  const catMap = new Map(cats.map((c) => [c.id, c]));
  return rows.map((r) =>
    serialize(r, {
      staff: userMap.get(r.staffId),
      category: r.requestedCategoryId ? catMap.get(r.requestedCategoryId) : null,
      reviewer: r.reviewedBy ? userMap.get(r.reviewedBy) : null,
    }),
  );
};

// ─────────────────────────────────────────────
// XODIM TOMONI (teacher/staff panel)
// ─────────────────────────────────────────────

/**
 * Yangi zayavka yaratadi (pending). Fayllar Spaces'ga yuklanadi.
 * @param {string} staffId
 * @param {object} data  — { kind, reason, requestedCategoryId, bonusLabel, bonusType, bonusValue, bonusStartMonth, bonusEndMonth }
 * @param {Array} files  — Multer fayl massivi (ixtiyoriy)
 */
const submitRequest = async (staffId, data, files = []) => {
  const staff = await prisma.user.findUnique({
    where: { id: staffId },
    select: { id: true, role: true, salaryCategoryId: true },
  });
  if (!staff) throw new NotFoundError("Xodim topilmadi");
  if (staff.role === "student") {
    throw new BadRequestError("O'quvchi oylik zayavkasi yubora olmaydi");
  }

  const kind = String(data.kind ?? "").trim();
  if (!KINDS.includes(kind)) {
    throw new BadRequestError("Zayavka turi 'category' yoki 'bonus' bo'lishi kerak");
  }

  const payload = {
    staffId,
    kind,
    reason: data.reason ? String(data.reason).trim() : null,
    status: "pending",
  };

  if (kind === "category") {
    const categoryId = String(data.requestedCategoryId ?? "").trim();
    if (!categoryId) throw new BadRequestError("So'ralayotgan toifa tanlanmagan");
    const cat = await prisma.salaryCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, isArchived: true },
    });
    if (!cat || cat.isArchived) throw new NotFoundError("Toifa topilmadi");
    if (cat.id === staff.salaryCategoryId) {
      throw new BadRequestError("Siz allaqachon shu toifadasiz");
    }
    payload.requestedCategoryId = categoryId;
  } else {
    // bonus
    const bonusType = String(data.bonusType ?? "fixed").trim();
    if (!BONUS_TYPES.includes(bonusType)) {
      throw new BadRequestError("Ustama turi 'fixed' yoki 'percent' bo'lishi kerak");
    }
    const value = parseAmount(data.bonusValue ?? 0, "Ustama qiymati");
    if (!(Number(value) > 0)) throw new BadRequestError("Ustama qiymati 0 dan katta bo'lishi kerak");
    payload.bonusLabel = data.bonusLabel ? String(data.bonusLabel).trim() : "Ustama";
    payload.bonusType = bonusType;
    payload.bonusValue = value;
    payload.bonusStartMonth = data.bonusStartMonth
      ? parseMonthKey(data.bonusStartMonth, "Boshlanish oyi")
      : null;
    payload.bonusEndMonth = data.bonusEndMonth
      ? parseMonthKey(data.bonusEndMonth, "Tugash oyi")
      : null;
    if (
      payload.bonusStartMonth &&
      payload.bonusEndMonth &&
      payload.bonusEndMonth < payload.bonusStartMonth
    ) {
      throw new BadRequestError("Tugash oyi boshlanish oyidan oldin bo'lishi mumkin emas");
    }
  }

  // Fayllarni yuklash (xatolik bo'lsa fayllar avtomatik tozalanadi)
  const attachments = await uploadPenaltyAttachments(files);
  payload.attachments = attachments;

  try {
    const row = await prisma.payrollRequest.create({ data: payload });
    const [result] = await attachRefs([row]);
    return result;
  } catch (error) {
    // Zayavka yozilmasa yuklangan fayllarni tashlab ketmaymiz
    await deletePenaltyAttachments(attachments);
    throw error;
  }
};

/** Xodimning o'z zayavkalari (eng yangisi birinchi). */
const getMyRequests = async (staffId, query = {}) => {
  const where = { staffId };
  if (query.status && ["pending", "approved", "rejected"].includes(query.status)) {
    where.status = query.status;
  }
  const rows = await prisma.payrollRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
  return attachRefs(rows);
};

/** Xodim o'z pending zayavkasini bekor qiladi (o'chiradi). */
const cancelRequest = async (id, staffId) => {
  const row = await prisma.payrollRequest.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Zayavka topilmadi");
  if (row.staffId !== staffId) throw new ForbiddenError("Bu zayavka sizga tegishli emas");
  if (row.status !== "pending") {
    throw new BadRequestError("Ko'rib chiqilgan zayavkani bekor qilib bo'lmaydi");
  }
  await deletePenaltyAttachments(Array.isArray(row.attachments) ? row.attachments : []);
  await prisma.payrollRequest.delete({ where: { id } });
  return { message: "Zayavka bekor qilindi" };
};

/** O'qituvchi tanlashi mumkin bo'lgan toifalar (o'z bo'limi bo'yicha). */
const getAvailableCategories = async (staffId) => {
  const staff = await prisma.user.findUnique({
    where: { id: staffId },
    select: { salaryCategoryId: true },
  });
  // Joriy toifadan bo'lim aniqlaymiz; bo'lmasa barcha teaching toifalari
  let departmentId = null;
  if (staff?.salaryCategoryId) {
    const cur = await prisma.salaryCategory.findUnique({
      where: { id: staff.salaryCategoryId },
      select: { departmentId: true },
    });
    departmentId = cur?.departmentId ?? null;
  }
  const where = { isActive: true, isArchived: false };
  if (departmentId) where.departmentId = departmentId;

  const rows = await prisma.salaryCategory.findMany({
    where,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, perHourRate: true, baseSalary: true, departmentId: true },
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    perHourRate: formatAmount(c.perHourRate),
    baseSalary: formatAmount(c.baseSalary),
    isCurrent: c.id === staff?.salaryCategoryId,
  }));
};

// ─────────────────────────────────────────────
// ADMIN TOMONI
// ─────────────────────────────────────────────

/** Barcha zayavkalar (filtr: status, kind, staffId) + pagination. */
const getAllRequests = async (query = {}) => {
  const where = {};
  if (query.status && ["pending", "approved", "rejected"].includes(query.status)) {
    where.status = query.status;
  }
  if (query.kind && KINDS.includes(query.kind)) where.kind = query.kind;
  if (query.staffId) where.staffId = query.staffId;

  const page = parseInt(query.page, 10) || 1;
  const limit = Math.min(parseInt(query.limit, 10) || 20, 100);
  const skip = (page - 1) * limit;

  const [rows, total, pendingCount] = await Promise.all([
    prisma.payrollRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.payrollRequest.count({ where }),
    prisma.payrollRequest.count({ where: { status: "pending" } }),
  ]);

  const data = await attachRefs(rows);
  return {
    data,
    pendingCount,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPrevPage: page > 1,
    },
  };
};

/**
 * Zayavkani tasdiqlaydi yoki rad etadi.
 * approve → oylikka ta'sir (toifa biriktirish / ustama yaratish) + audit.
 * @param {string} id
 * @param {{ status: 'approved'|'rejected', rejectionReason?: string }} decision
 * @param {string} reviewerId
 */
const reviewRequest = async (id, decision, reviewerId) => {
  const status = decision.status;
  if (!["approved", "rejected"].includes(status)) {
    throw new BadRequestError("Holat 'approved' yoki 'rejected' bo'lishi kerak");
  }

  const row = await prisma.payrollRequest.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Zayavka topilmadi");
  if (row.status !== "pending") {
    throw new BadRequestError("Zayavka allaqachon ko'rib chiqilgan");
  }

  // ── Rad etish ──
  if (status === "rejected") {
    const updated = await prisma.payrollRequest.update({
      where: { id },
      data: {
        status: "rejected",
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        rejectionReason: decision.rejectionReason
          ? String(decision.rejectionReason).trim()
          : null,
      },
    });
    await payrollAudit.record({
      actorId: reviewerId,
      action: "request.reject",
      targetType: "request",
      targetId: id,
      summary: `Zayavka rad etildi${updated.rejectionReason ? ": " + updated.rejectionReason : ""}`,
    });
    const [result] = await attachRefs([updated]);
    return result;
  }

  // ── Tasdiqlash (tranzaksiyada) ──
  const staff = await prisma.user.findUnique({
    where: { id: row.staffId },
    select: { id: true, firstName: true, lastName: true, salaryCategoryId: true },
  });
  if (!staff) throw new NotFoundError("Xodim topilmadi");

  const result = await prisma.$transaction(async (tx) => {
    const now = new Date();

    if (row.kind === "category") {
      const cat = await tx.salaryCategory.findUnique({
        where: { id: row.requestedCategoryId },
        select: { id: true, name: true, isArchived: true },
      });
      if (!cat || cat.isArchived) throw new NotFoundError("So'ralgan toifa endi mavjud emas");

      const prevCatId = staff.salaryCategoryId;
      await tx.user.update({
        where: { id: staff.id },
        data: { salaryCategoryId: cat.id, positionId: null },
      });

      const updated = await tx.payrollRequest.update({
        where: { id },
        data: { status: "approved", reviewedBy: reviewerId, reviewedAt: now },
      });

      await payrollAudit.record(
        {
          actorId: reviewerId,
          action: "category.assign",
          targetType: "user",
          targetId: staff.id,
          summary: `${fullName(staff)} — toifa "${cat.name}" ga o'zgartirildi (zayavka asosida)`,
          oldValue: { salaryCategoryId: prevCatId },
          newValue: { salaryCategoryId: cat.id },
        },
        tx,
      );
      return updated;
    }

    // kind === "bonus"
    const bonus = await tx.payrollBonus.create({
      data: {
        staffId: staff.id,
        label: row.bonusLabel ?? "Ustama",
        type: row.bonusType ?? "fixed",
        value: row.bonusValue ?? 0,
        startMonth: row.bonusStartMonth ?? currentMonthKey(),
        endMonth: row.bonusEndMonth ?? null,
        sourceRequestId: id,
        isActive: true,
        createdBy: reviewerId,
      },
    });

    const updated = await tx.payrollRequest.update({
      where: { id },
      data: {
        status: "approved",
        reviewedBy: reviewerId,
        reviewedAt: now,
        resultBonusId: bonus.id,
      },
    });

    await payrollAudit.record(
      {
        actorId: reviewerId,
        action: "bonus.approve",
        targetType: "bonus",
        targetId: bonus.id,
        summary: `${fullName(staff)} — "${bonus.label}" ustamasi tasdiqlandi (${formatAmount(bonus.value)}${bonus.type === "percent" ? "%" : ""})`,
        newValue: {
          label: bonus.label,
          type: bonus.type,
          value: formatAmount(bonus.value),
          startMonth: bonus.startMonth,
          endMonth: bonus.endMonth,
        },
      },
      tx,
    );
    return updated;
  });

  const [serialized] = await attachRefs([result]);
  return serialized;
};

module.exports = {
  KINDS,
  BONUS_TYPES,
  submitRequest,
  getMyRequests,
  cancelRequest,
  getAvailableCategories,
  getAllRequests,
  reviewRequest,
};
