const Role = require("../models/role.model");
const User = require("../models/user.model");
const logger = require("./logger");

/**
 * Default tizim rollarini yaratadi (agar mavjud bo'lmasa)
 * Mavjud rollarni o'zgartirmaydi
 */
const initRoles = async () => {
  try {
    const owner = await User.findOne({ role: "owner" });

    if (!owner) {
      logger.error("Owner topilmadi. Default rollarni yaratib bo'lmaydi.");
      return;
    }

    const defaultRoles = [
      { name: "Ega", value: "owner" },
      {
        name: "O'qituvchi",
        value: "teacher",
      },
      {
        name: "O'quvchi",
        value: "student",
      },
      {
        name: "Dasturchi",
        value: "developer",
      },
      {
        name: "Qabulxona",
        value: "reception",
      },
    ];

    const upsertOperations = defaultRoles.map((role) => ({
      updateOne: {
        filter: { value: role.value },
        update: {
          $setOnInsert: {
            ...role,
            isSystem: true,
            createdBy: owner._id,
          },
        },
        upsert: true,
      },
    }));

    const result = await Role.bulkWrite(upsertOperations);

    if (result.upsertedCount > 0) {
      logger.info(`${result.upsertedCount} ta default rol yaratildi`);
    }
  } catch (error) {
    logger.error("Default rollarni yaratishda xato:", error.message);
  }
};

module.exports = initRoles;
