const mongoose = require("mongoose");

const leadDirectionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Yo'nalish nomi majburiy"],
      unique: true,
      trim: true,
      maxlength: [100, "Yo'nalish nomi maksimal 100 ta belgidan iborat bo'lishi kerak"],
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

module.exports = mongoose.model("LeadDirection", leadDirectionSchema);
