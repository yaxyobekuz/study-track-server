const prisma = require("../config/prisma");
const logger = require("./logger");

/**
 * Default tizim rollarini yaratadi (agar mavjud bo'lmasa)
 * Mavjud rollarni o'zgartirmaydi
 */
const initRoles = async () => {
  try {
    const owner = await prisma.user.findFirst({ where: { role: "owner" } });

    if (!owner) {
      logger.error("Owner topilmadi. Default rollarni yaratib bo'lmaydi.");
      return;
    }

    const defaultRoles = [
      { name: "Ega", value: "owner" },
      { name: "O'qituvchi", value: "teacher" },
      { name: "O'quvchi", value: "student" },
      { name: "Dasturchi", value: "developer" },
      { name: "Qabulxona", value: "reception" },
    ];

    let created = 0;
    for (const role of defaultRoles) {
      // $setOnInsert semantikasi: mavjud bo'lsa o'zgartirmaydi
      const existing = await prisma.role.findUnique({ where: { value: role.value } });
      if (!existing) {
        await prisma.role.create({
          data: { ...role, isSystem: true, createdBy: owner.id },
        });
        created++;
      }
    }

    if (created > 0) {
      logger.info(`${created} ta default rol yaratildi`);
    }
  } catch (error) {
    logger.error("Default rollarni yaratishda xato:", error.message);
  }
};

module.exports = initRoles;
