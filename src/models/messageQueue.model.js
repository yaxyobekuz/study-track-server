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
    fileName: {
      type: String,
    },
    fileContentType: {
      type: String,
    },
    fileType: {
      type: String,
      enum: ["photo", "document", null],
    },
    // Telegram inline klaviatura (reply_markup) - masalan WebApp tugmasi
    replyMarkup: {
      type: mongoose.Schema.Types.Mixed,
    },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "cancelled"],
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
