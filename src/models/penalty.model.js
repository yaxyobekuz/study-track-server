const mongoose = require("mongoose");

const attachmentSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ["image", "video", "document"],
      required: true,
    },
    originalName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
    },
    sizeBytes: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false },
);

const penaltySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Foydalanuvchi majburiy"],
    },
    givenBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Jarima yozuvchi majburiy"],
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PenaltyCategory",
      default: null,
    },
    type: {
      type: String,
      enum: ["penalty", "reduction"],
      required: true,
      default: "penalty",
    },
    title: {
      type: String,
      required: false,
      trim: true,
      maxlength: [
        300,
        "Sarlavha maksimal 300 ta belgidan iborat bo'lishi kerak",
      ],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [1000, "Izoh maksimal 1000 ta belgidan iborat bo'lishi kerak"],
    },
    points: {
      type: Number,
      required: [true, "Ball majburiy"],
      min: [1, "Ball kamida 1 bo'lishi kerak"],
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    reviewedAt: {
      type: Date,
    },
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [
        500,
        "Rad etish sababi maksimal 500 ta belgidan iborat bo'lishi kerak",
      ],
    },
    attachments: [attachmentSchema],
    isCustom: {
      type: Boolean,
      default: false,
    },
    fineAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

penaltySchema.index({ user: 1, status: 1 });
penaltySchema.index({ user: 1, createdAt: -1 });
penaltySchema.index({ status: 1, createdAt: -1 });
penaltySchema.index({ givenBy: 1 });
penaltySchema.index({ type: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("Penalty", penaltySchema);
