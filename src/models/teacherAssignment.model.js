// Mongoose
const mongoose = require("mongoose");

const teacherAssignmentSchema = new mongoose.Schema(
  {
    season: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TestSeason",
      required: [true, "Mavsum majburiy"],
    },
    class: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
      required: [true, "Sinf majburiy"],
    },
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: [true, "Fan majburiy"],
    },
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "O'qituvchi majburiy"],
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

// Bir mavsumda bir sinf+fan+o'qituvchi juftligi takrorlanmasligi kerak
teacherAssignmentSchema.index(
  { season: 1, class: 1, subject: 1, teacher: 1 },
  { unique: true },
);
teacherAssignmentSchema.index({ teacher: 1, season: 1 });
teacherAssignmentSchema.index({ season: 1, class: 1, subject: 1 });

module.exports = mongoose.model("TeacherAssignment", teacherAssignmentSchema);
