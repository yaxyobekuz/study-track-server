const mongoose = require("mongoose");

const fineReductionPackageSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Sarlavha majburiy"],
      trim: true,
      maxlength: [200, "Sarlavha maksimal 200 ta belgidan iborat bo'lishi kerak"],
    },
    points: {
      type: Number,
      required: [true, "Ball majburiy"],
      min: [1, "Ball kamida 1 bo'lishi kerak"],
    },
    coinCost: {
      type: Number,
      required: [true, "Narx majburiy"],
      min: [1, "Narx kamida 1 tanga bo'lishi kerak"],
    },
    order: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

fineReductionPackageSchema.index({ isActive: 1, order: 1 });

module.exports = mongoose.model("FineReductionPackage", fineReductionPackageSchema);
