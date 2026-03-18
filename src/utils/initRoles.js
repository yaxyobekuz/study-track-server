// Models
const Role = require("../models/role.model");
const User = require("../models/user.model");

/**
 * Initializes default system roles if none exist.
 * Creates owner, teacher, and student roles as system roles.
 */
const initRoles = async () => {
  try {
    const rolesCount = await Role.countDocuments();

    if (rolesCount > 0) return;

    console.log("Roles not found. Creating default roles...");

    const owner = await User.findOne({ role: "owner" });

    if (!owner) {
      console.error("Owner not found. Cannot create default roles.");
      return;
    }

    const defaultRoles = [
      { name: "Ega", value: "owner", isSystem: true, createdBy: owner._id },
      {
        name: "O'qituvchi",
        value: "teacher",
        isSystem: true,
        createdBy: owner._id,
      },
      {
        name: "O'quvchi",
        value: "student",
        isSystem: true,
        createdBy: owner._id,
      },
      {
        name: "Dasturchi",
        value: "developer",
        isSystem: true,
        createdBy: owner._id,
      },
    ];

    await Role.insertMany(defaultRoles);
    console.log("✓ Default roles created successfully");
  } catch (error) {
    console.error("Error creating default roles:", error.message);
  }
};

module.exports = initRoles;
