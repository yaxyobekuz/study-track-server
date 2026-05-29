// Mongoose
const mongoose = require("mongoose");

/**
 * TestBinding — testni mavsum + fan + sinflarga biriktirish (V3).
 * Bir test ko'p biriktirishga ega bo'lishi mumkin (har yili qayta ishlatish,
 * turli sinflar uchun ishlatish, va h.k.).
 *
 * O'quvchilar testni biriktirish orqali topshiradilar.
 * Status (draft/published/closed) va reopenGrants endi biriktirish darajasida.
 */
const testBindingSchema = new mongoose.Schema(
  {
    test: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Test",
      required: [true, "Test majburiy"],
    },
    // test.teacher bilan bir xil (tezroq query uchun denormalizatsiya)
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "O'qituvchi majburiy"],
    },
    season: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TestSeason",
      required: [true, "Mavsum majburiy"],
    },
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: [true, "Fan majburiy"],
    },
    classes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Class",
      },
    ],
    // Biriktirish holati: 'draft' - tayyorlanmoqda, 'published' - e'lon qilingan, 'closed' - yopilgan
    status: {
      type: String,
      enum: ["draft", "published", "closed"],
      default: "draft",
    },
    // Qayta urinish ruxsatlari - har biri bitta qo'shimcha urinishga yo'l ochadi
    reopenGrants: [
      {
        student: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        grantedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        grantedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

testBindingSchema.index({ test: 1 });
testBindingSchema.index({ season: 1, subject: 1 });
testBindingSchema.index({ classes: 1 });
testBindingSchema.index({ teacher: 1, season: 1 });
testBindingSchema.index({ status: 1 });

module.exports = mongoose.model("TestBinding", testBindingSchema);
