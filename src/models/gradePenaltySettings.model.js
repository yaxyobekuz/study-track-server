const mongoose = require("mongoose");

const gradePenaltySettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "singleton" },
    isEnabled: {
      type: Boolean,
      default: true,
    },
    penaltyPoints: {
      type: Number,
      default: 1,
      min: [1, "Jarima bali kamida 1 bo'lishi kerak"],
    },
    missingThresholdPercent: {
      type: Number,
      default: 40,
      min: [0, "Foiz 0 dan kam bo'lishi mumkin emas"],
      max: [100, "Foiz 100 dan oshmasligi kerak"],
    },
    exemptTeachers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

gradePenaltySettingsSchema.statics.getSettings = async function () {
  let settings = await this.findById("singleton");
  if (!settings) {
    settings = await this.create({ _id: "singleton" });
  }
  return settings;
};

module.exports = mongoose.model("GradePenaltySettings", gradePenaltySettingsSchema);
