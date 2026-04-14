const mongoose = require("mongoose");

const emojiConfigSchema = new mongoose.Schema(
  {
    emojiId: {
      type: Number,
      required: true,
      unique: true,
      min: 1,
    },
    // Matches the animation file basename used in the frontend mapping
    key: {
      type: String,
      required: true,
      trim: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmojiConfig", emojiConfigSchema);
