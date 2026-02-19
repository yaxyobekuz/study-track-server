const mongoose = require("mongoose");

const coinTransactionSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "O'quvchi majburiy"],
      index: true,
    },
    amount: {
      type: Number,
      required: [true, "Miqdor majburiy"],
      min: [0, "Miqdor manfiy bo'lishi mumkin emas"],
    },
    type: {
      type: String,
      enum: ["daily", "weekly_school_bonus", "weekly_class_bonus"],
      required: [true, "Tur majburiy"],
      index: true,
    },
    description: {
      type: String,
      required: [true, "Tavsif majburiy"],
      maxlength: [512, "Tavsif maksimal 512 ta belgidan iborat bo'lishi kerak"],
    },
    balanceAfter: {
      type: Number,
      required: true,
      min: 0,
    },
    meta: {
      dailyGradeSum: Number,
      coinPercentage: Number,
      weekNumber: Number,
      year: Number,
      classId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Class",
      },
      className: String,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

coinTransactionSchema.index({ student: 1, date: -1 });
coinTransactionSchema.index({ student: 1, type: 1, date: -1 });
coinTransactionSchema.index({ date: -1, type: 1 });

module.exports = mongoose.model("CoinTransaction", coinTransactionSchema);
