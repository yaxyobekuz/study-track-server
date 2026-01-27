// Mongoose
const mongoose = require("mongoose");

const messageQueueSchema = new mongoose.Schema(
  {
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
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
    filePath: {
      type: String,
    },
    fileType: {
      type: String,
      enum: ["photo", "document", null],
    },
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
  { timestamps: true }
);

// Indexes for better query performance
messageQueueSchema.index({ status: 1, priority: -1, createdAt: 1 });
messageQueueSchema.index({ messageId: 1 });

module.exports = mongoose.model("MessageQueue", messageQueueSchema);
