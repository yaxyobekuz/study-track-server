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
    // Ish jadvali — davomat tizimi uchun
    workStartTime: {
      type: String,
      default: null,
      match: [
        /^([01]\d|2[0-3]):[0-5]\d$/,
        "Ish boshlanish vaqti HH:MM formatida bo'lishi kerak",
      ],
    },
    workEndTime: {
      type: String,
      default: null,
      match: [
        /^([01]\d|2[0-3]):[0-5]\d$/,
        "Ish tugash vaqti HH:MM formatida bo'lishi kerak",
      ],
    },
    // 0=Yakshanba, 1=Dushanba, ..., 6=Shanba
    workDays: {
      type: [Number],
      default: [1, 2, 3, 4, 5],
      validate: {
        validator: (arr) => arr.every((d) => d >= 0 && d <= 6),
        message: "Ish kunlari 0-6 orasida bo'lishi kerak",
      },
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
