const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");

// Prisma unique-constraint xatosini do'stona xabarga aylantiradi
function handleUnique(error) {
  if (error.code === "P2002") {
    const target = Array.isArray(error.meta?.target) ? error.meta.target : [];
    const message = target.includes("value")
      ? "Bu rol qiymati allaqachon mavjud"
      : "Bu rol nomi allaqachon mavjud";
    throw new BadRequestError(message);
  }
  throw error;
}

/**
 * Barcha rollarni foydalanuvchilar soni bilan olish.
 */
async function getAllRoles() {
  const roles = await prisma.role.findMany({
    orderBy: [{ isSystem: "desc" }, { createdAt: "asc" }],
  });

  // createdBy — soft ref (FK emas), qo'lda yuklaymiz
  const creatorIds = [...new Set(roles.map((r) => r.createdBy).filter(Boolean))];
  const creators = await prisma.user.findMany({
    where: { id: { in: creatorIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const creatorMap = new Map(creators.map((c) => [c.id, c]));

  const rolesWithCounts = await Promise.all(
    roles.map(async (role) => {
      const usersCount = await prisma.user.count({ where: { role: role.value } });
      return { ...role, createdBy: creatorMap.get(role.createdBy) || null, usersCount };
    }),
  );

  return rolesWithCounts;
}

/**
 * Select/dropdown uchun rol variantlarini olish.
 */
async function getRoleOptions() {
  return prisma.role.findMany({
    select: { id: true, name: true, value: true, isSystem: true },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });
}

/**
 * Yangi rol yaratish.
 */
async function createRole(data, createdBy) {
  const { name, value } = data;

  if (!name || !value) {
    throw new BadRequestError("Rol nomi va qiymati majburiy");
  }

  try {
    return await prisma.role.create({
      data: { name, value: value.toLowerCase().trim(), createdBy },
    });
  } catch (error) {
    handleUnique(error);
  }
}

/**
 * Rolni yangilash. Tizim rollari yangilanmaydi.
 */
async function updateRole(id, data) {
  const { name, value, workStartTime, workEndTime, workDays, weeklySchedule } = data;

  const role = await prisma.role.findUnique({ where: { id } });

  if (!role) {
    throw new NotFoundError("Rol topilmadi");
  }

  const update = {};

  // Tizim rollarining nomi va kaliti o'zgartirilmaydi, faqat ish vaqti sozlanadi
  if (!role.isSystem) {
    if (value && value !== role.value) {
      const usersCount = await prisma.user.count({ where: { role: role.value } });
      if (usersCount > 0) {
        throw new BadRequestError(
          "Bu rol qiymatini o'zgartirib bo'lmaydi, chunki foydalanuvchilar mavjud",
        );
      }
      update.value = value;
    }

    if (name) update.name = name;
  }

  if (workStartTime !== undefined) update.workStartTime = workStartTime || null;
  if (workEndTime !== undefined) update.workEndTime = workEndTime || null;
  if (workDays !== undefined) update.workDays = workDays || [1, 2, 3, 4, 5];
  if (weeklySchedule !== undefined) update.weeklySchedule = weeklySchedule || {};

  try {
    return await prisma.role.update({ where: { id }, data: update });
  } catch (error) {
    handleUnique(error);
  }
}

/**
 * Rolni o'chirish. Tizim rollari va foydalanuvchilari bor rollar o'chirilmaydi.
 */
async function deleteRole(id) {
  const role = await prisma.role.findUnique({ where: { id } });

  if (!role) {
    throw new NotFoundError("Rol topilmadi");
  }

  if (role.isSystem) {
    throw new BadRequestError("Tizim rollarini o'chirib bo'lmaydi");
  }

  const usersCount = await prisma.user.count({ where: { role: role.value } });
  if (usersCount > 0) {
    throw new BadRequestError(
      `Bu rolni o'chirib bo'lmaydi, chunki ${usersCount} ta foydalanuvchi mavjud`,
    );
  }

  await prisma.role.delete({ where: { id } });
}

module.exports = {
  getAllRoles,
  getRoleOptions,
  createRole,
  updateRole,
  deleteRole,
};
