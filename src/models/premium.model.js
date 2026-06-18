const mongoose = require("mongoose");

const premiumSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    durationDays: {
      type: Number,
      required: true,
      default: 30,
    },
    coinCost: {
      type: Number,
      required: true,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "expired", "revoked"],
      default: "active",
      index: true,
    },
    coinBalanceAfter: {
      type: Number,
      required: true,
    },
    // Obuna manbasi: o'quvchi sotib oldimi yoki admin qo'lda berdimi
    source: {
      type: String,
      enum: ["purchase", "admin_grant"],
      default: "purchase",
      index: true,
    },
    // Admin qo'lda bergan/bekor qilgan bo'lsa, kim qilgani
    grantedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

premiumSchema.index({ student: 1, status: 1 });
premiumSchema.index({ endDate: 1, status: 1 });

module.exports = mongoose.model("Premium", premiumSchema);
