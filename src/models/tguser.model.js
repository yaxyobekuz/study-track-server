// Mongoose
const mongoose = require("mongoose");

const tgUserSchema = new mongoose.Schema(
  {
    telegramId: {
      type: String,
      required: [true, "Telegram ID majburiy"],
      unique: true,
      trim: true,
    },
    chatId: {
      type: String,
      required: [true, "Chat ID majburiy"],
      trim: true,
    },
    // Link to student user model
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "O'quvchi majburiy"],
    },
    // Parent information
    firstName: {
      type: String,
      trim: true,
    },
    lastName: {
      type: String,
      trim: true,
    },
    username: {
      type: String,
      trim: true,
    },
    // Message sending settings
    notificationsEnabled: {
      type: Boolean,
      default: true,
    },
    // Last activity
    lastActivity: {
      type: Date,
      default: Date.now,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

// Indexlar
tgUserSchema.index({ student: 1 });
tgUserSchema.index({ telegramId: 1 });
tgUserSchema.index({ notificationsEnabled: 1, isActive: 1 });

module.exports = mongoose.model("TgUser", tgUserSchema);
