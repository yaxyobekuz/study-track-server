/**
 * ROLLAR — PLATFORMA darajasida, barcha filiallarga umumiy.
 *
 * `User.role` filial schema'sidagi oddiy String (FK YO'Q), shuning uchun
 * katalogni ko'chirish birorta bog'lanishni buzmadi.
 *
 * ⚠️ "Bu rolda nechta foydalanuvchi bor?" savoli endi BUTUN TIZIM bo'yicha
 * javob beradi va `UserDirectory` (platforma indeksi) orqali hisoblanadi,
 * filial bazasiga bormasdan. Bu shunchaki optimizatsiya emas, TO'G'RILIK
 * masalasi: rol umumiy bo'lgani uchun uni o'chirish "Chilonzorda bu rolda
 * hech kim yo'q" degan asosda emas, HECH BIR filialda yo'qligi asosida
 * taqiqlanishi kerak.
 */

const platformPrisma = require("../config/platformPrisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const { validatePermissions } = require("./permission.service");

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
 * Rol qiymati bo'yicha BARCHA filiallardagi foydalanuvchilar soni.
 * @param {string} value
 * @returns {Promise<number>}
 */
async function countUsersWithRole(value) {
  return platformPrisma.userDirectory.count({ where: { role: value } });
}

/**
 * Barcha rollarni foydalanuvchilar soni bilan olish.
 */
async function getAllRoles() {
  const roles = await platformPrisma.role.findMany({
    orderBy: [{ isSystem: "desc" }, { createdAt: "asc" }],
  });

  // createdBy — soft ref (FK emas). Yaratuvchi qaysi filialda ekani noma'lum,
  // shuning uchun ism yo'naltirgichdan (denormalizatsiya) o'qiladi.
  const creatorIds = [...new Set(roles.map((r) => r.createdBy).filter(Boolean))];
  const creators = creatorIds.length
    ? await platformPrisma.userDirectory.findMany({
        where: { id: { in: creatorIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const creatorMap = new Map(creators.map((c) => [c.id, c]));

  // Bitta groupBy — rol soniga qarab N ta count so'rovi EMAS.
  const counts = await platformPrisma.userDirectory.groupBy({
    by: ["role"],
    _count: { _all: true },
  });
  const countMap = new Map(counts.map((c) => [c.role, c._count._all]));

  return roles.map((role) => ({
    ...role,
    createdBy: creatorMap.get(role.createdBy) || null,
    usersCount: countMap.get(role.value) ?? 0,
  }));
}

/**
 * Select/dropdown uchun rol variantlarini olish.
 */
async function getRoleOptions() {
  return platformPrisma.role.findMany({
    select: { id: true, name: true, value: true, isSystem: true },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });
}

/**
 * Yangi rol yaratish.
 */
async function createRole(data, createdBy) {
  const { name, value, permissions } = data;

  if (!name || !value) {
    throw new BadRequestError("Rol nomi va qiymati majburiy");
  }

  try {
    return await platformPrisma.role.create({
      data: {
        name,
        value: value.toLowerCase().trim(),
        createdBy,
        ...(permissions !== undefined && {
          permissions: validatePermissions(permissions),
        }),
      },
    });
  } catch (error) {
    handleUnique(error);
  }
}

/**
 * Rolni yangilash. Tizim rollari yangilanmaydi.
 */
async function updateRole(id, data) {
  const {
    name,
    value,
    permissions,
    workStartTime,
    workEndTime,
    workDays,
    weeklySchedule,
  } = data;

  const role = await platformPrisma.role.findUnique({ where: { id } });

  if (!role) {
    throw new NotFoundError("Rol topilmadi");
  }

  const update = {};

  // Tizim rollarining nomi va kaliti o'zgartirilmaydi, faqat ish vaqti sozlanadi
  if (!role.isSystem) {
    if (value && value !== role.value) {
      const usersCount = await countUsersWithRole(role.value);
      if (usersCount > 0) {
        throw new BadRequestError(
          "Bu rol qiymatini o'zgartirib bo'lmaydi, chunki foydalanuvchilar mavjud",
        );
      }
      update.value = value;
    }

    if (name) update.name = name;
  }

  // Boshlang'ich ruxsatlar tizim rollari uchun ham sozlanadi — bu nom/kalitdan
  // farqli o'laroq faqat yangi foydalanuvchilarga ta'sir qiladi
  if (permissions !== undefined) update.permissions = validatePermissions(permissions);

  if (workStartTime !== undefined) update.workStartTime = workStartTime || null;
  if (workEndTime !== undefined) update.workEndTime = workEndTime || null;
  if (workDays !== undefined) update.workDays = workDays || [1, 2, 3, 4, 5];
  if (weeklySchedule !== undefined) update.weeklySchedule = weeklySchedule || {};

  try {
    return await platformPrisma.role.update({ where: { id }, data: update });
  } catch (error) {
    handleUnique(error);
  }
}

/**
 * Rolni o'chirish. Tizim rollari va foydalanuvchilari bor rollar o'chirilmaydi.
 */
async function deleteRole(id) {
  const role = await platformPrisma.role.findUnique({ where: { id } });

  if (!role) {
    throw new NotFoundError("Rol topilmadi");
  }

  if (role.isSystem) {
    throw new BadRequestError("Tizim rollarini o'chirib bo'lmaydi");
  }

  const usersCount = await countUsersWithRole(role.value);
  if (usersCount > 0) {
    throw new BadRequestError(
      `Bu rolni o'chirib bo'lmaydi, chunki ${usersCount} ta foydalanuvchi mavjud ` +
        `(barcha filiallar bo'yicha)`,
    );
  }

  await platformPrisma.role.delete({ where: { id } });
}

module.exports = {
  getAllRoles,
  getRoleOptions,
  createRole,
  updateRole,
  deleteRole,
  countUsersWithRole,
};
