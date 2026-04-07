const mongoose = require("mongoose");

const attendanceSettingsSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "singleton",
    },
    officeLocation: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    officeRadius: {
      type: Number,
      default: 100,
      min: [10, "Radius kamida 10 metr bo'lishi kerak"],
    },
    lateArrivalPenaltyPoints: {
      type: Number,
      default: 1,
      min: 0,
    },
    lateArrivalGraceMinutes: {
      type: Number,
      default: 10,
      min: 0,
    },
    earlyDeparturePenaltyPoints: {
      type: Number,
      default: 1,
      min: 0,
    },
    earlyDepartureGraceMinutes: {
      type: Number,
      default: 10,
      min: 0,
    },
    absentPenaltyPoints: {
      type: Number,
      default: 2,
      min: 0,
    },
    // Global jarima pauza
    penaltyPaused: {
      type: Boolean,
      default: false,
    },
    // Pauza qilingan rollar (role.value string lari)
    pausedRoles: {
      type: [String],
      default: [],
    },
    // Pauza qilingan alohida foydalanuvchilar
    pausedUsers: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

/**
 * Singleton sozlamalarni qaytaradi, yo'q bo'lsa yaratadi
 * @returns {Promise<Object>} AttendanceSettings hujjati
 */
attendanceSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findById("singleton");
  if (!settings) {
    settings = await this.create({ _id: "singleton" });
  }
  return settings;
};

module.exports = mongoose.model("AttendanceSettings", attendanceSettingsSchema);
