const mongoose = require("mongoose");

const absenceReasonSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Sarlavha majburiy"],
      trim: true,
      maxlength: [200, "Sarlavha maksimal 200 ta belgidan iborat bo'lishi kerak"],
    },
    // Ixtiyoriy qo'shimcha izoh
    description: {
      type: String,
      trim: true,
      maxlength: [500, "Izoh maksimal 500 ta belgidan iborat bo'lishi kerak"],
      default: "",
    },
    // Qaysi rollarga mo'ljallangan (rol value'lari). Bo'sh + appliesToAll=false => "belgilanmagan"
    roles: {
      type: [String],
      default: [],
    },
    // Barcha rollarga tegishli
    appliesToAll: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

absenceReasonSchema.index({ isActive: 1 });
absenceReasonSchema.index({ appliesToAll: 1, roles: 1, isActive: 1 });

module.exports = mongoose.model("AbsenceReason", absenceReasonSchema);
