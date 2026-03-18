// Mongoose
const mongoose = require("mongoose");

const roleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Rol nomi majburiy"],
      maxlength: [64, "Rol nomi maksimal 64 ta belgidan iborat bo'lishi kerak"],
      trim: true,
      unique: true,
    },
    value: {
      type: String,
      required: [true, "Rol qiymati majburiy"],
      maxlength: [
        32,
        "Rol qiymati maksimal 32 ta belgidan iborat bo'lishi kerak",
      ],
      trim: true,
      lowercase: true,
      unique: true,
      match: [
        /^[a-z0-9_]+$/,
        "Rol qiymati faqat kichik lotin harflari, raqamlar va pastki chiziqdan iborat bo'lishi kerak",
      ],
    },
    isSystem: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// Indexes
roleSchema.index({ value: 1 }, { unique: true });

module.exports = mongoose.model("Role", roleSchema);
