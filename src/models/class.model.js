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
    grade: {
      type: Number,
      required: [true, "Sinf darajasi majburiy"],
      min: 1,
      max: 11,
    },
    section: {
      type: String,
      required: [true, "Sinf bo'limi majburiy"],
      trim: true,
      uppercase: true,
      maxlength: [
        1,
        "Sinf bo'limi maksimal 1 ta belgidan iborat bo'lishi kerak",
      ],
    },
    academicYear: {
      type: String,
      required: true,
      trim: true,
      maxlength: [
        9,
        "Akademik yil maksimal 9 ta belgidan iborat bo'lishi kerak",
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
