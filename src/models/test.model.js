// Mongoose
const mongoose = require("mongoose");

/**
 * Test - sof "savol konteyneri" (V3).
 * Mavsum/fan/sinflar/status/reopenGrants - bularning hammasi TestBinding'ga ko'chdi.
 * Test endi mustaqil: o'qituvchi istalgan vaqt yaratib savol qo'shadi, keyin
 * alohida biriktirish jarayonida (TestBinding) mavsum + fan + sinflarga ulanadi.
 */
const testSchema = new mongoose.Schema(
  {
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "O'qituvchi majburiy"],
    },
    title: {
      type: String,
      required: [true, "Test nomi majburiy"],
      trim: true,
      maxlength: [256, "Nom maksimal 256 ta belgidan iborat bo'lishi kerak"],
    },
    questionCount: {
      type: Number,
      required: [true, "Savollar soni majburiy"],
      min: [1, "Savollar soni kamida 1 bo'lishi kerak"],
      default: 30,
    },
    timeLimitMinutes: {
      type: Number,
      required: [true, "Test vaqti majburiy"],
      min: [1, "Test vaqti kamida 1 daqiqa bo'lishi kerak"],
      default: 30,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

testSchema.index({ teacher: 1, isActive: 1 });
testSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Test", testSchema);
