const mongoose = require("mongoose");

const locationSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracy: { type: Number, default: 0 },
  },
  { _id: false }
);

const attendanceSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Foydalanuvchi majburiy"],
    },
    date: {
      type: Date,
      required: [true, "Sana majburiy"],
    },
    checkIn: {
      type: Date,
      default: null,
    },
    checkOut: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["present", "late", "absent", "excused"],
      default: "present",
    },
    isLate: {
      type: Boolean,
      default: false,
    },
    lateMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },
    isEarlyOut: {
      type: Boolean,
      default: false,
    },
    earlyOutMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },
    checkInLocation: {
      type: locationSchema,
      default: null,
    },
    checkOutLocation: {
      type: locationSchema,
      default: null,
    },
    // Ofis hududidan tashqarida lekin check-in o'tgan (ogohlantirish)
    locationWarning: {
      type: Boolean,
      default: false,
    },
    // Aniq ofisdan tashqarida ekanligi aniqlangan
    outOfOffice: {
      type: Boolean,
      default: false,
    },
    penaltyApplied: {
      type: Boolean,
      default: false,
    },
    penaltyRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Penalty",
      default: null,
    },
    // Cron job tomonidan avtomatik yaratilgan
    autoMarked: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

attendanceSchema.index({ user: 1, date: 1 }, { unique: true });
attendanceSchema.index({ date: 1, status: 1 });
attendanceSchema.index({ status: 1, createdAt: -1 });
attendanceSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("Attendance", attendanceSchema);
