/**
 * BO'LIMLAR — oylik strukturasining tashkiliy o'lchovi.
 *   staff    → Texnik, Boshqaruv (maosh LAVOZIMga)
 *   teaching → MTB, Boshlang'ich, Yuqori (maosh TOIFAga, soatbay)
 *
 * ⚠️ Bu qatlam StaffSalary oylik-hisobidan ALOHIDA (coexist): faqat tashkiliy
 * struktura va hisoblangan oylik ko'rinishi.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");

const KINDS = ["staff", "teaching"];

const serialize = (row, counts = {}) => ({
  ...row,
  positionCount: counts.positions ?? undefined,
  categoryCount: counts.categories ?? undefined,
  staffCount: counts.staff ?? undefined,
});

/** Bo'limlar ro'yxati (kind bo'yicha) + sanoqlar. */
const getDepartments = async (query = {}) => {
  const where = {};
  if (query.kind && KINDS.includes(query.kind)) where.kind = query.kind;
  if (query.activeOnly === "true") where.isActive = true;

  const rows = await prisma.department.findMany({
    where,
    orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    include: {
      _count: { select: { positions: true, categories: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    positionCount: row._count.positions,
    categoryCount: row._count.categories,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
};

const getById = async (id) => {
  const row = await prisma.department.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Bo'lim topilmadi");
  return serialize(row);
};

const createDepartment = async (data, userId) => {
  const name = String(data.name ?? "").trim();
  if (!name) throw new BadRequestError("Bo'lim nomi majburiy");
  if (!KINDS.includes(data.kind)) {
    throw new BadRequestError("Bo'lim turi 'staff' yoki 'teaching' bo'lishi kerak");
  }

  try {
    const row = await prisma.department.create({
      data: {
        name,
        kind: data.kind,
        sortOrder: Number(data.sortOrder) || 0,
        isActive: data.isActive !== false,
        createdBy: userId,
      },
    });
    return serialize(row);
  } catch (error) {
    if (error?.code === "P2002") throw new BadRequestError("Bu nomli bo'lim allaqachon bor");
    throw error;
  }
};

const updateDepartment = async (id, data) => {
  const row = await prisma.department.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Bo'lim topilmadi");

  const payload = {};
  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw new BadRequestError("Bo'lim nomi majburiy");
    payload.name = name;
  }
  if (data.sortOrder !== undefined) payload.sortOrder = Number(data.sortOrder) || 0;
  if (data.isActive !== undefined) payload.isActive = Boolean(data.isActive);
  // `kind` o'zgartirilmaydi — lavozim/toifalar unga bog'langan

  try {
    const updated = await prisma.department.update({ where: { id }, data: payload });
    return serialize(updated);
  } catch (error) {
    if (error?.code === "P2002") throw new BadRequestError("Bu nomli bo'lim allaqachon bor");
    throw error;
  }
};

const deleteDepartment = async (id) => {
  const row = await prisma.department.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Bo'lim topilmadi");

  const [positions, categories] = await Promise.all([
    prisma.position.count({ where: { departmentId: id } }),
    prisma.salaryCategory.count({ where: { departmentId: id } }),
  ]);
  if (positions > 0 || categories > 0) {
    throw new BadRequestError(
      "Bu bo'limda lavozim yoki toifa bor — avval ularni o'chiring yoki nofaol qiling.",
    );
  }

  await prisma.department.delete({ where: { id } });
  return { message: "Bo'lim o'chirildi" };
};

/**
 * Xodimni LAVOZIM (staff) yoki TOIFA (teacher) ga biriktiradi.
 * Ikkalasidan faqat bittasi bo'ladi (biri o'rnatilsa ikkinchisi tozalanadi).
 */
const assignStaff = async (staffId, data) => {
  const staff = await prisma.user.findUnique({
    where: { id: staffId },
    select: { id: true, role: true, positionId: true, salaryCategoryId: true },
  });
  if (!staff) throw new NotFoundError("Xodim topilmadi");
  if (staff.role === "student") throw new BadRequestError("O'quvchiga oylik biriktirilmaydi");

  const payload = {};

  if (data.positionId !== undefined) {
    if (data.positionId) {
      const pos = await prisma.position.findUnique({ where: { id: data.positionId } });
      if (!pos) throw new NotFoundError("Lavozim topilmadi");
      payload.positionId = data.positionId;
      payload.salaryCategoryId = null; // lavozim va toifa birga bo'lmaydi
    } else {
      payload.positionId = null;
    }
  }

  if (data.salaryCategoryId !== undefined) {
    if (data.salaryCategoryId) {
      const cat = await prisma.salaryCategory.findUnique({ where: { id: data.salaryCategoryId } });
      if (!cat) throw new NotFoundError("Toifa topilmadi");
      payload.salaryCategoryId = data.salaryCategoryId;
      payload.positionId = null;
    } else {
      payload.salaryCategoryId = null;
    }
  }

  return prisma.user.update({
    where: { id: staffId },
    data: payload,
    select: { id: true, firstName: true, lastName: true, positionId: true, salaryCategoryId: true },
  });
};

module.exports = {
  KINDS,
  getDepartments,
  getById,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  assignStaff,
};
