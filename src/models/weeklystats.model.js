const mongoose = require("mongoose");

const weeklyStatsSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    classes: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Class",
      },
    ],
    weekStart: {
      type: Date,
      required: true,
      index: true,
    },
    weekEnd: {
      type: Date,
      required: true,
    },
    weekNumber: {
      type: Number,
      required: true,
      min: 1,
      max: 53,
    },
    year: {
      type: Number,
      required: true,
      index: true,
    },

    // Simple Statistics - Sum based ranking
    simpleStats: {
      subjects: [
        {
          subject: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Subject",
          },
          grades: [Number], // Array of actual grades [5, 4, 5]
          sum: Number, // Sum of all grades for this subject
          count: Number,
          teachers: [String], // ["Alisher Karimov", "Dilshod Azimov"]
        },
      ],
      totalSum: {
        type: Number,
        default: 0,
      },
      totalGrades: {
        type: Number,
        default: 0,
      },
    },

    // Rankings (pre-calculated, based on totalSum)
    rankings: {
      classRanks: [
        {
          class: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Class",
          },
          rank: Number,
          totalStudents: Number,
        },
      ],
      schoolRank: Number,
      schoolTotalStudents: Number,
    },

    // Metadata
    lastUpdated: {
      type: Date,
      default: Date.now,
    },
    isComplete: {
      type: Boolean,
      default: false, // true when week is finished (Saturday end)
    },
  },
  {
    timestamps: true,
  },
);

// Compound indexes for fast queries
weeklyStatsSchema.index(
  { student: 1, year: 1, weekNumber: 1 },
  { unique: true },
);
weeklyStatsSchema.index({ classes: 1, year: 1, weekNumber: 1 });
weeklyStatsSchema.index({ weekStart: 1, weekEnd: 1 });
weeklyStatsSchema.index({ "rankings.classRanks.rank": 1 });
weeklyStatsSchema.index({ "rankings.schoolRank": 1 });

// Static methods
weeklyStatsSchema.statics.findCurrentWeek = function (studentId) {
  const { getCurrentWeekRange } = require("../helpers/statistics.helpers");
  const { weekNumber, year } = getCurrentWeekRange();

  return this.findOne({
    student: studentId,
    year,
    weekNumber,
  }).populate("classes simpleStats.subjects.subject rankings.classRanks.class");
};

weeklyStatsSchema.statics.findByWeek = function (studentId, weekNumber, year) {
  return this.findOne({
    student: studentId,
    year,
    weekNumber,
  }).populate("classes simpleStats.subjects.subject rankings.classRanks.class");
};

module.exports = mongoose.model("WeeklyStats", weeklyStatsSchema);
