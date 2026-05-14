const mongoose = require("mongoose");

const studentAttendanceSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "O'quvchi majburiy"],
    },
    class: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
      required: [true, "Sinf majburiy"],
    },
    date: {
      type: Date,
      required: [true, "Sana majburiy"],
    },
    status: {
      type: String,
      enum: ["present", "late", "absent", "excused"],
      default: "absent",
    },
    markedAt: {
      type: Date,
      default: null,
    },
    excuseReason: {
      type: String,
      maxlength: [300, "Sabab matni 300 ta belgidan oshmasligi kerak"],
      default: null,
      trim: true,
    },
    autoMarked: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    lastModifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

studentAttendanceSchema.index({ student: 1, date: 1 }, { unique: true });
studentAttendanceSchema.index({ class: 1, date: 1 });
studentAttendanceSchema.index({ date: 1, status: 1 });
studentAttendanceSchema.index({ student: 1, createdAt: -1 });

module.exports = mongoose.model("StudentAttendance", studentAttendanceSchema);
