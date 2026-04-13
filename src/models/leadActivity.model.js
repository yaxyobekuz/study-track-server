const mongoose = require("mongoose");

const LEAD_ACTIVITY_TYPES = ["call", "meeting", "note", "status_change", "visit"];

const leadActivitySchema = new mongoose.Schema(
  {
    lead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      required: [true, "Lead majburiy"],
    },
    type: {
      type: String,
      enum: LEAD_ACTIVITY_TYPES,
      required: [true, "Harakat turi majburiy"],
    },
    description: {
      type: String,
      required: [true, "Izoh majburiy"],
      trim: true,
      maxlength: [2000, "Izoh maksimal 2000 ta belgidan iborat bo'lishi kerak"],
    },
    previousStatus: {
      type: String,
      default: null,
    },
    newStatus: {
      type: String,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

leadActivitySchema.index({ lead: 1, createdAt: -1 });

module.exports = mongoose.model("LeadActivity", leadActivitySchema);
module.exports.LEAD_ACTIVITY_TYPES = LEAD_ACTIVITY_TYPES;
