const platformPrisma = require("../config/platformPrisma");
const logger = require("./logger");

/**
 * Default tizim rollarini yaratadi (agar mavjud bo'lmasa).
 * Mavjud rollarni o'zgartirmaydi.
 *
 * ROLLAR PLATFORMADA — barcha filiallarga umumiy. `User.role` filial
 * schema'sidagi oddiy String (FK emas), shuning uchun rollar ro'yxati bir
 * marta, markazda yuritiladi.
 *
 * `createdBy` — owner'ning ID'si; owner hali yaratilmagan bo'lsa (birinchi
 * ishga tushish) `null` qoladi. Avval rollar, keyin owner: `initOwner` yangi
 * foydalanuvchiga rolning boshlang'ich ruxsatlarini beradi, ya'ni rollar
 * OLDIN bo'lishi kerak.
 *
 * @param {string|null} ownerId
 */
const initRoles = async (ownerId = null) => {
  try {
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
      const existing = await platformPrisma.role.findUnique({
        where: { value: role.value },
      });
      if (!existing) {
        await platformPrisma.role.create({
          data: { ...role, isSystem: true, createdBy: ownerId ?? "" },
        });
        created++;
      }
    }

    if (created > 0) {
      logger.info(`${created} ta default rol yaratildi (platforma)`);
    }
  } catch (error) {
    logger.error("Default rollarni yaratishda xato:", error.message);
  }
};

module.exports = initRoles;
