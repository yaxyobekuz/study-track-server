const mongoose = require("mongoose");

const penaltySettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "singleton" },
    fineAmounts: {
      type: Map,
      of: Number,
      default: new Map(),
    },
    studentFineAmount: {
      type: Number,
      default: 2100000,
      min: [0, "Jarima miqdori manfiy bo'lishi mumkin emas"],
    },
    teacherFineAmount: {
      type: Number,
      default: 2100000,
      min: [0, "Jarima miqdori manfiy bo'lishi mumkin emas"],
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

/**
 * Singleton sozlamalarni olish yoki yaratish.
 * Agar fineAmounts bo'sh bo'lsa, eski maydonlardan lazy migration qiladi.
 * @returns {Promise<Document>} PenaltySettings hujjati
 */
penaltySettingsSchema.statics.getSettings = async function () {
  let settings = await this.findById("singleton");
  if (!settings) {
    settings = await this.create({ _id: "singleton" });
  }

  // Lazy migration: eski studentFineAmount/teacherFineAmount -> fineAmounts
  if (settings.fineAmounts.size === 0) {
    if (settings.studentFineAmount > 0) {
      settings.fineAmounts.set("student", settings.studentFineAmount);
    }
    if (settings.teacherFineAmount > 0) {
      settings.fineAmounts.set("teacher", settings.teacherFineAmount);
    }
    if (settings.fineAmounts.size > 0) {
      await settings.save();
    }
  }

  return settings;
};

module.exports = mongoose.model("PenaltySettings", penaltySettingsSchema);
