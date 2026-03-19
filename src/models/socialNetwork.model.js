// Mongoose
const mongoose = require("mongoose");

const socialNetworkSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      enum: ["telegram"],
      required: [true, "Platforma turi majburiy"],
      default: "telegram",
    },
    name: {
      type: String,
      required: [true, "Nom majburiy"],
      trim: true,
      maxlength: [128, "Nom maksimal 128 ta belgidan iborat bo'lishi kerak"],
    },
    chatId: {
      type: String,
      required: [true, "Chat ID majburiy"],
      trim: true,
    },
    username: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

socialNetworkSchema.index({ platform: 1, isActive: 1 });

module.exports = mongoose.model("SocialNetwork", socialNetworkSchema);
