// Models
const User = require("../models/user.model");

const initOwner = async () => {
  try {
    const ownerExists = await User.findOne({ role: "owner" });

    if (!ownerExists) {
      console.log("Owner not found. Creating new owner...");
      const ownerData = {
        username: process.env.DEFAULT_OWNER_USERNAME || "admin",
        password: process.env.DEFAULT_OWNER_PASSWORD || "admin123",
        firstName: process.env.DEFAULT_OWNER_FIRSTNAME || "Administrator",
        lastName: process.env.DEFAULT_OWNER_LASTNAME,
        role: "owner",
        isActive: true,
      };

      await User.create(ownerData);
      console.log("✓ Default owner created successfully");
    }
  } catch (error) {
    console.error("Error creating owner:", error.message);
  }
};

module.exports = initOwner;
