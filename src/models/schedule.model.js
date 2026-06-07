// Mongoose
const mongoose = require("mongoose");

const scheduleSchema = new mongoose.Schema(
  {
    class: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
      required: [true, "Sinf majburiy"],
    },
    day: {
      type: String,
      required: [true, "Kun majburiy"],
      enum: [
        "dushanba",
        "seshanba",
        "chorshanba",
        "payshanba",
        "juma",
        "shanba",
      ],
    },
    subjects: [
      {
        subject: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Subject",
          required: true,
        },
        teacher: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        order: {
          type: Number,
          required: true,
          min: [1, "Dars tartibi kamida 1 bo'lishi kerak"],
          max: [100, "Dars tartibi 100 dan katta bo'lishi mumkin emas"],
        },
        startTime: {
          type: String,
          required: false,
          match: [/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/, "Vaqt formati noto'g'ri (HH:mm)"],
        },
        endTime: {
          type: String,
          required: false,
          match: [/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/, "Vaqt formati noto'g'ri (HH:mm)"],
        },
      },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

scheduleSchema.index({ class: 1, day: 1 }, { unique: true });

// Validate lesson times (only if times are provided)
scheduleSchema.methods.validateLessonTimes = function() {
  // Only validate if at least one lesson has times
  const hasAnyTimes = this.subjects.some(lesson => lesson.startTime || lesson.endTime);

  if (!hasAnyTimes) {
    return; // Skip validation if no times are set
  }

  for (const lesson of this.subjects) {
    // Skip lessons without times
    if (!lesson.startTime && !lesson.endTime) {
      continue;
    }

    // If one time is set, both must be set
    if ((lesson.startTime && !lesson.endTime) || (!lesson.startTime && lesson.endTime)) {
      throw new Error(`${lesson.order}-dars: boshlanish va tugash vaqti ikkalasi ham kiritilishi kerak`);
    }

    // Validate startTime < endTime
    if (lesson.startTime >= lesson.endTime) {
      throw new Error(`${lesson.order}-dars: boshlanish vaqti tugash vaqtidan kichik bo'lishi kerak`);
    }
  }

  // Check for overlapping times (only for lessons with times)
  const lessonsWithTimes = this.subjects.filter(l => l.startTime && l.endTime);
  const sorted = [...lessonsWithTimes].sort((a, b) => a.startTime.localeCompare(b.startTime));

  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].endTime > sorted[i + 1].startTime) {
      throw new Error(`Darslar vaqtlari to'qnashib ketdi: ${sorted[i].order}-dars va ${sorted[i + 1].order}-dars`);
    }
  }
};

// Pre-save hook to validate times
scheduleSchema.pre('save', function(next) {
  try {
    this.validateLessonTimes();
    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model("Schedule", scheduleSchema);
