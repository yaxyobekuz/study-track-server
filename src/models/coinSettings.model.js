const mongoose = require("mongoose");

const coinSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "singleton" },
    dailyCoinPercentage: {
      type: Number,
      default: 60,
      min: [0, "Foiz 0 dan kam bo'lishi mumkin emas"],
      max: [100, "Foiz 100 dan ko'p bo'lishi mumkin emas"],
    },
    schoolRankBonus: {
      type: Number,
      default: 100,
      min: [0, "Bonus manfiy bo'lishi mumkin emas"],
    },
    classRankBonus: {
      type: Number,
      default: 20,
      min: [0, "Bonus manfiy bo'lishi mumkin emas"],
    },
    minDailyGradeForCoin: {
      type: Number,
      default: 10,
      min: [0, "Minimal ball manfiy bo'lishi mumkin emas"],
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

coinSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findById("singleton");
  if (!settings) {
    settings = await this.create({ _id: "singleton" });
  }
  return settings;
};

module.exports = mongoose.model("CoinSettings", coinSettingsSchema);
