const mongoose = require("mongoose");

const penaltyCategorySchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Sarlavha majburiy"],
      trim: true,
      maxlength: [200, "Sarlavha maksimal 200 ta belgidan iborat bo'lishi kerak"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, "Izoh maksimal 500 ta belgidan iborat bo'lishi kerak"],
    },
    points: {
      type: Number,
      required: [true, "Ball majburiy"],
      min: [1, "Ball kamida 1 bo'lishi kerak"],
    },
    targetRole: {
      type: String,
      required: [true, "Maqsadli rol majburiy"],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

penaltyCategorySchema.index({ targetRole: 1, isActive: 1 });

module.exports = mongoose.model("PenaltyCategory", penaltyCategorySchema);
