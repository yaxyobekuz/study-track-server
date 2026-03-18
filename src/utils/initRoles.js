// Models
const Role = require("../models/role.model");
const User = require("../models/user.model");

/**
 * Ensures default system roles exist.
 * Creates only missing default roles and leaves existing roles unchanged.
 */
const initRoles = async () => {
  try {
    const owner = await User.findOne({ role: "owner" });

    if (!owner) {
      console.error("Owner not found. Cannot create default roles.");
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
      console.log(`✓ ${result.upsertedCount} ta default rol yaratildi`);
    }
  } catch (error) {
    console.error("Error creating default roles:", error.message);
  }
};

module.exports = initRoles;
