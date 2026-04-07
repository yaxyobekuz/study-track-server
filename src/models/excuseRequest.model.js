const mongoose = require("mongoose");

const attachmentSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ["image", "video", "document"],
      required: true,
    },
    originalName: { type: String, required: true, trim: true, maxlength: 255 },
    sizeBytes: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const excuseRequestSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Foydalanuvchi majburiy"],
    },
    date: {
      type: Date,
      required: [true, "Sana majburiy"],
    },
    reason: {
      type: String,
      required: [true, "Sabab majburiy"],
      trim: true,
      maxlength: [500, "Sabab maksimal 500 ta belgidan iborat bo'lishi kerak"],
    },
    // advance = oldindan so'rov, after = kelmaganidan keyin so'rov
    type: {
      type: String,
      enum: ["advance", "after"],
      required: [true, "So'rov turi majburiy"],
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [300, "Rad sababi maksimal 300 ta belgidan iborat bo'lishi kerak"],
      default: null,
    },
    attachments: {
      type: [attachmentSchema],
      default: [],
    },
  },
  { timestamps: true }
);

excuseRequestSchema.index({ user: 1, date: 1 });
excuseRequestSchema.index({ status: 1, createdAt: -1 });
excuseRequestSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("ExcuseRequest", excuseRequestSchema);
