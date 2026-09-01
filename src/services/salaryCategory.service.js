/**
 * MALAKA TOIFASI KATALOGI — teaching BO'LIMGA bog'langan soatbay maosh jadvali.
 *
 * Har teaching bo'lim (MTB / Boshlang'ich / Yuqori) o'z toifalariga ega
 * (O'rta maxsus, 2-toifa, 1-toifa, Oliy toifa) va har toifada:
 *   perHourRate    — bir soat uchun
 *   monthlyPerHour — bir oy uchun
 *   hoursPerStavka — bir stavka uchun dars soati
 *   baseSalary     — asosiy maosh (to'liq stavka)
 *
 * O'qituvchi toifaga biriktiriladi (User.salaryCategoryId); KPI = perHourRate ×
 * o'tilgan dars soati. Stavka payroll generatsiyasida MUHRLANADI (o'zgarsa
 * o'tgan oyга tegmaydi).
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { parseAmount, formatAmount } = require("../helpers/money.helpers");

const serialize = (row, { usageCount, department } = {}) => ({
  id: row.id,
  departmentId: row.departmentId,
  departmentName: department?.name ?? row.department?.name ?? null,
  name: row.name,
  perHourRate: formatAmount(row.perHourRate),
  monthlyPerHour: formatAmount(row.monthlyPerHour),
  hoursPerStavka: row.hoursPerStavka,
  baseSalary: formatAmount(row.baseSalary),
  description: row.description,
  sortOrder: row.sortOrder,
  isActive: row.isActive,
  isArchived: row.isArchived,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  ...(usageCount != null ? { usageCount } : {}),
});

const statusWhere = (status) => {
  if (status === "active") return { isArchived: false, isActive: true };
  if (status === "inactive") return { isArchived: false, isActive: false };
  if (status === "archived") return { isArchived: true };
  return { isArchived: false };
};

/** O'qituvchilar soni (User.salaryCategoryId bo'yicha). */
const usageCounts = async (ids) => {
  if (!ids.length) return new Map();
  const counts = await prisma.user.groupBy({
    by: ["salaryCategoryId"],
    where: { salaryCategoryId: { in: ids }, isArchived: false },
    _count: { _all: true },
  });
  return new Map(counts.map((c) => [c.salaryCategoryId, c._count._all]));
};

/** Toifalar ro'yxati (bo'lim + status bo'yicha) + o'qituvchilar soni. */
const getCategories = async (query = {}) => {
  const where = statusWhere(query.status);
  if (query.departmentId) where.departmentId = query.departmentId;

  const rows = await prisma.salaryCategory.findMany({
    where,
    orderBy: [{ sortOrder: "asc" }, { baseSalary: "asc" }, { name: "asc" }],
    include: { department: { select: { name: true } } },
  });

  const countMap = await usageCounts(rows.map((r) => r.id));
  return rows.map((row) => serialize(row, { usageCount: countMap.get(row.id) ?? 0 }));
};

/** Faol toifalar (select uchun), ixtiyoriy bo'lim bo'yicha. */
const getActiveCategories = async (query = {}) => {
  const where = { isArchived: false, isActive: true };
  if (query.departmentId) where.departmentId = query.departmentId;
  const rows = await prisma.salaryCategory.findMany({
    where,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { department: { select: { name: true } } },
  });
  return rows.map((row) => serialize(row));
};

const getById = async (id) => {
  const row = await prisma.salaryCategory.findUnique({
    where: { id },
    include: { department: { select: { name: true } } },
  });
  if (!row) throw new NotFoundError("Toifa topilmadi");
  return serialize(row);
};

const assertTeachingDepartment = async (departmentId) => {
  if (!departmentId) return null;
  const dept = await prisma.department.findUnique({ where: { id: departmentId } });
  if (!dept) throw new NotFoundError("Bo'lim topilmadi");
  if (dept.kind !== "teaching") {
    throw new BadRequestError("Toifa faqat 'teaching' turidagi bo'limga qo'shiladi");
  }
  return dept;
};

