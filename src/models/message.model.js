// Mongoose
const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    messageText: {
      type: String,
      required: [true, "Xabar matni majburiy"],
      trim: true,
      maxlength: [2048, "Xabar matni maksimal 2048 ta belgidan iborat bo'lishi kerak"],
    },
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    recipientType: {
      type: String,
      enum: ["all", "class", "student", "season"],
      required: [true, "Qabul qiluvchi turi majburiy"],
    },
    recipientIds: [
      {
        type: String,
        trim: true,
      },
    ],
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
    },
    // recipientType "season" uchun - qaysi mavsum e'loni
    season: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TestSeason",
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    totalRecipients: {
      type: Number,
      default: 0,
    },
    deliveryStatus: [
      {
        telegramId: {
          type: String,
          required: true,
        },
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        status: {
          type: String,
          enum: ["pending", "sent", "failed", "cancelled"],
          default: "pending",
        },
        errorMessage: {
          type: String,
        },
        sentAt: {
          type: Date,
        },
      },
    ],
  },
  { timestamps: true }
);

// Indexes for better query performance
messageSchema.index({ sentBy: 1, createdAt: -1 });
messageSchema.index({ classId: 1, createdAt: -1 });
messageSchema.index({ recipientType: 1, createdAt: -1 });

module.exports = mongoose.model("Message", messageSchema);
