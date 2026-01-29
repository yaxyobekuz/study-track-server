// Mongoose
const mongoose = require("mongoose");

const topicSchema = new mongoose.Schema(
  {
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: [true, "Fan majburiy"],
    },
    order: {
      type: Number,
      required: [true, "Tartib raqami majburiy"],
      min: [1, "Tartib raqami kamida 1 bo'lishi kerak"],
    },
    name: {
      type: String,
      required: [true, "Mavzu nomi majburiy"],
      maxlength: [256, "Mavzu nomi maksimal 256 ta belgidan iborat bo'lishi kerak"],
      trim: true,
    },
    description: {
      type: String,
      maxlength: [1024, "Tavsif maksimal 1024 ta belgidan iborat bo'lishi kerak"],
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// Unique compound index: one topic order per subject
topicSchema.index({ subject: 1, order: 1 }, { unique: true });

// Index for fast lookup by subject
topicSchema.index({ subject: 1 });

module.exports = mongoose.model("Topic", topicSchema);
