const mongoose = require("mongoose");

const penaltySettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "singleton" },
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
 * Singleton sozlamalarni olish yoki yaratish
 * @returns {Promise<Document>} PenaltySettings hujjati
 */
penaltySettingsSchema.statics.getSettings = async function () {
  let settings = await this.findById("singleton");
  if (!settings) {
    settings = await this.create({ _id: "singleton" });
  }
  return settings;
};

module.exports = mongoose.model("PenaltySettings", penaltySettingsSchema);
