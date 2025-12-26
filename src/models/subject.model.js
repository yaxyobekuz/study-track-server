// Mongoose
const mongoose = require("mongoose");

const subjectSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Fan nomi majburiy"],
      maxlength: [32, "Fan nomi maksimal 32 ta belgidan iborat bo'lishi kerak"],
      trim: true,
      unique: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [
        512,
        "Fan tavsifi maksimal 512 ta belgidan iborat bo'lishi kerak",
      ],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Subject", subjectSchema);
