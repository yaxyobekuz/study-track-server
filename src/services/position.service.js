/**
 * LAVOZIMLAR — maosh XODIMGA emas, LAVOZIMGA biriktiriladi.
 * Lavozim maoshi o'zgarsa, keyingi payroll generatsiyasida shu lavozimdagi
 * barcha xodimlar yangi bazani oladi (joriy qiymat MUHRLANADI).
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { parseAmount, formatAmount } = require("../helpers/money.helpers");
const payrollAudit = require("./payrollAudit.service");

const serialize = (row, { staffCount, department } = {}) => ({
  id: row.id,
  departmentId: row.departmentId,
  departmentName: department?.name ?? row.department?.name ?? null,
  name: row.name,
  baseSalary: formatAmount(row.baseSalary),
  sortOrder: row.sortOrder,
  isActive: row.isActive,
  ...(staffCount != null ? { staffCount } : {}),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const assertStaffDepartment = async (departmentId) => {
  const dept = await prisma.department.findUnique({ where: { id: departmentId } });
  if (!dept) throw new NotFoundError("Bo'lim topilmadi");
  if (dept.kind !== "staff") {
    throw new BadRequestError("Lavozim faqat 'staff' turidagi bo'limga qo'shiladi");
  }
  return dept;
};

/** Bo'lim lavozimlari + har biriga biriktirilgan xodimlar soni. */
const getPositions = async (query = {}) => {
  const where = {};
  if (query.departmentId) where.departmentId = query.departmentId;
  if (query.activeOnly === "true") where.isActive = true;

  const rows = await prisma.position.findMany({
    where,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { department: { select: { name: true } } },
  });

  if (rows.length === 0) return [];

  const counts = await prisma.user.groupBy({
    by: ["positionId"],
    where: { positionId: { in: rows.map((r) => r.id) }, isArchived: false },
    _count: { _all: true },
  });
  const countMap = new Map(counts.map((c) => [c.positionId, c._count._all]));

  return rows.map((row) => serialize(row, { staffCount: countMap.get(row.id) ?? 0 }));
};

const getById = async (id) => {
  const row = await prisma.position.findUnique({
    where: { id },
    include: { department: { select: { name: true } } },
  });
  if (!row) throw new NotFoundError("Lavozim topilmadi");
  return serialize(row);
};

const createPosition = async (data, userId) => {
  const name = String(data.name ?? "").trim();
  if (!name) throw new BadRequestError("Lavozim nomi majburiy");
  await assertStaffDepartment(data.departmentId);

  const baseSalary = parseAmount(data.baseSalary ?? 0, "Bazaviy maosh");

  try {
    const row = await prisma.position.create({
      data: {
        departmentId: data.departmentId,
        name,
        baseSalary,
        sortOrder: Number(data.sortOrder) || 0,
        isActive: data.isActive !== false,
        createdBy: userId,
      },
      include: { department: { select: { name: true } } },
    });
    return serialize(row, { staffCount: 0 });
  } catch (error) {
    if (error?.code === "P2002") {
      throw new BadRequestError("Bu bo'limda shu nomli lavozim allaqachon bor");
    }
    throw error;
  }
};

const updatePosition = async (id, data, actorId) => {
  const row = await prisma.position.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Lavozim topilmadi");

  const payload = {};
  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw new BadRequestError("Lavozim nomi majburiy");
    payload.name = name;
  }
  if (data.baseSalary !== undefined) {
    payload.baseSalary = parseAmount(data.baseSalary, "Bazaviy maosh");
  }
  if (data.sortOrder !== undefined) payload.sortOrder = Number(data.sortOrder) || 0;
  if (data.isActive !== undefined) payload.isActive = Boolean(data.isActive);

  try {
    const updated = await prisma.position.update({
      where: { id },
      data: payload,
      include: { department: { select: { name: true } } },
    });

    // Bazaviy maosh o'zgarsa — audit (shu lavozimdagi barcha xodim ta'sirlanadi)
    const oldBase = formatAmount(row.baseSalary);
    const newBase = formatAmount(updated.baseSalary);
    if (actorId && oldBase !== newBase) {
      await payrollAudit.record({
        actorId,
        action: "position.update",
        targetType: "position",
        targetId: id,
        summary: `"${updated.name}" lavozimi bazaviy maoshi: ${oldBase} → ${newBase}`,
        oldValue: { baseSalary: oldBase },
        newValue: { baseSalary: newBase },
      });
    }
    return serialize(updated);
  } catch (error) {
    if (error?.code === "P2002") {
      throw new BadRequestError("Bu bo'limda shu nomli lavozim allaqachon bor");
    }
    throw error;
  }
};

const deletePosition = async (id) => {
  const row = await prisma.position.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Lavozim topilmadi");

  const used = await prisma.user.count({ where: { positionId: id } });
  if (used > 0) {
    throw new BadRequestError(
      `Bu lavozimga ${used} ta xodim biriktirilgan — avval ularni ko'chiring yoki nofaol qiling.`,
    );
  }

  await prisma.position.delete({ where: { id } });
  return { message: "Lavozim o'chirildi" };
};

module.exports = {
  getPositions,
  getById,
  createPosition,
  updatePosition,
  deletePosition,
};