const parseFields = (data) => {
  const payload = {};
  if (data.perHourRate !== undefined) payload.perHourRate = parseAmount(data.perHourRate, "Bir soat uchun");
  if (data.monthlyPerHour !== undefined) payload.monthlyPerHour = parseAmount(data.monthlyPerHour, "Bir oy uchun");
  if (data.baseSalary !== undefined) payload.baseSalary = parseAmount(data.baseSalary, "Asosiy maosh");
  if (data.hoursPerStavka !== undefined) {
    const h = Number(data.hoursPerStavka);
    if (!Number.isFinite(h) || h < 0) throw new BadRequestError("Dars soati noto'g'ri");
    payload.hoursPerStavka = Math.trunc(h);
  }
  if (data.description !== undefined) payload.description = String(data.description).trim();
  if (data.sortOrder !== undefined) payload.sortOrder = Number(data.sortOrder) || 0;
  if (data.isActive !== undefined) payload.isActive = Boolean(data.isActive);
  return payload;
};

const createCategory = async (data, userId) => {
  const name = String(data.name ?? "").trim();
  if (!name) throw new BadRequestError("Toifa nomi majburiy");
  const department = await assertTeachingDepartment(data.departmentId);

  const fields = parseFields(data);
  if (!fields.perHourRate || fields.perHourRate.lessThanOrEqualTo(0)) {
    throw new BadRequestError("Bir soat uchun narx noldan katta bo'lishi kerak");
  }

  try {
    const row = await prisma.salaryCategory.create({
      data: {
        name,
        departmentId: department?.id ?? null,
        ...fields,
        createdBy: userId,
      },
      include: { department: { select: { name: true } } },
    });
    return serialize(row, { usageCount: 0 });
  } catch (error) {
    if (error?.code === "P2002") throw new BadRequestError("Bu bo'limda shu nomli toifa allaqachon bor");
    throw error;
  }
};

const updateCategory = async (id, data) => {
  const row = await prisma.salaryCategory.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Toifa topilmadi");

  const payload = parseFields(data);
  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw new BadRequestError("Toifa nomi majburiy");
    payload.name = name;
  }
  if (data.departmentId !== undefined) {
    const dept = await assertTeachingDepartment(data.departmentId || null);
    payload.departmentId = dept?.id ?? null;
  }

  try {
    const updated = await prisma.salaryCategory.update({
      where: { id },
      data: payload,
      include: { department: { select: { name: true } } },
    });
    return serialize(updated);
  } catch (error) {
    if (error?.code === "P2002") throw new BadRequestError("Bu bo'limda shu nomli toifa allaqachon bor");
    throw error;
  }
};

const archiveCategory = async (id, isArchived) => {
  const row = await prisma.salaryCategory.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Toifa topilmadi");

  const updated = await prisma.salaryCategory.update({
    where: { id },
    data: { isArchived: Boolean(isArchived), archivedAt: isArchived ? new Date() : null },
    include: { department: { select: { name: true } } },
  });
  return serialize(updated);
};

/** O'chirish — faqat hech qanday o'qituvchi biriktirilmagan bo'lsa. */
const deleteCategory = async (id) => {
  const row = await prisma.salaryCategory.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Toifa topilmadi");

  const used = await prisma.user.count({ where: { salaryCategoryId: id } });
  if (used > 0) {
    throw new BadRequestError(
      `Bu toifaga ${used} ta o'qituvchi biriktirilgan — o'chirib bo'lmaydi. Arxivlang.`,
    );
  }

  await prisma.salaryCategory.delete({ where: { id } });
  return { message: "Toifa o'chirildi" };
};

/** Berilgan ID'lar uchun toifalar xaritasi (payroll generatsiyasi uchun). */
const loadCategoriesByIds = async (ids) => {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await prisma.salaryCategory.findMany({ where: { id: { in: unique } } });
  return new Map(rows.map((r) => [r.id, r]));
};

module.exports = {
  serialize,
  getCategories,
  getActiveCategories,
  getById,
  createCategory,
  updateCategory,
  archiveCategory,
  deleteCategory,
  loadCategoriesByIds,
};
