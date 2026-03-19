const mongoose = require("mongoose");

const monitorSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, "Monitor kodi majburiy"],
      unique: true,
      match: [/^\d{6}$/, "Monitor kodi 6 xonali raqam bo'lishi kerak"],
    },
    name: {
      type: String,
      trim: true,
      maxlength: [128, "Nom maksimal 128 ta belgidan iborat bo'lishi kerak"],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Monitor", monitorSchema);
