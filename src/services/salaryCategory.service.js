/**
 * MALAKA TOIFASI KATALOGI — soatlik KPI stavkasi (sozlamalar).
 *
 * Har toifa (Mutaxassis, 2/1-malaka, Oliy malaka) o'z soat narxiga ega.
 * Xodim oyligiga toifa biriktiriladi; KPI = jami dars soati × toifa stavkasi.
 * Stavka payroll generatsiyasida MUHRLANADI — keyin o'zgarsa o'tgan oyга tegmaydi
 * (tarif katalogi doktrinasi).
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { parseAmount, formatAmount } = require("../helpers/money.helpers");

const serialize = (row, { usageCount } = {}) => ({
  ...row,
  perHourRate: formatAmount(row.perHourRate),
  ...(usageCount != null ? { usageCount } : {}),
});

/** Toifalar ro'yxati (status bo'yicha) + biriktirilgan oylik soni. */
const getCategories = async (query = {}) => {
  const status = query.status;
  const where = {};
  if (status === "active") Object.assign(where, { isArchived: false, isActive: true });
  else if (status === "inactive") Object.assign(where, { isArchived: false, isActive: false });
  else if (status === "archived") where.isArchived = true;
  else where.isArchived = false; // default — arxivlanmaganlar

  const rows = await prisma.salaryCategory.findMany({
    where,
    orderBy: [{ perHourRate: "asc" }, { name: "asc" }],
  });

  // Har toifaga nechta oylik qoidasi biriktirilgan
  const counts = await prisma.staffSalary.groupBy({
    by: ["categoryId"],
    where: { categoryId: { in: rows.map((r) => r.id) } },
    _count: { _all: true },
  });
  const countMap = new Map(counts.map((c) => [c.categoryId, c._count._all]));

  return rows.map((row) => serialize(row, { usageCount: countMap.get(row.id) ?? 0 }));
};

/** Faol toifalar (select uchun). */
const getActiveCategories = async () => {
  const rows = await prisma.salaryCategory.findMany({
    where: { isArchived: false, isActive: true },
    orderBy: [{ perHourRate: "asc" }, { name: "asc" }],
  });
  return rows.map((row) => serialize(row));
};

const getById = async (id) => {
  const row = await prisma.salaryCategory.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Toifa topilmadi");
  return serialize(row);
};

const createCategory = async (data, userId) => {
  const name = String(data.name ?? "").trim();
  if (!name) throw new BadRequestError("Toifa nomi majburiy");

  const perHourRate = parseAmount(data.perHourRate ?? 0, "Soat narxi");
  if (perHourRate.lessThanOrEqualTo(0)) {
    throw new BadRequestError("Soat narxi noldan katta bo'lishi kerak");
  }

  try {
    const row = await prisma.salaryCategory.create({
      data: {
        name,
        perHourRate,
        description: String(data.description ?? "").trim(),
        isActive: data.isActive !== false,
        createdBy: userId,
      },
    });
    return serialize(row, { usageCount: 0 });
  } catch (error) {
    if (error?.code === "P2002") throw new BadRequestError("Bu nomli toifa allaqachon bor");
    throw error;
  }
};

const updateCategory = async (id, data) => {
  const row = await prisma.salaryCategory.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Toifa topilmadi");

  const payload = {};
  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw new BadRequestError("Toifa nomi majburiy");
    payload.name = name;
  }
  if (data.perHourRate !== undefined) {
    const rate = parseAmount(data.perHourRate, "Soat narxi");
    if (rate.lessThanOrEqualTo(0)) {
      throw new BadRequestError("Soat narxi noldan katta bo'lishi kerak");
    }
    payload.perHourRate = rate;
  }
  if (data.description !== undefined) payload.description = String(data.description).trim();
  if (data.isActive !== undefined) payload.isActive = Boolean(data.isActive);

  try {
    const updated = await prisma.salaryCategory.update({ where: { id }, data: payload });
    return serialize(updated);
  } catch (error) {
    if (error?.code === "P2002") throw new BadRequestError("Bu nomli toifa allaqachon bor");
    throw error;
  }
};

/** Arxivlash/qaytarish — o'chirish o'rniga (oyliklar unga ishora qiladi). */
const archiveCategory = async (id, isArchived) => {
  const row = await prisma.salaryCategory.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Toifa topilmadi");

  const updated = await prisma.salaryCategory.update({
    where: { id },
    data: {
      isArchived: Boolean(isArchived),
      archivedAt: isArchived ? new Date() : null,
    },
  });
  return serialize(updated);
};

/** O'chirish — faqat hech qanday oylik unga biriktirilmagan bo'lsa. */
const deleteCategory = async (id) => {
  const row = await prisma.salaryCategory.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Toifa topilmadi");

  const used = await prisma.staffSalary.count({ where: { categoryId: id } });
  if (used > 0) {
    throw new BadRequestError(
      `Bu toifa ${used} ta oylik qoidasiga biriktirilgan — o'chirib bo'lmaydi. Arxivlang.`,
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
