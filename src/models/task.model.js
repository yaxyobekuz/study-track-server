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

const statusHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: [
        "pending",
        "extended",
        "pending_rejected",
        "stopped",
        "completed",
        "pending_review",
      ],
      required: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: [1024, "Sabab maksimal 1024 ta belgidan iborat bo'lishi kerak"],
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false },
);

const deadlineHistorySchema = new mongoose.Schema(
  {
    oldDueDate: {
      type: Date,
      required: true,
    },
    newDueDate: {
      type: Date,
      required: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: [1024, "Sabab maksimal 1024 ta belgidan iborat bo'lishi kerak"],
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
    withPenalty: {
      type: Boolean,
      default: false,
    },
    penaltyPoints: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: false },
);

const taskSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Sarlavha majburiy"],
      trim: true,
      maxlength: [300, "Sarlavha maksimal 300 ta belgidan iborat bo'lishi kerak"],
    },
    description: {
      type: String,
      required: [true, "Tavsif majburiy"],
      trim: true,
      maxlength: [1024, "Tavsif maksimal 1024 ta belgidan iborat bo'lishi kerak"],
    },
    assignee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Ijrochi majburiy"],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Yaratuvchi majburiy"],
    },
    status: {
      type: String,
      enum: [
        "pending",
        "extended",
        "pending_rejected",
        "stopped",
        "completed",
        "pending_review",
      ],
      default: "pending",
    },
    dueDate: {
      type: Date,
      required: [true, "Ijro muddati majburiy"],
    },
    penaltyPoints: {
      type: Number,
      required: [true, "Jarima bali majburiy"],
      min: [1, "Jarima bali kamida 1 bo'lishi kerak"],
      default: 1,
    },
    attachments: [attachmentSchema],
    completionNote: {
      type: String,
      trim: true,
      maxlength: [1000, "Izoh maksimal 1000 ta belgidan iborat bo'lishi kerak"],
    },
    completionAttachments: [attachmentSchema],
    statusHistory: [statusHistorySchema],
    deadlineHistory: [deadlineHistorySchema],
    penaltyRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Penalty",
      default: null,
    },
    autopenalized: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

taskSchema.index({ assignee: 1, status: 1 });
taskSchema.index({ assignee: 1, createdAt: -1 });
taskSchema.index({ createdBy: 1, createdAt: -1 });
taskSchema.index({ status: 1, dueDate: 1 });
taskSchema.index({ dueDate: 1, autopenalized: 1, status: 1 });

module.exports = mongoose.model("Task", taskSchema);
