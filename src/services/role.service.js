const Role = require("../models/role.model");
const User = require("../models/user.model");
const { BadRequestError, NotFoundError } = require("../utils/errors");

/**
 * Barcha rollarni foydalanuvchilar soni bilan olish.
 * @returns {Promise<Array>} rollar ro'yxati (usersCount bilan)
 */
async function getAllRoles() {
  const roles = await Role.find()
    .populate("createdBy", "firstName lastName")
    .sort({ isSystem: -1, createdAt: 1 })
    .lean();

  const rolesWithCounts = await Promise.all(
    roles.map(async (role) => {
      const usersCount = await User.countDocuments({ role: role.value });
      return { ...role, usersCount };
    }),
  );

  return rolesWithCounts;
}

/**
 * Select/dropdown uchun rol variantlarini olish.
 * @returns {Promise<Array>} rol variantlari
 */
async function getRoleOptions() {
  const roles = await Role.find()
    .select("name value isSystem")
    .sort({ isSystem: -1, name: 1 })
    .lean();

  return roles;
}

/**
 * Yangi rol yaratish.
 * @param {object} data - rol ma'lumotlari
 * @param {string} data.name - rol nomi
 * @param {string} data.value - rol qiymati
 * @param {string} createdBy - yaratuvchi foydalanuvchi ID
 * @returns {Promise<object>} yaratilgan rol
 */
async function createRole(data, createdBy) {
  const { name, value } = data;

  if (!name || !value) {
    throw new BadRequestError("Rol nomi va qiymati majburiy");
  }

  try {
    const role = await Role.create({
      name,
      value,
      createdBy,
    });

    return role;
  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      const message =
        field === "value"
          ? "Bu rol qiymati allaqachon mavjud"
          : "Bu rol nomi allaqachon mavjud";
      throw new BadRequestError(message);
    }
    throw error;
  }
}

/**
 * Rolni yangilash. Tizim rollari yangilanmaydi.
 * @param {string} id - rol ID
 * @param {object} data - yangilash ma'lumotlari
 * @param {string} [data.name] - rol nomi
 * @param {string} [data.value] - rol qiymati
 * @returns {Promise<object>} yangilangan rol
 */
async function updateRole(id, data) {
  const { name, value } = data;

  const role = await Role.findById(id);

  if (!role) {
    throw new NotFoundError("Rol topilmadi");
  }

  if (role.isSystem) {
    throw new BadRequestError("Tizim rollarini o'zgartirib bo'lmaydi");
  }

  if (value && value !== role.value) {
    const usersCount = await User.countDocuments({ role: role.value });
    if (usersCount > 0) {
      throw new BadRequestError(
        "Bu rol qiymatini o'zgartirib bo'lmaydi, chunki foydalanuvchilar mavjud",
      );
    }
    role.value = value;
  }

  if (name) role.name = name;

  try {
    await role.save();
  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      const message =
        field === "value"
          ? "Bu rol qiymati allaqachon mavjud"
          : "Bu rol nomi allaqachon mavjud";
      throw new BadRequestError(message);
    }
    throw error;
  }

  return role;
}

/**
 * Rolni o'chirish. Tizim rollari va foydalanuvchilari bor rollar o'chirilmaydi.
 * @param {string} id - rol ID
 * @returns {Promise<void>}
 */
async function deleteRole(id) {
  const role = await Role.findById(id);

  if (!role) {
    throw new NotFoundError("Rol topilmadi");
  }

  if (role.isSystem) {
    throw new BadRequestError("Tizim rollarini o'chirib bo'lmaydi");
  }

  const usersCount = await User.countDocuments({ role: role.value });
  if (usersCount > 0) {
    throw new BadRequestError(
      `Bu rolni o'chirib bo'lmaydi, chunki ${usersCount} ta foydalanuvchi mavjud`,
    );
  }

  await role.deleteOne();
}

module.exports = {
  getAllRoles,
  getRoleOptions,
  createRole,
  updateRole,
  deleteRole,
};
