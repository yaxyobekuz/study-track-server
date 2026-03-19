const mongoose = require("mongoose");

const attachmentSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ["image", "video", "document"],
      required: true,
    },
    originalName: {
      type: String,
      required: true,
    },
  },
  { _id: false },
);

const penaltyNotificationQueueSchema = new mongoose.Schema(
  {
    penaltyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Penalty",
      required: true,
    },
    telegramId: {
      type: String,
      required: true,
      trim: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    messageText: {
      type: String,
      required: true,
    },
    attachments: [attachmentSchema],
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
    },
    priority: {
      type: Number,
      default: 0,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    maxAttempts: {
      type: Number,
      default: 3,
    },
    errorMessage: {
      type: String,
    },
    processedAt: {
      type: Date,
    },
  },
  { timestamps: true },
);

penaltyNotificationQueueSchema.index({
  status: 1,
  priority: -1,
  createdAt: 1,
});
penaltyNotificationQueueSchema.index({ penaltyId: 1 });

module.exports = mongoose.model(
  "PenaltyNotificationQueue",
  penaltyNotificationQueueSchema,
);
