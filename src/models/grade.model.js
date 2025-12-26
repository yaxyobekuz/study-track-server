// Mongoose
const mongoose = require("mongoose");

const gradeSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "O'quvchi majburiy"],
    },
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: [true, "Fan majburiy"],
    },
    class: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
      required: [true, "Sinf majburiy"],
    },
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "O'qituvchi majburiy"],
    },
    grade: {
      type: Number,
      required: [true, "Baho majburiy"],
      min: 2,
      max: 5,
    },
    comment: {
      type: String,
      trim: true,
      maxlength: [512, "Izoh maksimal 512 ta belgidan iborat bo'lishi kerak"],
    },
    date: {
      type: Date,
      required: [true, "Sana majburiy"],
    },
    isEdited: {
      type: Boolean,
      default: false,
    },
    editHistory: [
      {
        previousGrade: Number,
        editedAt: Date,
        editedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
      },
    ],
  },
  { timestamps: true }
);

gradeSchema.index({ student: 1, subject: 1, date: 1 });
gradeSchema.index({ class: 1, date: 1 });
gradeSchema.index({ teacher: 1, date: 1 });

module.exports = mongoose.model("Grade", gradeSchema);
