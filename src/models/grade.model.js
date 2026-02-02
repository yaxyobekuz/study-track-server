// Mongoose
const mongoose = require("mongoose");

// Services
const {
  updateWeeklyStatsForGrade,
} = require("../services/weeklystats.service");

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
    lessonOrder: {
      type: Number,
      min: 1,
      default: 1,
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
  { timestamps: true },
);

gradeSchema.index({ student: 1, subject: 1, date: 1, lessonOrder: 1 });
gradeSchema.index({ class: 1, date: 1 });
gradeSchema.index({ teacher: 1, date: 1 });

// POST-SAVE HOOK: Update WeeklyStats when grade is created/updated
gradeSchema.post("save", async function (doc) {
  try {
    await updateWeeklyStatsForGrade(doc);
  } catch (error) {
    console.error("Error updating WeeklyStats after grade save:", error);
  }
});

module.exports = mongoose.model("Grade", gradeSchema);
