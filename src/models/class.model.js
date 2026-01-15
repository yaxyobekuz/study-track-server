// Mongoose
const mongoose = require("mongoose");

const classSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Sinf nomi majburiy"],
      trim: true,
      unique: true,
      maxlength: [
        32,
        "Sinf nomi maksimal 32 ta belgidan iborat bo'lishi kerak",
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

module.exports = mongoose.model("Class", classSchema);
