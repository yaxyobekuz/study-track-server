const mongoose = require("mongoose");

const leadSourceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Manba nomi majburiy"],
      unique: true,
      trim: true,
      maxlength: [100, "Manba nomi maksimal 100 ta belgidan iborat bo'lishi kerak"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, "Izoh maksimal 500 ta belgidan iborat bo'lishi kerak"],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("LeadSource", leadSourceSchema);
